import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  NODE_FILE_MAX_BYTES, NODE_PROTOCOL,
  type ArtifactReadResult, type NodeHello,
} from '@tierwyn/shared';
import { NodeRuntime } from './runtime.js';
import { memoryPair, RpcPeer } from './rpc.js';
import { linkFromPeer, type NodeLink } from './proxyAdapter.js';
import { findShardPaths, invokeForRemote, pullFile, pushFile, replacePaths, sweepRemoteInStaging } from './artifacts.js';

const CONV = 'conv1conversation';
const ART_ROOT = realpathSync('/tmp');

describe('findShardPaths', () => {
  const shard = '/srv/artifacts/conv1';

  it('ignores prose containing the path and relative paths; finds nested entries', () => {
    const body = {
      note: `see ${shard}/img.png for details`,
      rel: 'img/relative.png',
      self: shard,
      trailing: `${shard}/`,
      list: [{ p: `${shard}/deep/ok.png` }, `${shard}/top.png`],
    };
    expect(findShardPaths(body, shard).sort()).toEqual([`${shard}/deep/ok.png`, `${shard}/top.png`].sort());
  });

  it('rejects ../ escape, NUL bytes, and deeply nested bodies without throwing', () => {
    expect(findShardPaths({ a: `${shard}/../c2/x.png` }, shard)).toEqual([]);
    expect(findShardPaths({ a: `${shard}/im\0g.png` }, shard)).toEqual([]);
    let deep: unknown = `${shard}/bottom.png`;
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(Array.isArray(findShardPaths(deep, shard))).toBe(true);
  });
});

describe('replacePaths', () => {
  it('deep-copies with exact-string replacement, touching nothing else', () => {
    const src = { a: ['/x/one', { b: '/x/two', c: 3 }], d: 'no match /x/on' };
    const out = replacePaths(src, new Map([['/x/one', '/y/1'], ['/x/two', '/y/2']]));
    expect(out).toEqual({ a: ['/y/1', { b: '/y/2', c: 3 }], d: 'no match /x/on' });
    expect(out).not.toBe(src);
  });
});

describe('pullFile / pushFile over a real NodeRuntime', () => {
  let nodeRoot: string;
  let hubRoot: string;
  let hubPeer: RpcPeer;
  let link: NodeLink;
  let artShard: string;
  let hubShard: string;

  beforeAll(() => {
    nodeRoot = mkdtempSync(join(tmpdir(), 'keleo-art-node-'));
    hubRoot = mkdtempSync(join(tmpdir(), 'keleo-art-hub-'));
    const artRoot = join(nodeRoot, '.node-artifacts');
    mkdirSync(join(artRoot, CONV), { recursive: true });
    artShard = join(artRoot, CONV);
    mkdirSync(join(hubRoot, CONV), { recursive: true });
    hubShard = join(hubRoot, CONV);
    const [hubT, nodeT] = memoryPair();
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters in artifact tests'); },
      has: () => false,
      policy: { roots: [nodeRoot], allowedAgents: [], maxSessions: 4 },
      artifactsRoot: artRoot,
    });
    void new RpcPeer(nodeT, runtime.handlers());
    hubPeer = new RpcPeer(hubT, {});
    const hello: NodeHello = {
      protocol: NODE_PROTOCOL, gitSha: 't', hostname: 't', os: 'linux', arch: 'x64',
      homedir: '/home/t', roots: [nodeRoot], listenPort: 0, agents: {}, models: {},
      sessions: [], artifactsRoot: realpathSync(artRoot),
    };
    link = linkFromPeer('host1', hubPeer, hello);
  });

  afterAll(() => {
    rmSync(nodeRoot, { recursive: true, force: true });
    rmSync(hubRoot, { recursive: true, force: true });
  });

  it('round-trips a 9 MiB random buffer through push and pull with equal sha', async () => {
    const src = join(artShard, 'src.bin');
    const bytes = randomBytes(9 * 1024 * 1024);
    writeFileSync(src, bytes);
    const nodePath = await pushFile(link, CONV, src);
    expect(nodePath.startsWith(realpathSync(artShard))).toBe(true);
    const back = await pullFile(link, CONV, nodePath);
    expect(back.length).toBe(bytes.length);
    expect(createHash('sha256').update(back).digest('hex'))
      .toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('pullFile rejects a stub whose second chunk decodes to zero bytes (no hang)', { timeout: 2_000 }, async () => {
    const payload = Buffer.from('012345');
    let n = 0;
    const stub = {
      hostId: 's',
      hello: () => undefined,
      connected: () => true,
      subscribe: () => () => {},
      setSteerSource: () => {},
      request: async (_m: string, p: unknown) => {
        n++;
        const off = (p as { offset: number }).offset;
        if (n === 1) {
          return {
            path: '/x', size: payload.length,
            sha256: createHash('sha256').update(payload).digest('hex'),
            data: payload.subarray(0, 4).toString('base64'),
          } satisfies ArtifactReadResult;
        }
        return { path: '/x', size: payload.length, data: '', offset: off } satisfies ArtifactReadResult;
      },
    } as unknown as NodeLink;
    await expect(pullFile(stub, CONV, '/x')).rejects.toThrow();
  });

  it('pullFile rejects a stub reporting size above NODE_FILE_MAX_BYTES before reading', async () => {
    let reads = 0;
    const stub = {
      hostId: 's',
      hello: () => undefined,
      connected: () => true,
      subscribe: () => () => {},
      setSteerSource: () => {},
      request: async () => {
        reads++;
        return { path: '/x', size: NODE_FILE_MAX_BYTES + 1, data: '' };
      },
    } as unknown as NodeLink;
    await expect(pullFile(stub, CONV, '/x')).rejects.toThrow();
    expect(reads).toBe(1);
  });

  it('pushFile rejects a hub file above NODE_FILE_MAX_BYTES', async () => {
    const big = join(artShard, 'big.bin');
    writeFileSync(big, Buffer.alloc(NODE_FILE_MAX_BYTES + 1));
    await expect(pushFile(link, CONV, big)).rejects.toThrow();
  });
});

