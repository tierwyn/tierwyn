import { timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';
import type { Database } from 'better-sqlite3';
import { peekSpawnToken } from '../spawn/tokens.js';
import { remoteHostIdFor } from '../repositories/remoteHosts.js';
import {
  deleteHeaders,
  firstHeader,
  NODE_HEADER,
  NODE_HEADERS,
  NODE_SECRET_HEADER,
  NODE_SECRET_HEADERS,
} from './brandHeaders.js';

export { NODE_HEADER, NODE_SECRET_HEADER };

export function originGuard(deps: { db: () => Database; nodeSecret: string }): RequestHandler {
  return (req, res, next) => {
    const presented = firstHeader(req.headers, NODE_SECRET_HEADERS);
    if (secretMatches(presented, deps.nodeSecret)) {
      res.locals.nodeHostId = firstHeader(req.headers, NODE_HEADERS);
      deleteHeaders(req.headers, NODE_SECRET_HEADERS);
    } else {
      deleteHeaders(req.headers, NODE_HEADERS);
      deleteHeaders(req.headers, NODE_SECRET_HEADERS);
    }

    const raw = headerVal(req.headers.authorization);
    const token = raw?.startsWith('Bearer ') ? raw.slice(7) : undefined;
    if (!token) {
      next();
      return;
    }
    const entry = peekSpawnToken(token);
    if (!entry) {
      next();
      return;
    }
    const want = remoteHostIdFor(deps.db(), { conversationId: entry.conversationId });
    const got = (res.locals.nodeHostId as string | undefined) ?? null;
    if (want !== got) {
      res.status(403).json({ error: 'token_origin_mismatch' });
      return;
    }
    next();
  };
}

function headerVal(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function secretMatches(got: string | undefined, want: string): boolean {
  if (got === undefined) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
