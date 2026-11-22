import type { Request, RequestHandler, Response } from 'express';
import express from 'express';
import type { AuthConfig } from '../auth/config.js';
import { verifySessionCookieHeader } from '../auth/cookie.js';
import { peekSpawnToken } from '../spawn/tokens.js';

/** Public / unauthenticated JSON (login, enroll). */
export const JSON_LIMIT_PUBLIC = '64kb';
/**
 * Cookie-authed JSON after `requireAuth`, and dual-auth pre-requireAuth
 * routes that already carry a live spawn token, session cookie, or node
 * secret. Matches file / draft / plugin-image payloads.
 */
export const JSON_LIMIT_AUTHED = '25mb';

/**
 * Operator UI WebSocket (`/ws`). Drafts/prompts allow 10 attachments / 5 MiB
 * each / 20 MiB decoded total; base64 is ~4/3 so the JSON frame can approach
 * ~27 MiB. 32 MiB leaves envelope headroom. `/ws/node` stays at 16 MiB
 * (`NODE_MAX_FRAME_BYTES`).
 */
export const WS_OPERATOR_MAX_PAYLOAD = 32 * 1024 * 1024;

const jsonPublic = express.json({ limit: JSON_LIMIT_PUBLIC });
export const jsonAuthed = express.json({ limit: JSON_LIMIT_AUTHED });

/** `/auth/*` and public node enroll — always the small cap. */
export function isPublicJsonPath(path: string): boolean {
  return path === '/auth' || path.startsWith('/auth/') || path === '/node/enroll';
}

/**
 * Dual-auth / bearer / node-tunnel routes mounted before `requireAuth`.
 * Cookie-only paths (files, drafts, settings, …) must NOT match so the
 * 25mb parser after `requireAuth` is the first to run.
 */
export function isPreAuthJsonPath(path: string): boolean {
  if (path === '/spawn' || path.startsWith('/spawn/')) return true;
  if (path === '/agent' || path.startsWith('/agent/')) return true;
  if (path === '/schedules' || path.startsWith('/schedules/')) return true;
  if (/^\/projects\/[^/]+\/schedules\/agent$/.test(path)) return true;
  if (/^\/conversations\/[^/]+\/timers\/agent$/.test(path)) return true;
  if (path === '/tasks/agent' || path.startsWith('/tasks/agent/')) return true;
  if (/^\/conversations\/[^/]+\/tasks\/agent(?:\/|$)/.test(path)) return true;
  return false;
}

function hasTrustedIdentity(req: Request, res: Response, config: AuthConfig): boolean {
  if (config.disabled) return true;
  if (res.locals.nodeHostId) return true;
  const raw = req.headers.authorization;
  const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : undefined;
  if (token && peekSpawnToken(token)) return true;
  if (config.configured && verifySessionCookieHeader(req.headers.cookie, config.sessionSecret, undefined, { secure: config.cookieSecure })) {
    return true;
  }
  return false;
}

/**
 * Parse JSON before `requireAuth` only on public + dual-auth paths.
 * Unauthenticated dual-auth POSTs cap at 64kb; a live cookie / spawn token /
 * node host id raises that to 25mb so plugin images and MCP JSON still work.
 * All other paths skip parsing here (so a 5mb draft cannot 413 at a 64kb
 * global parser) and are parsed by `jsonAuthed` after `requireAuth`.
 */
export function preAuthJson(config: AuthConfig): RequestHandler {
  return (req, res, next) => {
    if (isPublicJsonPath(req.path)) return jsonPublic(req, res, next);
    if (!isPreAuthJsonPath(req.path)) return next();
    if (hasTrustedIdentity(req, res, config)) return jsonAuthed(req, res, next);
    return jsonPublic(req, res, next);
  };
}