describe('invokeForRemote', () => {
  let nodeRoot: string;
  let hubRoot: string;
  let hubPeer: RpcPeer;
  let link: NodeLink;
  let artShard: string;
  let hubShard: string;

  beforeAll(() => {
    nodeRoot = mkdtempSync(join(tmpdir(), 'keleo-ir-node-'));
    hubRoot = mkdtempSync(join(tmpdir(), 'keleo-ir-hub-'));
    const artRoot = join(nodeRoot, '.node-artifacts');
    mkdirSync(join(artRoot, CONV), { recursive: true });
    artShard = realpathSync(join(artRoot, CONV));
    mkdirSync(join(hubRoot, CONV), { recursive: true });
    hubShard = join(hubRoot, CONV);
    const [hubT, nodeT] = memoryPair();
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters in artifact tests'); },
      has: () => false,
      policy: { roots: [nodeRoot], allowedAgents: [], maxSessions: 4 },
      artifactsRoot: artRoot,
    });
    void new RpcPeer(nodeT, runtime.handlers());
    hubPeer = new RpcPeer(hubT, {});
    const hello: NodeHello = {
      protocol: NODE_PROTOCOL, gitSha: 't', hostname: 't', os: 'linux', arch: 'x64',
      homedir: '/home/t', roots: [nodeRoot], listenPort: 0, agents: {}, models: {},
      sessions: [], artifactsRoot: realpathSync(join(artRoot)),
    };
    link = linkFromPeer('host1', hubPeer, hello);
    writeFileSync(join(artShard, 'in.png'), Buffer.from('node-bytes'));
  });

  afterAll(() => {
    hubPeer.close();
    rmSync(nodeRoot, { recursive: true, force: true });
    rmSync(hubRoot, { recursive: true, force: true });
  });

  it('stages node input under hub .remote-in, rewrites output to the node path, cleans up', async () => {
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { inputImages: [join(artShard, 'in.png')] },
      invoke: async (b) => {
        const staged = (b as { inputImages: string[] }).inputImages[0];
        expect(staged.startsWith(join(hubShard, '.remote-in') + '/')).toBe(true);
        expect(staged.endsWith('.png')).toBe(true);
        expect((statSync(staged).mode & 0o777) === 0o600).toBe(true);
        expect(readFileSync(staged, 'utf8')).toBe('node-bytes');
        const out = join(hubShard, 'out.png');
        writeFileSync(out, Buffer.from('rendered'));
        return { ok: true, data: { path: out } };
      },
    });
    expect(env.ok).toBe(true);
    const nodeOut = (env as { ok: true; data: { path: string } }).data.path;
    expect(nodeOut.startsWith(artShard)).toBe(true);
    expect(readFileSync(nodeOut, 'utf8')).toBe('rendered');
    expect(existsSync(join(artShard, 'out.png'))).toBe(true);
    expect(readdirSync(join(hubShard, '.remote-in'))).toEqual([]);
  });

  it('leaves input outside the node shard as-is', async () => {
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { p: '/etc/hostname' },
      invoke: async (b) => ({ ok: true, data: { p: (b as { p: string }).p } }),
    });
    expect(env.ok).toBe(true);
    expect((env as { ok: true; data: { p: string } }).data.p).toBe('/etc/hostname');
  });

  it('returns bad_input without calling invoke when the node input is missing', async () => {
    let called = false;
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { inputImages: [join(artShard, 'missing.png')] },
      invoke: async () => { called = true; return { ok: true, data: null }; },
    });
    expect(called).toBe(false);
    expect(env).toMatchObject({ ok: false, code: 'bad_input', retryable: false });
    expect((env as { error: string }).error).toContain(artShard);
  });

  it('caps pulls at 8 distinct paths with bad_input and no invoke', async () => {
    let called = false;
    const paths = Array.from({ length: 9 }, (_, i) => join(artShard, `cap${i}.png`));
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { list: paths },
      invoke: async () => { called = true; return { ok: true, data: null }; },
    });
    expect(called).toBe(false);
    expect(env).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('rewrites an echoed staged input path back to the node path', async () => {
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { inputImages: [join(artShard, 'in.png')] },
      invoke: async (b) => {
        const staged = (b as { inputImages: string[] }).inputImages[0];
        return { ok: true, data: { echo: staged } };
      },
    });
    expect(env.ok).toBe(true);
    const echo = (env as { ok: true; data: { echo: string } }).data.echo;
    expect(echo).toBe(join(artShard, 'in.png'));
  });

  it('returns upstream_error retryable when the link closes after invoke, hub file kept', async () => {
    const out = join(hubShard, 'late.png');
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { p: 'nothing-inside-shard' },
      invoke: async () => {
        writeFileSync(out, Buffer.from('made it'));
        hubPeer.close();
        return { ok: true, data: { path: out } };
      },
    });
    expect(env).toMatchObject({ ok: false, code: 'upstream_error', retryable: true });
    expect((env as { error: string }).error).toContain('/agent/artifacts/deliver');
    expect(existsSync(out)).toBe(true);
  });

  it('rewrites the hub shard prefix in an error envelope to the node shard', async () => {
    const env = await invokeForRemote({
      link, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { p: 'no-shard-input' },
      invoke: async () => ({ ok: false, code: 'upstream_error', retryable: false, error: `boom at ${join(hubShard, 'x.png')}` }),
    });
    expect(env.ok).toBe(false);
    const msg = (env as { error: string }).error;
    expect(msg).toContain(artShard);
    expect(msg).not.toContain(hubShard);
  });

  it('passes the body through untouched when hello has no artifactsRoot', async () => {
    const hello2 = {
      protocol: NODE_PROTOCOL, gitSha: 't', hostname: 't', os: 'linux', arch: 'x64',
      homedir: '/home/t', roots: ['/tmp'], listenPort: 0, agents: {}, models: {},
      sessions: [],
    } as NodeHello;
    const link2 = linkFromPeer('host2', hubPeer, hello2);
    const env = await invokeForRemote({
      link: link2, conversationId: CONV, hubArtifactsRoot: hubRoot,
      body: { p: join(artShard, 'in.png') },
      invoke: async (b) => ({ ok: true, data: { seen: b } }),
    });
    expect(env.ok).toBe(true);
    expect((env as { ok: true; data: { seen: unknown } }).data.seen).toEqual({ p: join(artShard, 'in.png') });
  });
});

describe('sweepRemoteInStaging', () => {
  it('removes .remote-in under every shard and tolerates a missing root', () => {
    const root = mkdtempSync(join(tmpdir(), 'keleo-sweep-'));
    mkdirSync(join(root, 'convA', '.remote-in', 'call1'), { recursive: true });
    mkdirSync(join(root, 'convB'), { recursive: true });
    writeFileSync(join(root, 'convA', '.remote-in', 'call1', 'f'), 'x');
    sweepRemoteInStaging(root);
    expect(existsSync(join(root, 'convA', '.remote-in'))).toBe(false);
    expect(existsSync(join(root, 'convB'))).toBe(true);
    sweepRemoteInStaging(join(root, 'does-not-exist'));
    rmSync(root, { recursive: true, force: true });
  });
});
