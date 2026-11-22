import { createHash, createPublicKey, verify } from 'crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import { packageAuthPayload } from '@tierwyn/shared';
import type { LoginRateLimiter } from '../auth/rateLimit.js';
import { enrollTokenValid, getRemoteHost } from '../repositories/remoteHosts.js';
import {
  BUILD_ID_HEADER,
  firstHeader,
  NODE_ID_HEADERS,
  NODE_SIG_HEADERS,
  NODE_TS_HEADERS,
  PACKAGE_SHA_HEADER,
} from '../node/brandHeaders.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(here, '../../dist/node-package');
const MARKER_RE = /^(TIERWYN)_HUB_PKG_SHA256=""(\s+#.*)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^tierwyn-node-[\w.-]+\.tgz$/;
const TS_WINDOW_MS = 300_000;

export type PackageManifest = { buildId: string; sha256: string; size: number; file: string };

export function readPackageManifest(dir = DEFAULT_DIR): PackageManifest | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return undefined;
    const m = raw as Record<string, unknown>;
    if (
      typeof m.buildId !== 'string' ||
      typeof m.sha256 !== 'string' ||
      typeof m.file !== 'string' ||
      typeof m.size !== 'number'
    ) {
      return undefined;
    }
    if (!SHA_RE.test(m.sha256) || !FILE_RE.test(m.file)) return undefined;
    return { buildId: m.buildId, sha256: m.sha256, size: m.size, file: m.file };
  } catch {
    return undefined;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return '';
  return h.slice('Bearer '.length).trim();
}

function verifyNodeSig(db: Database, req: Request, now: number): boolean {
  const hostId = firstHeader(req.headers, NODE_ID_HEADERS) ?? '';
  const tsRaw = firstHeader(req.headers, NODE_TS_HEADERS) ?? '';
  const sig = firstHeader(req.headers, NODE_SIG_HEADERS) ?? '';
  if (!hostId || !tsRaw || !sig) return false;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TS_WINDOW_MS) return false;
  const host = getRemoteHost(db, hostId);
  if (!host || (host.status !== 'enrolled' && host.status !== 'trusted')) return false;
  if (!host.publicKey || !host.hubOrigin) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(host.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(packageAuthPayload(hostId, host.hubOrigin, ts)),
      key,
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

function authorizeTgz(db: Database, req: Request, now: number): boolean {
  const token = bearer(req);
  if (token && enrollTokenValid(db, hashToken(token), now)) return true;
  return verifyNodeSig(db, req, now);
}

function substituteMarker(raw: string, sha: string): string | undefined {
  const lines = raw.split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i]!);
    if (!m) continue;
    hits++;
    lines[i] = `${m[1]}_HUB_PKG_SHA256="${sha}"${m[2] ?? ''}`;
  }
  if (hits < 1) return undefined;
  return lines.join('\n');
}

export function registerNodePackageRoutes(
  app: Express,
  deps: { db: () => Database; rateLimiter: LoginRateLimiter; packageDir?: string; now?: () => number },
): void {
  const dir = deps.packageDir ?? DEFAULT_DIR;
  const nowFn = deps.now ?? Date.now;

  app.get('/node/install.sh', (_req: Request, res: Response) => {
    try {
      const manifest = readPackageManifest(dir);
      if (!manifest) {
        res.status(503).json({ code: 'package_unavailable' });
        return;
      }
      const scriptPath = join(dir, 'install.sh');
      if (!existsSync(scriptPath)) {
        res.status(503).json({ code: 'package_unavailable' });
        return;
      }
      const body = substituteMarker(readFileSync(scriptPath, 'utf8'), manifest.sha256);
      if (body === undefined) {
        res.status(503).json({ code: 'package_unavailable' });
        return;
      }
      res.setHeader('Content-Type', 'text/x-shellscript');
      res.send(body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.get('/node/package.tgz', (req: Request, res: Response) => {
    const key = `node-package:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
    try {
      const limit = deps.rateLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec ?? 60));
        res.status(429).json({ error: 'too many attempts' });
        return;
      }
      if (!authorizeTgz(deps.db(), req, nowFn())) {
        deps.rateLimiter.recordFailure(key);
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      deps.rateLimiter.reset(key);
      const manifest = readPackageManifest(dir);
      if (!manifest) {
        res.status(503).json({ code: 'package_unavailable' });
        return;
      }
      const filePath = join(dir, manifest.file);
      if (!existsSync(filePath)) {
        res.status(503).json({ code: 'package_unavailable' });
        return;
      }
      const st = statSync(filePath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader(BUILD_ID_HEADER, manifest.buildId);
      res.setHeader(PACKAGE_SHA_HEADER, manifest.sha256);
      const stream = createReadStream(filePath);
      req.on('close', () => { stream.destroy(); });
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });
}
