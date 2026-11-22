import { createHash, createPrivateKey, sign } from 'crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs';
import { join } from 'path';
import { packageAuthPayload } from '@tierwyn/shared';
import {
  BUILD_ID_HEADERS,
  firstHeader,
  NODE_ID_HEADER,
  NODE_SIG_HEADER,
  NODE_TS_HEADER,
  PACKAGE_SHA_HEADERS,
} from './brandHeaders.js';
import { loadNodeConfig, nodeConfigDir, writeNodeConfigFile } from './policy.js';

const MAX_BYTES = 64 * 1024 * 1024;

export class PackageFetchError extends Error {
  constructor(message: string, readonly code?: 'not_enrolled') {
    super(message);
    this.name = 'PackageFetchError';
  }
}

async function* iterateBody(body: unknown): AsyncIterable<Uint8Array> {
  if (!body) return;
  const obj = body as Record<symbol, unknown>;
  if (typeof obj[Symbol.asyncIterator] === 'function') {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const stream = body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) yield value;
  }
}

function persistAllowHttpPackage(dir: string): void {
  const raw = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8')) as Record<string, unknown>;
  if (raw.allowHttpPackage === true) return;
  writeNodeConfigFile(dir, { ...raw, allowHttpPackage: true });
}

export async function packageFetch(
  args: { dir?: string; out: string; allowHttp?: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<{ buildId: string }> {
  const dir = args.dir ?? nodeConfigDir();
  if (args.allowHttp) {
    try {
      persistAllowHttpPackage(dir);
    } catch {
      throw new PackageFetchError('not enrolled', 'not_enrolled');
    }
  }
  let config;
  try {
    config = loadNodeConfig(dir);
  } catch {
    throw new PackageFetchError('not enrolled', 'not_enrolled');
  }
  if (!config.hostId || !existsSync(config.keyPath)) {
    throw new PackageFetchError('not enrolled', 'not_enrolled');
  }
  const hubOrigin = new URL(config.hubUrl).origin;
  if (hubOrigin.startsWith('http:') && !config.allowHttpPackage) {
    throw new PackageFetchError('http hub refused without allowHttpPackage (--allow-http)');
  }

  const privateKey = createPrivateKey(readFileSync(config.keyPath));
  const ts = Date.now();
  const sig = sign(
    null,
    Buffer.from(packageAuthPayload(config.hostId, hubOrigin, ts)),
    privateKey,
  ).toString('base64url');

  const url = `${hubOrigin}/node/package.tgz`;
  const reqHeaders: Record<string, string> = {};
  reqHeaders[NODE_ID_HEADER] = config.hostId;
  reqHeaders[NODE_TS_HEADER] = String(ts);
  reqHeaders[NODE_SIG_HEADER] = sig;
  const res = await fetchFn(url, {
    redirect: 'error',
    headers: reqHeaders,
  });
  if (!res.ok) throw new PackageFetchError(`HTTP ${res.status}`);

  const expected = (firstHeader(res.headers, PACKAGE_SHA_HEADERS) ?? '').toLowerCase();
  const buildId = firstHeader(res.headers, BUILD_ID_HEADERS) ?? '';
  if (!/^[0-9a-f]{64}$/.test(expected) || !buildId) {
    throw new PackageFetchError('missing package headers');
  }

  const part = `${args.out}.part`;
  const hash = createHash('sha256');
  let size = 0;
  let fd: number | undefined;
  try {
    fd = openSync(part, 'w');
    for await (const chunk of iterateBody(res.body)) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new PackageFetchError('body exceeds 64 MiB');
      hash.update(chunk);
      writeSync(fd, chunk);
    }
    closeSync(fd);
    fd = undefined;
    const got = hash.digest('hex');
    if (got !== expected) throw new PackageFetchError('sha256 mismatch');
    renameSync(part, args.out);
    return { buildId };
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(part); } catch { /* ignore */ }
    try { unlinkSync(args.out); } catch { /* ignore */ }
    throw err;
  }
}
