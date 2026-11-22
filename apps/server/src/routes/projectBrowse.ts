import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import { hostHasFeature, type NodeHello, type ProjectBrowseRoots, type ProjectBrowseListing, type ProjectBrowseStat, type ProjectPathStat } from '@tierwyn/shared';
import type { RemoteHostRow } from '../repositories/remoteHosts.js';
import { getRemoteHost } from '../repositories/remoteHosts.js';
import { listUnderRoot } from '../files/listing.js';
import { remoteErrorStatus } from './files.js';
import { pathUnderRoots } from '../node/policy.js';
import { isGitRepo } from '../worktree.js';
import { envPrefFrom } from '../config/env.js';

export function hubProjectRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const val = envPrefFrom(env, 'PROJECT_ROOTS');
  if (val === undefined) {
    return [homedir()];
  }
  if (val === '') {
    return [];
  }
  return val
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isAbsolute(s))
    .map((s) => resolve(s));
}

export interface ProjectBrowseNodeHub {
  isConnected(id: string): boolean;
  view(row: RemoteHostRow): { state: string; hello?: Partial<NodeHello> };
  link(id: string): { request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> };
}

export function registerProjectBrowseRoutes(app: Express, deps: {
  getDb: () => Database;
  nodeHub?: ProjectBrowseNodeHub;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  function resolveHost(remoteHostId: string, res: Response): {
    host: RemoteHostRow;
    roots: string[];
    canCreate: boolean;
    nodeUpdateRequired: boolean;
    link: { request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> };
  } | null {
    const host = getRemoteHost(deps.getDb(), remoteHostId);
    if (!host) {
      res.status(404).json({ error: 'host not found' });
      return null;
    }
    if (host.status !== 'trusted' || !deps.nodeHub?.isConnected(host.id)) {
      res.status(409).json({ error: 'host is not connected' });
      return null;
    }
    const view = deps.nodeHub.view(host);
    if (view.state !== 'connected') {
      res.status(409).json({ error: 'host is not connected' });
      return null;
    }
    const roots = view.hello?.roots ?? [];
    const hasMkdir = hostHasFeature(view.hello, 'fs.mkdir');
    const canCreate = hasMkdir && roots.length > 0;
    const nodeUpdateRequired = roots.length > 0 && !hasMkdir;
    const link = deps.nodeHub.link(host.id);
    return { host, roots, canCreate, nodeUpdateRequired, link };
  }

  app.get('/project-browse/roots', async (req: Request, res: Response) => {
    try {
      const remoteHostId = typeof req.query.remoteHostId === 'string' && req.query.remoteHostId
        ? req.query.remoteHostId
        : undefined;

      if (remoteHostId) {
        const resolved = resolveHost(remoteHostId, res);
        if (!resolved) return;
        const resp: ProjectBrowseRoots = {
          roots: resolved.roots,
          canCreate: resolved.canCreate,
          canClone: true,
          homedir: deps.nodeHub?.view(resolved.host).hello?.homedir,
          ...(resolved.nodeUpdateRequired ? { nodeUpdateRequired: true } : {}),
        };
        return res.json(resp);
      }

      const roots = hubProjectRoots(deps.env);
      const resp: ProjectBrowseRoots = {
        roots,
        canCreate: roots.length > 0,
        canClone: roots.length > 0,
        homedir: homedir(),
      };
      return res.json(resp);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.get('/project-browse/list', async (req: Request, res: Response) => {
    try {
      const root = req.query.root;
      if (typeof root !== 'string' || !root) {
        return res.status(400).json({ error: 'root must be a non-empty string' });
      }
      const remoteHostId = typeof req.query.remoteHostId === 'string' && req.query.remoteHostId
        ? req.query.remoteHostId
        : undefined;
      const relPath = typeof req.query.path === 'string' ? req.query.path : undefined;

      if (remoteHostId) {
        const resolved = resolveHost(remoteHostId, res);
        if (!resolved) return;
        if (!resolved.roots.includes(root)) {
          return res.status(400).json({ error: 'root must be one of the allowed roots' });
        }
        try {
          const rpcRes = await resolved.link.request<{
            status: number;
            body: { root: string; path: string; entries: Array<{ name: string; kind: string; mtimeMs: number; symlink?: true }>; truncated: boolean } | { error: string };
          }>('files.list', { root, path: relPath }, 10_000);

          if (rpcRes.status !== 200) {
            return res.status(rpcRes.status).json(rpcRes.body);
          }
          const body = rpcRes.body as { root: string; path: string; entries: Array<{ name: string; kind: string; mtimeMs: number; symlink?: true }>; truncated: boolean };
          const dirs = (body.entries ?? [])
            .filter((e) => e.kind === 'dir')
            .map(({ name, mtimeMs, symlink }) => ({ name, mtimeMs, ...(symlink ? { symlink } : {}) }));
          const resp: ProjectBrowseListing = {
            root: body.root,
            path: body.path,
            dirs,
            truncated: body.truncated ?? false,
          };
          return res.json(resp);
        } catch (e) {
          const { status, error } = remoteErrorStatus(e);
          return res.status(status).json({ error });
        }
      }

      // Hub
      const roots = hubProjectRoots(deps.env);
      if (roots.length === 0) {
        return res.status(403).json({ error: 'no project roots configured' });
      }
      if (!roots.includes(root)) {
        return res.status(400).json({ error: 'root must be one of the allowed roots' });
      }
      const result = await listUnderRoot(root, relPath, deps.dataDir);
      if (result.status !== 200) {
        return res.status(result.status).json(result.body);
      }
      const body = result.body as { root: string; path: string; entries: Array<{ name: string; kind: string; mtimeMs: number; symlink?: true }>; truncated: boolean };
      const dirs = (body.entries ?? [])
        .filter((e) => e.kind === 'dir')
        .map(({ name, mtimeMs, symlink }) => ({ name, mtimeMs, ...(symlink ? { symlink } : {}) }));
      const resp: ProjectBrowseListing = {
        root: body.root,
        path: body.path,
        dirs,
        truncated: body.truncated ?? false,
      };
      return res.json(resp);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.get('/project-browse/stat', async (req: Request, res: Response) => {
    try {
      const p = String(req.query.path ?? '');
      if (!isAbsolute(p) || p.includes('\0') || p.length > 4096) {
        return res.status(400).json({ error: 'absolute path required' });
      }
      const roots = hubProjectRoots(deps.env);
      function statLocal(target: string): ProjectPathStat {
        const underRoots = pathUnderRoots(target, roots) !== null;
        if (!existsSync(target)) {
          return { exists: false, isDir: false, isGitRepo: false, underRoots };
        }
        try {
          const st = statSync(target);
          return {
            exists: true,
            isDir: st.isDirectory(),
            isGitRepo: isGitRepo(target),
            underRoots,
          };
        } catch {
          return { exists: false, isDir: false, isGitRepo: false, underRoots };
        }
      }
      const pathStat = statLocal(p);
      const parentStat = statLocal(dirname(p));
      const resp: ProjectBrowseStat = { path: pathStat, parent: parentStat };
      return res.json(resp);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });
}
