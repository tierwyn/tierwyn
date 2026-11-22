import { writeFileSync, mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildChildEnv } from '../childEnv.js';
import {
  closeAllHubPipes,
  closeHubPipesForSession,
  getOrCreateHubPipe,
  makeRowTransport,
  peekHubPipe,
} from './hubPipe.js';

const SDK = join(process.cwd(), '..', '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs');

let tmp: string;

/** Minimal stdio MCP server: tools `echo` + `env_dump` (returns the child's env as JSON). */
function writeChildServer(): string {
  tmp = mkdtempSync(join(tmpdir(), 'hubpipe-'));
  const file = join(tmp, 'child.cjs');
  writeFileSync(
    file,
    `
const { Server } = require(${JSON.stringify(join(SDK, 'server', 'index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(join(SDK, 'server', 'stdio.js'))});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(join(SDK, 'types.js'))});
const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
    { name: 'env_dump', description: 'env', inputSchema: { type: 'object', properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') {
    return { content: [{ type: 'text', text: 'echo:' + ((req.params.arguments ?? {}).msg ?? '') }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(process.env) }] };
});
server.connect(new StdioServerTransport());
`,
  );
  return file;
}

const servers: Server[] = [];
const transports: Array<{ close: () => Promise<void>; pid?: number }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const t of transports.splice(0)) await t.close().catch(() => undefined);
});

afterAll(async () => {
  closeAllHubPipes();
});

/** Express app mounting a hub pipe's down transport at POST /mcp (mirrors the bridge route). */
async function startPipeApp(
  sessionId: string,
  serverId: string,
  spawn: () => Promise<{ close: () => Promise<void>; pid?: number }> | { close: () => Promise<void>; pid?: number },
): Promise<string> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.post('/mcp', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const pipe = await getOrCreateHubPipe({ sessionId, serverId }, spawn);
      await pipe.down.handleRequest(req, res, req.body);
    } catch {
      // Express 4 does not catch async handler errors — mirror the bridge route's 502.
      if (!res.headersSent) res.status(502).json({ error: 'upstream_error' });
    }
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/mcp`;
}

async function pipeClient(url: string): Promise<{ client: Client; close: () => void }> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'pipe-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => void transport.close().catch(() => undefined) };
}

describe('hubPipe', { timeout: 30_000 }, () => {
  const childJs = writeChildServer();

  function stdioSpawn(env?: NodeJS.ProcessEnv): () => StdioClientTransport {
    return () => {
      const t = new StdioClientTransport({
        command: process.execPath,
        args: [childJs],
        env: env ?? buildChildEnv(),
      });
      transports.push(t);
      return t;
    };
  }

  it('round-trips initialize, tools/list and tools/call through the pipe', async () => {
    const url = await startPipeApp('s1', 'srv1', stdioSpawn());
    const { client, close } = await pipeClient(url);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('echo');
      const out = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
      expect(out.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    } finally {
      close();
    }
  }, 20_000);

  it('caches one upstream per (sessionId, serverId) and re-spawns per server', async () => {
    let spawns = 0;
    const spawn = (): StdioClientTransport => {
      spawns += 1;
      return stdioSpawn()();
    };
    const url = await startPipeApp('s2', 'srvA', spawn);
    // One pipe carries one downstream MCP session: one client, many calls.
    const a = await pipeClient(url);
    try {
      await a.client.listTools();
      await a.client.listTools();
      expect(spawns).toBe(1);
    } finally {
      a.close();
    }
    const urlB = await startPipeApp('s2', 'srvB', spawn);
    const c = await pipeClient(urlB);
    try {
      await c.client.listTools();
      expect(spawns).toBe(2);
    } finally {
      c.close();
    }
  }, 20_000);

  it('stdio children see buildChildEnv + row env but never SESSION_SECRET', async () => {
    process.env.SESSION_SECRET = 'hub-secret-value';
    try {
      const row = {
        id: 'envd',
        transport: 'stdio' as const,
        command: process.execPath,
        args: [childJs],
        env: [{ key: 'PIPE_MARKER', secret: false, value: 'keep-me' }],
      };
      const url = await startPipeApp('s3', 'srv1', () => makeRowTransport(row));
      const { client, close } = await pipeClient(url);
      try {
        const out = await client.callTool({ name: 'env_dump', arguments: {} });
        const env = JSON.parse((out.content as Array<{ text: string }>)[0]!.text) as Record<string, string>;
        expect(env.SESSION_SECRET).toBeUndefined();
        expect(env.PIPE_MARKER).toBe('keep-me');
        expect(env.TIERWYN_DB).toBeUndefined();
      } finally {
        close();
      }
    } finally {
      delete process.env.SESSION_SECRET;
    }
  }, 20_000);

  it('closeHubPipesForSession kills the stdio child', async () => {
    const url = await startPipeApp('s4', 'srv1', stdioSpawn());
    const { client, close } = await pipeClient(url);
    try {
      await client.listTools();
    } finally {
      close();
    }
    const pid = peekHubPipe({ sessionId: 's4', serverId: 'srv1' })?.upstreamPid ?? -1;
    expect(pid).toBeGreaterThan(0);
    closeHubPipesForSession('s4');
    const deadline = Date.now() + 5000;
    let dead = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
        break;
      }
    }
    expect(dead).toBe(true);
  }, 20_000);

  it('revoke during upstream.start tears the pipe down and does not cache it', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((r) => { resume = r; });
    const spawn = () => ({
      async start() { await gate; },
      async close() {},
      async send() {},
    });
    const creating = getOrCreateHubPipe({ sessionId: 's-race', serverId: 'a' }, spawn as never);
    await new Promise((r) => setImmediate(r));
    await closeHubPipesForSession('s-race');
    resume();
    await expect(creating).rejects.toThrow('session_revoked');
    expect(peekHubPipe({ sessionId: 's-race', serverId: 'a' })).toBeUndefined();
  });

  it('a failed upstream spawn rejects and is not cached', async () => {
    const spawn = (): StdioClientTransport =>
      new StdioClientTransport({ command: 'definitely-not-a-real-binary-xyz', args: [], env: buildChildEnv() });
    const url = await startPipeApp('s5', 'srv1', spawn);
    // Poisoned pipe must not stick around: internal state cleaned, next spawn may retry.
    await expect(pipeClient(url)).rejects.toThrow();
    expect(peekHubPipe({ sessionId: 's5', serverId: 'srv1' })).toBeUndefined();
  }, 20_000);
});
