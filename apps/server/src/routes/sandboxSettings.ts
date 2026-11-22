import type { Express, Request, Response } from 'express';
import express from 'express';
import { existsSync } from 'fs';
import os from 'os';
import type { Database } from 'better-sqlite3';
import {
  isSandboxDefaultRow,
  parseSandboxPathList,
  resolveSandbox,
  type EffectivePath,
  type SandboxDefaultRow,
  type SandboxSettings,
} from '@tierwyn/shared';
import { SANDBOX_PROFILES } from '../sandbox/profiles.js';
import { getSandboxSettings, putSandboxSettings } from '../repositories/sandboxSettings.js';
import { getRemoteHost, listRemoteHosts } from '../repositories/remoteHosts.js';
import { getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { dbPathFromEnv } from '../config/env.js';
import {
  hubDataDir,
  hubTierwynRoot,
  statusCustomPath,
  type CustomPathCtx,
} from '../sandbox/customPaths.js';

export interface SandboxSettingsRouteDeps {
  getDb: () => Database;
  sessionManager?: {
    activeSessions(): Array<{ conversationId: string; agentType: string; sandbox?: boolean }>;
    reapParkedSessions(conversationId: string, opts?: { all?: boolean }): Promise<void>;
  };
  remoteStat?: (hostId: string, path: string) => Promise<{ exists: boolean } | null>;
}

function knownHostIds(db: Database): Set<string> {
  const ids = new Set<string>(['hub', '*']);
  for (const h of listRemoteHosts(db)) ids.add(h.id);
  return ids;
}

function knownAgentTypes(): Set<string> {
  return new Set(['*', ...Object.keys(SANDBOX_PROFILES)]);
}

function parseDocument(
  body: unknown,
  db: Database,
): { ok: true; settings: SandboxSettings } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const raw = body as Record<string, unknown>;
  if (typeof raw.global !== 'boolean') return { ok: false, error: 'global must be a boolean' };
  if (!Array.isArray(raw.defaults)) return { ok: false, error: 'defaults must be an array' };
  const hosts = knownHostIds(db);
  const agents = knownAgentTypes();
  const defaults: SandboxDefaultRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.defaults.length; i++) {
    const row = raw.defaults[i];
    if (!isSandboxDefaultRow(row)) return { ok: false, error: `defaults[${i}] invalid` };
    if (row.hostId === '*' && row.agentType === '*') {
      return { ok: false, error: `defaults[${i}] * × * is the global default; omit this row` };
    }
    if (!hosts.has(row.hostId)) return { ok: false, error: `unknown hostId '${row.hostId}'` };
    if (!agents.has(row.agentType)) return { ok: false, error: `unknown agentType '${row.agentType}'` };
    const key = `${row.hostId}\0${row.agentType}`;
    if (seen.has(key)) return { ok: false, error: `duplicate default ${row.hostId} × ${row.agentType}` };
    seen.add(key);
    defaults.push({ hostId: row.hostId, agentType: row.agentType, setting: row.setting });
  }
  if (raw.hostPaths !== undefined && (typeof raw.hostPaths !== 'object' || raw.hostPaths === null || Array.isArray(raw.hostPaths))) {
    return { ok: false, error: 'hostPaths must be an object' };
  }
  const hostPaths: SandboxSettings['hostPaths'] = {};
  for (const [hostId, paths] of Object.entries((raw.hostPaths ?? {}) as Record<string, unknown>)) {
    if (hostId === '*' || !hosts.has(hostId)) return { ok: false, error: `unknown hostPaths key '${hostId}'` };
    const parsed = parseSandboxPathList(paths);
    if (!parsed.ok) return { ok: false, error: `hostPaths.${hostId}: ${parsed.error}` };
    if (parsed.paths) hostPaths[hostId] = parsed.paths;
  }
  return { ok: true, settings: { global: raw.global, defaults, hostPaths } };
}

async function reapFlipped(
  db: Database,
  deps: SandboxSettingsRouteDeps,
  previous: SandboxSettings,
  next: SandboxSettings,
): Promise<void> {
  const sm = deps.sessionManager;
  if (!sm) return;
  const seen = new Set<string>();
  for (const s of sm.activeSessions()) {
    if (seen.has(s.conversationId)) continue;
    const conv = getConversation(db, s.conversationId);
    if (!conv) continue;
    const project = getProject(db, conv.projectId);
    if (!project) continue;
    const input = {
      conv: conv.sandbox,
      project: project.sandbox,
      hostId: project.remoteHostId ?? 'hub',
      agentType: s.agentType,
    };
    const oldOn = resolveSandbox({ ...input, settings: previous }).on;
    const newOn = resolveSandbox({ ...input, settings: next }).on;
    if (oldOn === newOn) continue;
    seen.add(s.conversationId);
    await sm.reapParkedSessions(s.conversationId, { all: true });
  }
}

export function registerSandboxSettingsRoutes(app: Express, deps: SandboxSettingsRouteDeps): void {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));

  r.get('/sandbox', (_req, res) => {
    res.json({ settings: getSandboxSettings(deps.getDb()) });
  });

  r.post('/sandbox', async (req: Request, res: Response) => {
    const db = deps.getDb();
    const parsed = parseDocument(req.body, db);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const previous = getSandboxSettings(db);
    const saved = putSandboxSettings(db, parsed.settings);
    await reapFlipped(db, deps, previous, saved);
    res.json({ settings: saved });
  });

  app.use('/settings', r);

  app.post('/sandbox/validate-paths', async (req: Request, res: Response) => {
    const db = deps.getDb();
    const body = req.body as { hostId?: unknown; paths?: unknown } | null;
    const hostId = typeof body?.hostId === 'string' ? body.hostId : '';
    if (!hostId || hostId === '*' || !knownHostIds(db).has(hostId)) {
      res.status(400).json({ error: 'unknown hostId' });
      return;
    }
    const parsed = parseSandboxPathList(body?.paths ?? []);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, entries: parsed.entries });
      return;
    }
    const paths = parsed.paths ?? [];
    const ctx = validateCtx(db, hostId);
    const out: EffectivePath[] = [];
    for (const p of paths) {
      const exists = await pathExists(hostId, p.path, deps);
      const st = statusCustomPath(p, ctx, () => exists);
      out.push({
        path: p.path,
        mode: p.mode,
        optional: p.optional,
        from: 'host',
        status: st.status,
        ...(st.reason ? { reason: st.reason } : {}),
      });
    }
    res.json({ paths: out });
  });
}

function validateCtx(db: Database, hostId: string): CustomPathCtx {
  if (hostId === 'hub') {
    return {
      home: os.homedir(),
      cwd: process.cwd(),
      repoRoot: hubTierwynRoot(),
      agentType: '',
      dataDir: hubDataDir(dbPathFromEnv()),
      pathEnv: process.env.PATH,
    };
  }
  const hello = getRemoteHost(db, hostId)?.hello ?? {};
  return {
    home: hello.homedir ?? os.homedir(),
    cwd: hello.roots?.[0] ?? hello.homedir ?? '/',
    repoRoot: '/.__tierwyn_hub_repo__',
    agentType: '',
    roots: hello.roots ?? [],
    pathEnv: '',
  };
}

async function pathExists(
  hostId: string,
  path: string,
  deps: SandboxSettingsRouteDeps,
): Promise<boolean> {
  if (hostId === 'hub') return existsSync(path);
  if (!deps.remoteStat) return false;
  try {
    const st = await deps.remoteStat(hostId, path);
    return st?.exists === true;
  } catch {
    return false;
  }
}
