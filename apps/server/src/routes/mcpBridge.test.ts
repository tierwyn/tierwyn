import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express, { type Express } from 'express';
import { TUNNEL_MAX_BODY_BYTES, validateMcpServerInput } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { upsertMcpServer } from '../mcp/registry.js';
import { BRIDGE_HEADER, bridgeServers, type BridgeEntry } from '../mcp/bridge.js';
import { closeAllHubPipes } from '../mcp/hubPipe.js';
import { NODE_HEADER, NODE_SECRET_HEADER, originGuard } from '../node/originGuard.js';
import { registerMcpBridgeRoutes } from './mcpBridge.js';

const SECRET = 'node-secret-for-bridge-tests';
const HOST = 'host-1';

interface Resp { status: number; body: unknown; text: string; headers: Headers; }

describe('mcp bridge route', () => {
  let db: Database.Database;
  let app: Express;
  let server: Server;
  let base = '';
  let key = '';
  let entry: BridgeEntry;
  let captured: Array<{ url: string; init?: RequestInit }> = [];
  let stub: (url: string, init?: RequestInit) => Promise<Response>;
  let respondWith: Response;
  /** Injectable stdio/sse upstream for the pipe branch; undefined → route default. */
  let spawner: ((row: { id: string }) => Transport | Promise<Transport>) | undefined;
  let sseServer: HttpServer;

  const echoTool = {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object' as const, properties: { msg: { type: 'string' as const } } },
  };
  const makeEchoServer = (name: string): Server => {
    const srv = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [echoTool] }));
    srv.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: 'text', text: 'echo:' + ((req.params.arguments ?? {}).msg ?? '') }],
    }));
    return srv;
  };

  beforeAll(async () => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    const hubRow = validateMcpServerInput({
      id: 'hub-one',
      transport: 'http',
      url: 'http://127.0.0.1:9999/mcp',
      headers: [{ key: 'X-Api-Key', value: 'sk-live-123', secret: false }],
    });
    if (!hubRow.ok) throw new Error(hubRow.error);
    upsertMcpServer(db, hubRow.value);
    const off = validateMcpServerInput({ id: 'hub-off', transport: 'http', url: 'http://127.0.0.1:9999/x', enabled: false });
    if (!off.ok) throw new Error(off.error);
    upsertMcpServer(db, off.value);
    // Real in-process SSE MCP upstream so the sse pipe branch can connect for real.
    const sseApp = express();
    sseApp.use(express.json());
    const sseSrv = makeEchoServer('echo-sse');
    let sseTransport: SSEServerTransport | undefined;
    sseApp.get('/sse', (_req: IncomingMessage, res: ServerResponse) => {
      sseTransport = new SSEServerTransport('/messages', res);
      void sseSrv.connect(sseTransport);
    });
    sseApp.post('/messages', (req: IncomingMessage, res: ServerResponse) => {
      void sseTransport?.handlePostMessage(req, res, req.body);
    });
    sseServer = createServer(sseApp);
    await new Promise<void>((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
    const ssePort = (sseServer.address() as AddressInfo).port;
    const sse = validateMcpServerInput({ id: 'hub-sse', transport: 'sse', url: `http://127.0.0.1:${ssePort}/sse` });
    if (!sse.ok) throw new Error(sse.error);
    upsertMcpServer(db, sse.value);
    const stdio = validateMcpServerInput({
      id: 'hub-stdio', transport: 'stdio', command: 'spawned-by-injected-transport', placement: 'hub',
    });
    if (!stdio.ok) throw new Error(stdio.error);
    upsertMcpServer(db, stdio.value);
    const agentPlaced = validateMcpServerInput({
      id: 'agent-placed', transport: 'http', url: 'https://mcp.example.com/mcp', placement: 'agent',
    });
    if (!agentPlaced.ok) throw new Error(agentPlaced.error);
    upsertMcpServer(db, agentPlaced.value);
    const sec = validateMcpServerInput({
      id: 'hub-sec', transport: 'http', url: 'http://127.0.0.1:9999/sec', headers: [{ key: 'X-Token', secret: true }],
    });
    if (!sec.ok) throw new Error(sec.error);
    upsertMcpServer(db, sec.value);

    entry = {
      conversationId: 'c1', sessionId: 's1',
      hostId: HOST, serverIds: ['hub-one', 'hub-off', 'hub-sse', 'hub-stdio', 'hub-sec'],
    };
    key = 'a'.repeat(64);
    // Mint the real key through bridgeServers so route + bridge stay in sync.
    // The entry's serverIds end up as the hub-placed ids, so all four rows the
    // tests probe must be hub-placed here; row-level 403s (disabled/sse/agent)
    // are the route's job, enforced later.
    const hubShape = (id: string, extra: Record<string, unknown> = {}) => ({
      id, transport: 'http' as const, url: `http://127.0.0.1:9999/${id}`,
      args: [], env: {}, headers: {}, secretEnvKeys: [], secretHeaderKeys: [], placement: 'hub' as const, ...extra,
    });
    const bridged = bridgeServers(
      [hubShape('hub-one'), hubShape('hub-off'), hubShape('hub-sse'), hubShape('hub-stdio'), hubShape('hub-sec')],
      entry,
    );
    key = bridged![0]!.headers[BRIDGE_HEADER];

    respondWith = new Response('{"jsonrpc":"2.0","id":1}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-9',
        'content-length': '22',
        location: 'https://elsewhere/mcp',
        'set-cookie': 'sid=1',
      },
    });
    stub = vi.fn((url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return Promise.resolve(respondWith.clone());
    });

    app = express();
    app.use(express.json());
    app.use(originGuard({ db: () => db, nodeSecret: SECRET }));
    // Indirect so tests can swap `stub` / `spawner` between cases.
    registerMcpBridgeRoutes(app, {
      getDb: () => db,
      fetch: (...a) => stub(...a),
      spawnTransport: (row) => spawner?.(row as { id: string }) as Transport | Promise<Transport> | undefined,
    });
    server = createServer(app);
    server.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    sseServer?.close();
    db?.close();
    await closeAllHubPipes();
  });

  const call = async (method: string, serverId: string, opts: {
    host?: string; key?: string; contentType?: string; rawBody?: string; body?: unknown; extra?: Record<string, string>;
  } = {}): Promise<Resp> => {
    const headers: Record<string, string> = {
      'content-type': opts.contentType ?? 'application/json',
      ...(opts.key !== null ? { [BRIDGE_HEADER]: opts.key ?? key } : {}),
      [NODE_HEADER]: opts.host ?? HOST,
      [NODE_SECRET_HEADER]: SECRET,
      ...(opts.extra ?? {}),
    };
    const res = await fetch(`${base}/agent/mcp/${serverId}`, {
      method,
      headers,
      body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* non-json */ }
    return { status: res.status, body, text, headers: res.headers };
  };

  it('no node host header → 404', async () => {
    const res = await fetch(`${base}/agent/mcp/hub-one`, {
      method: 'POST', headers: { 'content-type': 'application/json', [BRIDGE_HEADER]: key, [NODE_SECRET_HEADER]: SECRET },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('GET → 405 with Allow: POST, DELETE; PATCH → 405', async () => {
    const get = await call('GET', 'hub-one');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, DELETE');
    const patch = await call('PATCH', 'hub-one', { body: {} });
    expect(patch.status).toBe(405);
  });

  it('bad key, foreign host, or unknown serverId → 403', async () => {
    expect((await call('POST', 'hub-one', { key: 'b'.repeat(64), body: {} })).status).toBe(403);
    expect((await call('POST', 'hub-one', { host: 'host-2', body: {} })).status).toBe(403);
    expect((await call('POST', 'nope', { body: {} })).status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it('disabled or non-hub rows → 403', async () => {
    let spawns = 0;
    spawner = () => { spawns += 1; throw new Error('must not spawn'); };
    try {
      expect((await call('POST', 'hub-off', { body: {} })).status).toBe(403);
      expect((await call('POST', 'agent-placed', { body: {} })).status).toBe(403);
      // Row gating invariants carry over to pipe-eligible rows too.
      expect((await call('POST', 'hub-stdio', { host: 'host-2', body: {} })).status).toBe(403);
      expect((await call('POST', 'hub-stdio', { key: 'b'.repeat(64), body: {} })).status).toBe(403);
      expect((await call('POST', 'nope', { body: {} })).status).toBe(403);
    } finally {
      spawner = undefined;
    }
    expect(spawns).toBe(0);
  });

  /** SDK client pointed at the bridged route with node + bridge headers attached. */
  const pipeClient = (serverId: string): { client: Client; transport: StreamableHTTPClientTransport } => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/agent/mcp/${serverId}`), {
      requestInit: { headers: { [BRIDGE_HEADER]: key, [NODE_HEADER]: HOST, [NODE_SECRET_HEADER]: SECRET } },
    });
    return { client: new Client({ name: 'bridge-route-test', version: '1.0.0' }), transport };
  };

  it('stdio row with a valid key pipes through an injected upstream transport', async () => {
    spawner = async () => {
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      await makeEchoServer('echo-stdio').connect(serverEnd);
      return clientEnd;
    };
    const { client, transport } = pipeClient('hub-stdio');
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('echo');
      const out = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
      expect(out.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    } finally {
      spawner = undefined;
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }, 20_000);

  it('sse row with a valid key pipes through the row url (default transport)', async () => {
    const { client, transport } = pipeClient('hub-sse');
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('echo');
      const out = await client.callTool({ name: 'echo', arguments: { msg: 'yo' } });
      expect(out.content).toEqual([{ type: 'text', text: 'echo:yo' }]);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }, 20_000);

  it('http GET with the stream marker forwards upstream without the 8 MiB cap', async () => {
    captured = [];
    const prev = respondWith;
    respondWith = new Response(Buffer.alloc(20 * 1024 * 1024, 0x62), { status: 200 });
    const res = await call('GET', 'hub-one', {
      extra: { accept: 'text/event-stream', 'x-tierwyn-tunnel-stream': '1' },
    });
    respondWith = prev;
    expect(res.status).toBe(200);
    expect(res.text.length).toBe(20 * 1024 * 1024);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.init!.method).toBe('GET');
    expect(captured[0]!.init!.body).toBeUndefined();
    // The marker is for the hub's own routing only — never relayed upstream.
    expect((captured[0]!.init!.headers as Record<string, string>)['x-tierwyn-tunnel-stream']).toBeUndefined();
  });

  it('http GET with x-tierwyn-tunnel-stream marker streams', async () => {
    captured = [];
    const prev = respondWith;
    respondWith = new Response(Buffer.alloc(512, 0x63), { status: 200 });
    const res = await call('GET', 'hub-one', {
      extra: { accept: 'text/event-stream', 'x-tierwyn-tunnel-stream': '1' },
    });
    respondWith = prev;
    expect(res.status).toBe(200);
    expect(res.text.length).toBe(512);
  });

  it('http GET without the stream marker keeps the buffered rules (405, 8 MiB cap)', async () => {
    expect((await call('GET', 'hub-one')).status).toBe(405);
    captured = [];
    const prev = respondWith;
    respondWith = new Response(Buffer.alloc(TUNNEL_MAX_BODY_BYTES + 1, 0x61), { status: 200 });
    const res = await call('POST', 'hub-one', {
      body: {},
      extra: { 'x-tierwyn-tunnel-stream': '0' },
    });
    respondWith = prev;
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'response_too_large' });
  });

  it('POST forwards to the row url with allow-listed + row headers, relays status/body/session', async () => {
    captured = [];
    const res = await call('POST', 'hub-one', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      extra: { accept: 'application/json, text/event-stream', 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2025-06-18', 'last-event-id': '7' },
    });
    expect(captured).toHaveLength(1);
    const { url, init } = captured[0]!;
    expect(url).toBe('http://127.0.0.1:9999/mcp');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const sent = init!.headers as Record<string, string>;
    expect(sent['content-type']).toBe('application/json');
    expect(sent['accept']).toBe('application/json, text/event-stream');
    expect(sent['mcp-session-id']).toBe('sess-1');
    expect(sent['mcp-protocol-version']).toBe('2025-06-18');
    expect(sent['last-event-id']).toBe('7');
    expect(sent['x-api-key']).toBe('sk-live-123');
    expect(sent[BRIDGE_HEADER.toLowerCase()]).toBeUndefined();
    expect(sent['x-tierwyn-mcp-key']).toBeUndefined();
    expect(sent['authorization']).toBeUndefined();
    expect(sent['cookie']).toBeUndefined();
    expect(sent[NODE_HEADER]).toBeUndefined();
    expect(sent[NODE_SECRET_HEADER]).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"jsonrpc":"2.0","id":1}');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBe('sess-9');
    // never relay these upstream response headers (content-length: upstream
    // said 22, transport recomputes 24 from the buffered body)
    expect(res.headers.get('content-length')).not.toBe('22');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('DELETE forwards without a body', async () => {
    captured = [];
    const res = await call('DELETE', 'hub-one');
    expect(res.status).toBe(200);
    expect(captured[0]!.init!.method).toBe('DELETE');
    expect(captured[0]!.init!.body).toBeUndefined();
  });

  it('missing secret → 502 secret_missing, no upstream call', async () => {
    captured = [];
    const res = await call('POST', 'hub-sec', { body: {} });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'secret_missing' });
    expect(captured).toHaveLength(0);
  });

  it('oversized upstream response → 502 response_too_large', async () => {
    captured = [];
    const prev = respondWith;
    respondWith = new Response(Buffer.alloc(TUNNEL_MAX_BODY_BYTES + 1, 0x61), { status: 200 });
    const res = await call('POST', 'hub-one', { body: {} });
    respondWith = prev;
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'response_too_large' });
  });

  it('upstream failure → 502 upstream_error without leaking the url', async () => {
    captured = [];
    const prev = stub;
    stub = vi.fn(() => Promise.reject(new Error('boom http://127.0.0.1:9999/mcp')));
    const res = await call('POST', 'hub-one', { body: {} });
    stub = prev;
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_error' });
    expect(res.text).not.toContain('9999');
  });

  it('POST with a non-JSON body → 415', async () => {
    captured = [];
    const res = await call('POST', 'hub-one', { contentType: 'text/plain', rawBody: 'hello' });
    expect(res.status).toBe(415);
    expect(captured).toHaveLength(0);
  });
});
