import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, sep } from 'node:path';
import {
  NODE_FILE_CHUNK_BYTES,
  NODE_FILE_MAX_BYTES,
  type ArtifactReadParams,
  type ArtifactReadResult,
  type ArtifactWriteParams,
  type PluginErrorCode,
} from '@tierwyn/shared';
import { RpcError } from './rpc.js';
import type { NodeLink } from './proxyAdapter.js';

export type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code: PluginErrorCode; retryable: boolean; retryAfter?: number };

const MAX_PULL_PATHS = 8;
const WALK_DEPTH_CAP = 64;

export function strictlyInside(shardDir: string, candidate: string): boolean {
  return candidate !== shardDir && candidate.startsWith(shardDir + sep);
}

/**
 * Every string value (any depth, arrays + objects) that *is* — as a whole
 * string, not as a substring — an absolute, already-normalised path strictly
 * inside `shardDir`. Prose mentioning a path, relative paths, and `<shard>/../`
 * escapes never match. Walk depth is capped so hostile payloads cannot blow
 * the stack.
 */
export function findShardPaths(value: unknown, shardDir: string): string[] {
  const base = normalize(shardDir);
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > WALK_DEPTH_CAP) return;
    if (typeof v === 'string') {
      if (!v || v.includes('\0') || !isAbsolute(v) || v.endsWith('/')) return;
      const n = normalize(v);
      if (n !== v) return; // only already-normalised strings qualify
      if (!strictlyInside(base, n)) return;
      out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const e of v) walk(e, depth + 1);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const e of Object.values(v as Record<string, unknown>)) walk(e, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/** Deep copy with exact-string replacements; non-matching strings untouched. */
export function replacePaths<T>(value: T, map: Map<string, string>): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > WALK_DEPTH_CAP) return v;
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map((e) => walk(e, depth + 1));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth + 1);
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}

/**
 * Pull a whole artifact from the node in 4 MiB chunks. Terminates on its own
 * counters: the buffer is sized from the first reply, a 0-byte chunk before
 * the end, a size change, or growth past `size` all abort the pull.
 */
export async function pullFile(link: NodeLink, conversationId: string, nodePath: string): Promise<Buffer> {
  let reply = await link.request<ArtifactReadResult>('artifact.read', {
    conversationId, path: nodePath, offset: 0,
  } satisfies ArtifactReadParams);
  const size = reply.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > NODE_FILE_MAX_BYTES) {
    throw new Error(`artifact size out of range: ${size}`);
  }
  const wantSha = typeof reply.sha256 === 'string' ? reply.sha256.toLowerCase() : undefined;
  if (!wantSha) throw new Error('artifact.read did not return a sha256');
  const out = Buffer.alloc(size);
  const hash = createHash('sha256');
  let offset = 0;
  for (;;) {
    const chunk = Buffer.from(typeof reply.data === 'string' ? reply.data : '', 'base64');
    if (chunk.length === 0 && offset < size) throw new Error('artifact stream ended early');
    if (offset + chunk.length > size) throw new Error('artifact grew during pull');
    chunk.copy(out, offset);
    hash.update(chunk);
    offset += chunk.length;
    if (offset >= size) break;
    reply = await link.request<ArtifactReadResult>('artifact.read', {
      conversationId,
      path: nodePath,
      offset,
      length: Math.min(NODE_FILE_CHUNK_BYTES, size - offset),
    } satisfies ArtifactReadParams);
    if (reply.size !== size) throw new Error('artifact size changed during pull');
  }
  if (hash.digest('hex') !== wantSha) throw new Error('artifact sha256 mismatch');
  return out;
}

/** Push a whole hub file to the node shard in 4 MiB chunks; returns the node path. */
export async function pushFile(link: NodeLink, conversationId: string, hubPath: string): Promise<string> {
  const fh = await open(hubPath, 'r');
  let bytes: Buffer;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > NODE_FILE_MAX_BYTES) throw new Error(`file exceeds ${NODE_FILE_MAX_BYTES} bytes`);
    bytes = await fh.readFile();
  } finally {
    await fh.close().catch(() => {});
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const uploadId = randomUUID();
  let offset = 0;
  for (;;) {
    const end = Math.min(offset + NODE_FILE_CHUNK_BYTES, bytes.length);
    const slice = bytes.subarray(offset, end);
    const final = end >= bytes.length;
    const r = await link.request<{ path?: string; received?: number }>('artifact.write', {
      conversationId,
      name: basename(hubPath),
      uploadId,
      offset,
      b64: slice.length ? slice.toString('base64') : '',
      final,
      size: bytes.length,
      sha256,
    } satisfies ArtifactWriteParams);
    if (final) {
      if (typeof r.path !== 'string') throw new Error('node did not return an artifact path');
      return r.path;
    }
    if (r.received !== end) throw new Error(`node acked ${String(r.received)} bytes, expected ${end}`);
    offset = end;
  }
}

