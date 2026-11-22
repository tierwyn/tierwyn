import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, realpath, rm, rmdir, lstat, link, unlink, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  NODE_FILE_CHUNK_BYTES,
  NODE_FILE_MAX_BYTES,
  type ArtifactPurgeParams,
  type ArtifactReadParams,
  type ArtifactReadResult,
  type ArtifactWriteParams,
  type ArtifactWriteResult,
} from '@tierwyn/shared';
import { RpcError } from './rpc.js';
import { openConfined } from './runtime.js';

// Shard id: no separators, no leading dot ('.' / '..' fail the leading alnum rule).
export const ARTIFACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
// Artifact basename: no leading dot (keeps part files and hidden entries unaddressable).
export const ARTIFACT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const UPLOAD_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PART_RE = /^\..+\.part$/;
const PART_STALE_MS = 60 * 60 * 1000;

function assertShardId(id: unknown): void {
  if (typeof id !== 'string' || !ARTIFACT_ID_RE.test(id)) throw new RpcError('bad_name', String(id));
}

function enoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function realRootOf(root: string): Promise<string> {
  return realpath(root).catch(() => {
    throw new RpcError('outside_shard', 'root');
  });
}

function under(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sweepStaleParts(shard: string, skip: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(shard);
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!PART_RE.test(e)) continue;
    const p = join(shard, e);
    if (p === skip) continue;
    const st = await lstat(p).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (now - st.mtimeMs > PART_STALE_MS) await unlink(p).catch(() => {});
  }
}

export async function artifactRead(root: string, p: ArtifactReadParams): Promise<ArtifactReadResult> {
  const { conversationId, path, offset, length } = p;
  assertShardId(conversationId);
  if (typeof path !== 'string' || !path || path.includes('\0')) {
    throw new RpcError('outside_shard', 'path');
  }
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new RpcError('bad_input', 'offset');
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new RpcError('bad_input', 'length');
  if ((length ?? NODE_FILE_CHUNK_BYTES) > NODE_FILE_CHUNK_BYTES) throw new RpcError('bad_input', 'length');

  const realRoot = await realRootOf(root);
  const realShard = await realpath(join(realRoot, conversationId)).catch((err) => {
    if (enoent(err)) throw new RpcError('not_found', conversationId);
    throw new RpcError('outside_shard', conversationId);
  });
  if (realShard === realRoot || !under(realRoot, realShard)) throw new RpcError('outside_shard', conversationId);

  const target = isAbsolute(path) ? path : resolve(realShard, path);
  const real = await realpath(target).catch((err) => {
    if (enoent(err)) throw new RpcError('not_found', path);
    throw new RpcError('outside_shard', path);
  });
  if (!under(realShard, real)) throw new RpcError('outside_shard', path);

  const fh = await openConfined(real, [realShard], path);
  try {
    const fst = await fh.stat();
    if (fst.size > NODE_FILE_MAX_BYTES) throw new RpcError('too_large', 'artifact too large');
    const off = offset ?? 0;
    if (off > fst.size) throw new RpcError('bad_input', 'offset');
    const out: ArtifactReadResult = { path: real, size: fst.size, data: '' };
    if (off === 0) {
      const hash = createHash('sha256');
      const rfh = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        for await (const chunk of rfh.createReadStream()) hash.update(chunk);
      } finally {
        await rfh.close().catch(() => {});
      }
      out.sha256 = hash.digest('hex');
    }
    const len = Math.min(length ?? NODE_FILE_CHUNK_BYTES, fst.size - off);
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      out.data = buf.subarray(0, bytesRead).toString('base64');
    }
    return out;
  } finally {
    try {
      await fh.close();
    } catch {
      /* already closed */
    }
  }
}

