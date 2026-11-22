import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { type AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express, { type Express } from 'express';
import {
  NODE_PROTOCOL,
  type NodeHello,
  type PluginCaller,
  type PluginEnvelope,
} from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createConversation } from '../repositories/conversations.js';
import { createProject } from '../repositories/projects.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { CONVERSATION_CAPABILITIES, issueSpawnToken, revokeSpawnTokensForSession } from '../spawn/tokens.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcPeer } from '../node/rpc.js';
import { linkFromPeer, type NodeLink } from '../node/proxyAdapter.js';
import { NODE_HEADER, NODE_SECRET_HEADER, originGuard } from '../node/originGuard.js';
import { registerPluginAgentRoutes } from './plugins.js';
import type { PluginHost } from '../plugins/host.js';

const SECRET = 'node-secret-for-plugins-remote-tests';
const sessions: string[] = [];
const roots: string[] = [];

interface Resp { status: number; body: unknown; }

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe('plugin agent routes with a remote node (tunnel)', () => {
  let server: Server | undefined;
  let base = '';
  let hubPeer: RpcPeer;
  let link: NodeLink;
  let linkNoRoot: NodeLink;
  let nodeArtRoot: string; // realpath of the node artifacts root
  let hubData: string; // hub data dir (tmp); artifacts root derived via resolve(relative, 'artifacts')
  let hubArtifactsRoot: string;
  let hostId = '';
  let host2Id = '';
  let convA = ''; // bound to hostId (has artifactsRoot)
  let convC = ''; // bound to hostId (has artifactsRoot), unused before the deliver tests
  let convB = ''; // bound to host2Id (link without artifactsRoot)
  let convDL = ''; // deliver rate-limit conversation
  let convDL2 = ''; // deliver-after-close conversation
  let localConv = ''; // no remote binding
  let isAuthed = false;
  let stubThrow = false;
  let stubConv = '';
  let seenBody: unknown;
  let seenCaller: PluginCaller | undefined;
  let hubDLShard = '';

  const stubHost = {
    listForAgent: () => [{ id: 'img', capabilities: [] }],
    invoke: async (
      _pluginId: string,
      _name: string,
      body: unknown,
      caller: PluginCaller,
    ): Promise<PluginEnvelope> => {
      seenBody = body;
      seenCaller = caller;
      if (stubThrow) throw new Error(`plugin exploded at ${join(hubArtifactsRoot, stubConv, 'secret.png')}`);
      const out = join(hubArtifactsRoot, stubConv, 'out.png');
      mkdirSync(join(hubArtifactsRoot, stubConv), { recursive: true });
      writeFileSync(out, Buffer.from('rendered'));
      return { ok: true, data: { path: out } };
    },
  } as unknown as PluginHost;

  function tokenFor(conversationId: string): string {
    const sessionId = `sess-${conversationId}`;
    sessions.push(sessionId);
    return issueSpawnToken(conversationId, sessionId, CONVERSATION_CAPABILITIES);
  }

  async function call(
    method: string,
    path: string,
    opts: { token?: string; host?: string; body?: unknown; tunnel?: boolean } = {},
  ): Promise<Resp> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.tunnel !== false) {
      headers[NODE_HEADER] = opts.host ?? hostId;
      headers[NODE_SECRET_HEADER] = SECRET;
    }
    const res = await fetch(base + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  function envelope(b: unknown): { ok: boolean; data?: { path?: string }; error?: string; code?: string } {
    return b as { ok: boolean; data?: { path?: string }; error?: string; code?: string };
  }

  beforeAll(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    hostId = createPendingHost(db, 'alpha', 'tok', Date.now() + 3_600_000).id;
    host2Id = createPendingHost(db, 'beta', 'tok2', Date.now() + 3_600_000).id;
    const remoteProject = createProject(db, { name: 'remote', rootPath: '/tmp/remote', remoteHostId: hostId });
    convA = createConversation(db, { projectId: remoteProject.id, title: 'a' }).id;
    convC = createConversation(db, { projectId: remoteProject.id, title: 'c' }).id;
    convDL = createConversation(db, { projectId: remoteProject.id, title: 'dl' }).id;
    convDL2 = createConversation(db, { projectId: remoteProject.id, title: 'dl2' }).id;
    const remote2 = createProject(db, { name: 'remote2', rootPath: '/tmp/remote2', remoteHostId: host2Id });
    convB = createConversation(db, { projectId: remote2.id, title: 'b' }).id;
    localConv = createConversation(db, {
      projectId: createProject(db, { name: 'local', rootPath: '/tmp/local' }).id,
      title: 'lc',
    }).id;

    // Node side: a real runtime whose hello advertises artifactsRoot.
    const nodeRoot = tmpRoot('keleo-plugrem-node-');
    const artRoot = join(nodeRoot, '.node-artifacts');
    mkdirSync(join(artRoot, convA), { recursive: true });
    mkdirSync(join(artRoot, convDL), { recursive: true });
    mkdirSync(join(artRoot, convDL2), { recursive: true });
    writeFileSync(join(artRoot, convA, 'in.png'), Buffer.from('node-bytes'));
    nodeArtRoot = realpathSync(artRoot);
    const [hubT, nodeT] = memoryPair();
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters in plugin remote tests'); },
      has: () => false,
      policy: { roots: [nodeRoot], allowedAgents: [], maxSessions: 4 },
      artifactsRoot: artRoot,
    });
    void new RpcPeer(nodeT, runtime.handlers());
    hubPeer = new RpcPeer(hubT, {});
    const hello: NodeHello = {
      protocol: NODE_PROTOCOL, gitSha: 't', hostname: 't', os: 'linux', arch: 'x64',
      homedir: '/home/t', roots: [nodeRoot], listenPort: 0, agents: {}, models: {},
      sessions: [], artifactsRoot: nodeArtRoot,
    };
    link = linkFromPeer(hostId, hubPeer, hello);
    const hello2: NodeHello = {
      protocol: NODE_PROTOCOL, gitSha: 't', hostname: 't', os: 'linux', arch: 'x64',
      homedir: '/home/t', roots: [nodeRoot], listenPort: 0, agents: {}, models: {},
      sessions: [],
    };
    linkNoRoot = linkFromPeer(host2Id, hubPeer, hello2);

    // Hub side: artifacts root produced the way index.ts will produce it —
    // resolve() of a *relative* dataDir (H1).
    hubData = tmpRoot('keleo-plugrem-hub-');
    const relData = relative(process.cwd(), hubData);
    hubArtifactsRoot = resolve(relData, 'artifacts');
    expect(hubArtifactsRoot).toBe(join(hubData, 'artifacts'));

    const app: Express = express();
    app.use(express.json({ limit: '256kb' }));
    app.use(originGuard({ db: () => db, nodeSecret: SECRET }));
    registerPluginAgentRoutes(app, {
      host: stubHost,
      isAuthed: () => isAuthed,
      nodeLink: (id) => (id === hostId ? link : linkNoRoot),
      hubArtifactsRoot,
    });
    server = createServer(app);
    server.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    hubPeer?.close();
    for (const s of sessions.splice(0)) revokeSpawnTokensForSession(s);
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('tunnelled agent call: response data.path is under node artifactsRoot and the file exists there', async () => {
    stubConv = convA;
    const nodeShard = join(nodeArtRoot, convA);
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(convA),
      body: { inputImages: [join(nodeShard, 'in.png')] },
    });
    expect(r.status).toBe(200);
    expect(seenCaller?.kind).toBe('agent');
    // the plugin saw a hub staging path, not the node path
    const staged = (seenBody as { inputImages: string[] }).inputImages[0];
    expect(staged.startsWith(join(hubArtifactsRoot, convA, '.remote-in') + '/')).toBe(true);
    // the agent got a node path, and the bytes really landed there
    const outPath = envelope(r.body).data?.path ?? '';
    expect(outPath.startsWith(join(nodeArtRoot, convA) + '/')).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toBe('rendered');
  });

  it('same call without nodeHostId (local conversation): hub path returned, body unchanged', async () => {
    stubConv = localConv;
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(localConv),
      tunnel: false,
      body: { p: 'x' },
    });
    expect(r.status).toBe(200);
    expect(seenBody).toEqual({ p: 'x' });
    expect(envelope(r.body).data?.path).toBe(join(hubArtifactsRoot, localConv, 'out.png'));
  });

  it('hubArtifactsRoot given as resolve() of a relative dataDir still matches the absolute output path', async () => {
    stubConv = convC;
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(convC),
      body: { inputImages: [join(nodeArtRoot, convA, 'in.png')] },
    });
    expect(r.status).toBe(200);
    const outPath = envelope(r.body).data?.path ?? '';
    expect(outPath.startsWith(normalize(hubArtifactsRoot))).toBe(false);
    expect(outPath.startsWith(join(nodeArtRoot, convC) + '/')).toBe(true);
    expect(existsSync(outPath)).toBe(true);
  });

  it('a throwing plugin becomes 500 {ok:false, upstream_error, "internal error"} without echoing the error', async () => {
    stubConv = convA;
    stubThrow = true;
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(convA),
      body: { p: 'x' },
    });
    stubThrow = false;
    expect(r.status).toBe(500);
    const b = envelope(r.body);
    expect(b.ok).toBe(false);
    expect(b.code).toBe('upstream_error');
    expect(b.error).toBe('internal error');
    expect(b.error).not.toContain('secret.png');
    // the process/route survived
    stubConv = convA;
    const ok = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(convA),
      body: { p: 'y' },
    });
    expect(ok.status).toBe(200);
  });

  it('operator (cookie) caller on a tunnelled request: hub path returned, no rewrite', async () => {
    stubConv = convA;
    isAuthed = true;
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      body: { p: 'op' },
    });
    isAuthed = false;
    expect(r.status).toBe(200);
    expect(seenCaller?.kind).toBe('operator');
    expect(seenBody).toEqual({ p: 'op' });
    expect(envelope(r.body).data?.path).toBe(join(hubArtifactsRoot, convA, 'out.png'));
  });

  it('node hello without artifactsRoot: body passed through untouched, hub path returned', async () => {
    stubConv = convB;
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(convB),
      host: host2Id,
      body: { p: join(nodeArtRoot, convA, 'in.png') },
    });
    expect(r.status).toBe(200);
    expect(seenBody).toEqual({ p: join(nodeArtRoot, convA, 'in.png') });
    expect(envelope(r.body).data?.path).toBe(join(hubArtifactsRoot, convB, 'out.png'));
  });

  describe('POST /agent/artifacts/deliver', () => {
    it('rejects untunnelled (404), operator (401), bad name (400), missing file (404); lands a real file; 429 on the 11th call in a minute', async () => {
      // no nodeHostId (untunnelled operator still reaches the route)
      isAuthed = true;
      expect((await call('POST', '/agent/artifacts/deliver', {
        tunnel: false, body: { name: 'deliver.png' },
      })).status).toBe(404);
      // operator caller on a tunnelled request
      expect((await call('POST', '/agent/artifacts/deliver', {
        body: { name: 'deliver.png' },
      })).status).toBe(401);
      isAuthed = false;
      // bad name
      expect((await call('POST', '/agent/artifacts/deliver', {
        token: tokenFor(convDL), body: { name: '../x' },
      })).status).toBe(400);
      // missing file (consumes one bucket slot)
      expect((await call('POST', '/agent/artifacts/deliver', {
        token: tokenFor(convDL), body: { name: 'nope.png' },
      })).status).toBe(404);

      hubDLShard = join(hubArtifactsRoot, convDL);
      mkdirSync(hubDLShard, { recursive: true });
      writeFileSync(join(hubDLShard, 'deliver.png'), Buffer.from('payload'));
      let landed = '';
      for (let i = 0; i < 9; i++) {
        const r = await call('POST', '/agent/artifacts/deliver', {
          token: tokenFor(convDL), body: { name: 'deliver.png' },
        });
        expect(r.status).toBe(200);
        if (i === 0) {
          landed = (r.body as { path?: string }).path ?? '';
          expect(landed.startsWith(join(nodeArtRoot, convDL) + '/')).toBe(true);
          expect(readFileSync(landed, 'utf8')).toBe('payload');
        }
      }
      const eleventh = await call('POST', '/agent/artifacts/deliver', {
        token: tokenFor(convDL), body: { name: 'deliver.png' },
      });
      expect(eleventh.status).toBe(429);
    });
  });

  it('after the node link closes: deliver → 502 host_unreachable; capability call degrades to a bad_input envelope', async () => {
    stubConv = convDL2;
    hubPeer.close();
    const hubShard = join(hubArtifactsRoot, convDL2);
    mkdirSync(hubShard, { recursive: true });
    writeFileSync(join(hubShard, 'late.png'), Buffer.from('late'));
    const deliver = await call('POST', '/agent/artifacts/deliver', {
      token: tokenFor(convDL2), body: { name: 'late.png' },
    });
    expect(deliver.status).toBe(502);
    expect((deliver.body as { error?: string }).error).toBe('host_unreachable');

    const cap = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(convDL2),
      body: { inputImages: [join(nodeArtRoot, convDL2, 'missing.png')] },
    });
    // pull failure surfaces as a bad_input envelope (HTTP 400 per the code map)
    expect(cap.status).toBe(400);
    const b = envelope(cap.body);
    expect(b.ok).toBe(false);
    expect(b.code).toBe('bad_input');
  });

  it('bearer of a local conversation via a tunnelled request → 403 token_origin_mismatch', async () => {
    const r = await call('POST', '/agent/plugins/img/capabilities/render', {
      token: tokenFor(localConv),
      body: { p: 'x' },
    });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe('token_origin_mismatch');
  });
});