function pullFail(why: string, nodeShard: string): Envelope {
  return {
    ok: false,
    code: 'bad_input',
    retryable: false,
    error: `${why}; inputImages must be files in your artifacts dir (${nodeShard})`,
  };
}

function deliverHint(name: string): Envelope {
  return {
    ok: false,
    code: 'upstream_error',
    retryable: true,
    error: `generated, but delivery to host failed; retry with POST /agent/artifacts/deliver {"name":"${name}"}`,
  };
}

/**
 * Spec §2.4: pull node-shard inputs into a hub staging dir, invoke the plugin
 * against hub paths, then push any hub-shard outputs back and rewrite every
 * returned path to its node location. Inputs are capped (≤8 distinct paths,
 * ≤64 MiB total) with `bad_input`; push failures become a retryable
 * `upstream_error` carrying the deliver hint while the hub file survives.
 */
export async function invokeForRemote(o: {
  link: NodeLink;
  conversationId: string;
  hubArtifactsRoot: string;
  body: unknown;
  invoke: (body: unknown) => Promise<Envelope>;
}): Promise<Envelope> {
  const nodeArtifacts = o.link.hello()?.artifactsRoot;
  if (!nodeArtifacts) return o.invoke(o.body);
  const nodeShard = join(normalize(nodeArtifacts), o.conversationId);
  const hubShard = join(normalize(o.hubArtifactsRoot), o.conversationId);
  const stagingDir = join(hubShard, '.remote-in', randomUUID());
  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const wanted = [...new Set(findShardPaths(o.body, nodeShard))];
    if (wanted.length > MAX_PULL_PATHS) {
      return pullFail(`at most ${MAX_PULL_PATHS} distinct input files per call (got ${wanted.length})`, nodeShard);
    }
    const pullMap = new Map<string, string>();
    let total = 0;
    for (const p of wanted) {
      let buf: Buffer;
      try {
        buf = await pullFile(o.link, o.conversationId, p);
      } catch (err) {
        const why = err instanceof RpcError && err.code === 'disconnected' ? 'host disconnected' : 'could not read input from host';
        return pullFail(why, nodeShard);
      }
      total += buf.length;
      if (total > NODE_FILE_MAX_BYTES) {
        return pullFail(`inputs exceed ${NODE_FILE_MAX_BYTES} bytes`, nodeShard);
      }
      const ext = extname(basename(p));
      const staged = join(stagingDir, `${randomUUID()}${/^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : ''}`);
      await writeFile(staged, buf, { flag: 'wx', mode: 0o600 });
      pullMap.set(p, staged);
    }
    const inverted = new Map([...pullMap].map(([orig, staged]) => [staged, orig] as const));
    const localBody = pullMap.size ? replacePaths(o.body, pullMap) : o.body;
    const env = await o.invoke(localBody);
    if (env.ok) {
      let data: unknown = inverted.size ? replacePaths(env.data, inverted) : env.data;
      const realShard = await realpath(hubShard).catch(() => null);
      for (const p of [...new Set(findShardPaths(data, hubShard))]) {
        if (p.includes(`${sep}.remote-in${sep}`)) continue;
        if (!realShard) return deliverHint(basename(p));
        const real = await realpath(p).catch(() => null);
        if (!real || !strictlyInside(realShard, real)) return deliverHint(basename(p));
        const st = await stat(real).catch(() => null);
        if (!st || !st.isFile()) return deliverHint(basename(p));
        let nodePath: string;
        try {
          nodePath = await pushFile(o.link, o.conversationId, real);
        } catch {
          return deliverHint(basename(p));
        }
        data = replacePaths(data, new Map([[p, nodePath]]));
      }
      return { ok: true, data };
    }
    let error = env.error;
    for (const [staged, orig] of inverted) error = error.split(staged).join(orig);
    error = error.split(hubShard).join(nodeShard);
    return { ...env, error };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Boot/best-effort: drop every conversation's `.remote-in` staging dir. */
export function sweepRemoteInStaging(hubArtifactsRoot: string): void {
  let shards: string[];
  try {
    shards = readdirSync(hubArtifactsRoot);
  } catch {
    return;
  }
  for (const s of shards) {
    try {
      rmSync(join(hubArtifactsRoot, s, '.remote-in'), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