export async function artifactWrite(root: string, p: ArtifactWriteParams): Promise<ArtifactWriteResult> {
  const { conversationId, name, uploadId, offset, b64, final, size, sha256 } = p;
  assertShardId(conversationId);
  if (typeof name !== 'string' || !ARTIFACT_NAME_RE.test(name)) throw new RpcError('bad_name', String(name));
  if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) throw new RpcError('bad_name', uploadId);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RpcError('bad_input', 'offset');
  if (!Number.isSafeInteger(size) || size < 0 || size > NODE_FILE_MAX_BYTES) throw new RpcError('too_large', 'size');
  if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) throw new RpcError('bad_input', 'sha256');
  const buf = Buffer.from(b64 ?? '', 'base64');
  if (!final && buf.length === 0) throw new RpcError('bad_input', 'b64');

  const realRoot = await realRootOf(root);
  const shard = join(realRoot, conversationId);
  await mkdir(shard, { recursive: true, mode: 0o700 });
  const realShard = await realpath(shard);
  if (realShard === realRoot || !under(realRoot, realShard)) throw new RpcError('outside_shard', conversationId);

  const partPath = join(realShard, `.${uploadId}.part`);
  if (offset === 0) await sweepStaleParts(realShard, partPath);

  let fh: FileHandle | undefined;
  try {
    if (offset === 0) {
      fh = await open(
        partPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      ).catch((err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ELOOP') throw new RpcError('checksum', uploadId);
        throw err;
      });
      if (buf.length) await fh.write(buf, 0, buf.length, 0);
    } else {
      fh = await open(partPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW).catch((err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') throw new RpcError('checksum', uploadId);
        throw err;
      });
      const st = await fh.stat();
      if (!st.isFile() || st.size !== offset) throw new RpcError('checksum', uploadId);
      if (buf.length) {
        const { bytesWritten } = await fh.write(buf);
        if (bytesWritten !== buf.length) throw new RpcError('io', 'short write');
      }
    }
    const received = offset + buf.length;
    if (received > size) throw new RpcError('checksum', uploadId);
    if (!final) return { received };
    if (received !== size) throw new RpcError('checksum', uploadId);

    const hash = createHash('sha256');
    const rfh = await open(partPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      for await (const chunk of rfh.createReadStream()) hash.update(chunk);
    } finally {
      await rfh.close().catch(() => {});
    }
    if (hash.digest('hex') !== sha256.toLowerCase()) throw new RpcError('checksum', uploadId);

    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let landed = '';
    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? name : `${stem}-${i}${ext}`;
      try {
        await link(partPath, join(realShard, candidate));
        landed = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    if (!landed) throw new RpcError('bad_name', name);
    await unlink(partPath).catch(() => {});
    return { path: join(realShard, landed) };
  } catch (err) {
    await unlink(partPath).catch(() => {});
    throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function artifactPurge(root: string, p: ArtifactPurgeParams): Promise<{ ok: true }> {
  const { conversationId } = p;
  assertShardId(conversationId);
  const realRoot = await realRootOf(root);
  const realShard = await realpath(join(realRoot, conversationId)).catch(() => null);
  if (realShard === null) return { ok: true };
  if (realShard === realRoot || !under(realRoot, realShard)) throw new RpcError('outside_shard', conversationId);
  await rm(realShard, { recursive: true, force: true });
  return { ok: true };
}

export function newUploadId(): string {
  return randomUUID();
}

/**
 * Age sweep: unlinks old artifacts across every conversation shard, then drops
 * shards left empty. `maxAgeDays <= 0` disables. Symlinks are lstat'd — old
 * links themselves are removed, their targets are never followed or touched.
 */
export async function artifactSweep(root: string, maxAgeDays: number, now: number): Promise<{ removed: number }> {
  if (!(maxAgeDays > 0)) return { removed: 0 };
  const cutoff = now - maxAgeDays * 86_400_000;
  const realRoot = await realRootOf(root).catch(() => null);
  if (realRoot === null) return { removed: 0 };
  let shards: string[];
  try {
    shards = await readdir(realRoot);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const shard of shards) {
    if (!ARTIFACT_ID_RE.test(shard)) continue;
    const shardPath = join(realRoot, shard);
    const st = await lstat(shardPath).catch(() => null);
    if (!st?.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await readdir(shardPath);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(shardPath, e);
      const es = await lstat(p).catch(() => null);
      // Files, part files and symlinks are swept; nested dirs are left alone.
      if (!es || !(es.isFile() || es.isSymbolicLink())) continue;
      if (es.mtimeMs >= cutoff) continue;
      await unlink(p).then(() => { removed++; }).catch(() => {});
    }
    const left = await readdir(shardPath).catch(() => null);
    if (left !== null && left.length === 0) await rmdir(shardPath).catch(() => {});
  }
  return { removed };
}
