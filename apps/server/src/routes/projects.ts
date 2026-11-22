import { existsSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import type {
  CreateProjectRequest, ProjectsResponse, NodeHello,
  AgentStatus, FsMoveResult, MoveProjectErrorCode, MoveProjectRequest, MoveProjectResponse, Project,
} from '@tierwyn/shared';
import { isCloneUrlAllowed, hostHasFeature, parseSandboxPathList, type SandboxPath } from '@tierwyn/shared';
import { createProject, getProject, listProjects, updateProject, moveProjectRoot } from '../repositories/projects.js';
import { getConversation } from '../repositories/conversations.js';
import { getRemoteHost, type RemoteHostRow } from '../repositories/remoteHosts.js';
import { RpcError } from '../node/rpc.js';
import { loadProjectRules, normaliseRules, renderedRules } from '../spawn/rules.js';
import { normalisePresetIds } from '../repositories/rulePresets.js';
import { fsClone, fsMkdir } from '../node/clone.js';
import { fsMove } from '../node/move.js';
import { beginProjectMove, endProjectMove } from '../projectMove.js';
import { isParkedSession } from '../activeAgents.js';
import { hubProjectRoots } from './projectBrowse.js';
import { buildChildEnv } from '../childEnv.js';
import { hubRootGuard } from '../hubMode.js';

/** Longest project name accepted by PATCH. Sidebar rows get unreadable well
 *  before this; the cap only exists so a paste bomb cannot land in the DB.
 *  ponytail: POST /projects stays uncapped — out of FW-14 scope. */
const MAX_NAME_LENGTH = 200;

export interface ProjectNodeHub {
  isConnected(id: string): boolean;
  view(row: { id: string }): { state: string; hello?: Partial<NodeHello> };
  link(id: string): { request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> };
}

export function cloneErrorResponse(
  code: string | undefined,
  message: string,
  where: 'host' | 'server',
): [number, string] {
  if (code === 'bad_url' || code === 'bad_path') {
    return [400, message];
  }
  if (code === 'path_outside_roots') {
    return [
      400,
      where === 'host'
        ? "rootPath's parent is outside the host's allowed roots"
        : "rootPath's parent is outside the allowed project roots (TIERWYN_PROJECT_ROOTS)",
    ];
  }
  if (code === 'exists') {
    return [
      400,
      where === 'host'
        ? 'rootPath already exists on host — if a previous clone finished, create the project without Clone from URL'
        : 'rootPath already exists — create the project without Clone from URL',
    ];
  }
  if (code === 'busy') {
    return [409, 'a clone into that path is already running'];
  }
  if (code === 'clone_failed') {
    return [400, `git clone failed: ${message}`];
  }
  if (code === 'no_method') {
    return [400, 'update tierwyn node on the host to clone'];
  }
  return [400, where === 'host' ? 'host not connected' : `could not create folder: ${message}`];
}

/**
 * GET/POST /projects plus PATCH /projects/:id. DELETE stays in index.ts
 * because it needs SessionManager to stop live sessions first.
 */
export function registerProjectMutationRoutes(
  app: Express,
  getDb: () => Database,
  nodeHub?: ProjectNodeHub,
  opts?: {
    sessions?: {
      activeSessions(): Array<{ id: string; conversationId: string; lastStatus?: AgentStatus; steerQueue: unknown[] }>;
      reapParkedSessions(conversationId: string, opts?: { all?: boolean }): Promise<void>;
    };
    localClone?: typeof fsClone;
    localMove?: typeof fsMove;
    moveRoot?: typeof moveProjectRoot;
    hubRoots?: () => string[];
  },
): void {
  app.get('/projects', (_req, res) => {
    const body: ProjectsResponse = { projects: listProjects(getDb()) };
    res.json(body);
  });

  app.post('/projects', async (req, res) => {
    try {
      const { name, rootPath, remoteHostId, cloneUrl, createIfMissing } = (req.body ?? {}) as CreateProjectRequest;
      if (!name || !rootPath) { res.status(400).json({ error: 'name and rootPath required' }); return; }
      if (!isAbsolute(rootPath)) {
        res.status(400).json({ error: 'rootPath must be an absolute path (leading /)' });
        return;
      }
      if (typeof remoteHostId === 'string' && remoteHostId) {
        const row = getRemoteHost(getDb(), remoteHostId);
        if (!row || row.status !== 'trusted' || !nodeHub || !nodeHub.isConnected(row.id) || nodeHub.view(row).state !== 'connected') {
          res.status(400).json({ error: 'host not connected' });
          return;
        }
        const view = nodeHub.view(row);
        let stat: { exists?: boolean; isDir?: boolean; underRoots?: boolean };

        if (cloneUrl !== undefined) {
          // Clone on the host BEFORE statPath so the fresh checkout passes the
          // exists/isDir/underRoots checks below.
          if (!isCloneUrlAllowed(cloneUrl)) {
            res.status(400).json({ error: 'clone URL not allowed (https without credentials, ssh://, or git@host:path)' });
            return;
          }
          try {
            await nodeHub.link(row.id).request('fs.clone', { url: cloneUrl, root: rootPath }, 6 * 60_000);
          } catch (e) {
            const code = e instanceof RpcError ? e.code : undefined;
            const message = e instanceof RpcError ? e.message : String(e);
            const [status, error] = cloneErrorResponse(code, message, 'host');
            res.status(status).json({ error });
            return;
          }
          try {
            stat = await nodeHub.link(row.id).request('fs.statPath', { path: rootPath });
          } catch {
            res.status(400).json({ error: 'host not connected' });
            return;
          }
        } else {
          try {
            stat = await nodeHub.link(row.id).request('fs.statPath', { path: rootPath });
          } catch {
            res.status(400).json({ error: 'host not connected' });
            return;
          }

          if (createIfMissing === true && !stat.exists) {
            if (!hostHasFeature(view.hello, 'fs.mkdir')) {
              res.status(501).json({ error: 'update tierwyn node on the host to create folders', code: 'node_update_required' });
              return;
            }
            try {
              await nodeHub.link(row.id).request('fs.mkdir', { path: rootPath }, 15_000);
            } catch (e) {
              const code = e instanceof RpcError ? e.code : undefined;
              const message = e instanceof RpcError ? e.message : String(e);
              if (code === 'bad_path') {
                res.status(400).json({ error: message });
                return;
              }
              if (code === 'path_outside_roots') {
                res.status(400).json({ error: "parent folder must exist inside the host's allowed roots" });
                return;
              }
              if (code === 'exists') {
                res.status(400).json({ error: 'rootPath exists and is not a directory' });
                return;
              }
              if (code === 'mkdir_failed') {
                res.status(400).json({ error: `could not create folder: ${message}` });
                return;
              }
              if (code === 'no_method') {
                res.status(501).json({ error: 'update tierwyn node on the host to create folders', code: 'node_update_required' });
                return;
              }
              res.status(400).json({ error: e instanceof RpcError ? (message || 'could not create folder') : 'host not connected' });
              return;
            }
            try {
              stat = await nodeHub.link(row.id).request('fs.statPath', { path: rootPath });
            } catch {
              res.status(400).json({ error: 'host not connected' });
              return;
            }
          }
        }
        if (!stat.exists || !stat.isDir) {
          res.status(400).json({ error: 'rootPath does not exist on host' });
          return;
        }
        if (!stat.underRoots) {
          res.status(400).json({ error: "rootPath is outside the host's allowed roots" });
          return;
        }
        res.json({ project: createProject(getDb(), { name, rootPath, remoteHostId: row.id }) });
        return;
      }
      {
        const hubErr = hubRootGuard(rootPath);
        if (hubErr) { res.status(400).json({ error: hubErr }); return; }
      }

      // Local
      if (cloneUrl !== undefined) {
        if (!isCloneUrlAllowed(cloneUrl)) {
          res.status(400).json({ error: 'clone URL not allowed (https without credentials, ssh://, or git@host:path)' });
          return;
        }
        const roots = (opts?.hubRoots ?? hubProjectRoots)();
        if (roots.length === 0) {
          res.status(400).json({ error: 'local clone is disabled (TIERWYN_PROJECT_ROOTS is empty)' });
          return;
        }
        try {
          const cloner = opts?.localClone ?? ((r, p, o) => fsClone(r, p, { ...o, env: buildChildEnv() }));
          await cloner(roots, { url: cloneUrl, root: rootPath });
        } catch (e) {
          if (e instanceof RpcError) {
            const [status, error] = cloneErrorResponse(e.code, e.message, 'server');
            res.status(status).json({ error });
            return;
          }
          const code = (e as NodeJS.ErrnoException).code;
          const message = (e as Error).message;
          res.status(400).json({ error: `could not create folder: ${code ?? message}` });
          return;
        }
        res.json({ project: createProject(getDb(), { name, rootPath }) });
        return;
      }

      if (!existsSync(rootPath)) {
        if (createIfMissing === true) {
          const roots = (opts?.hubRoots ?? hubProjectRoots)();
          if (roots.length === 0) {
            res.status(400).json({ error: 'folder creation is disabled (TIERWYN_PROJECT_ROOTS is empty)' });
            return;
          }
          try {
            fsMkdir(roots, { path: rootPath });
          } catch (e) {
            if (e instanceof RpcError) {
              if (e.code === 'bad_path') {
                res.status(400).json({ error: e.message });
                return;
              }
              if (e.code === 'path_outside_roots') {
                res.status(400).json({ error: 'parent folder must exist inside the allowed project roots' });
                return;
              }
              if (e.code === 'exists') {
                if (existsSync(rootPath) && statSync(rootPath).isDirectory()) {
                  // EEXIST race handled
                } else {
                  res.status(400).json({ error: 'rootPath already exists and is not a directory' });
                  return;
                }
              } else {
                res.status(400).json({ error: e.message });
                return;
              }
            } else {
              res.status(400).json({ error: `could not create folder: ${(e as Error).message}` });
              return;
            }
          }
          res.json({ project: createProject(getDb(), { name, rootPath }) });
          return;
        }
        res.status(400).json({ error: `rootPath does not exist on disk: ${rootPath}` });
        return;
      }

      res.json({ project: createProject(getDb(), { name, rootPath }) });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.patch('/projects/:id', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown; rootPath?: unknown; rules?: unknown; rulePresetIds?: unknown; remoteHostId?: unknown;
      trustRepoConfig?: unknown; sandbox?: unknown; sandboxPaths?: unknown;
      agentSearchScope?: unknown;
    };
    if (Object.prototype.hasOwnProperty.call(body, 'remoteHostId')) {
      res.status(400).json({ error: 'remoteHostId is set at create only' });
      return;
    }
    const nameProvided = Object.prototype.hasOwnProperty.call(body, 'name');
    const pathProvided = Object.prototype.hasOwnProperty.call(body, 'rootPath');
    const rulesProvided = Object.prototype.hasOwnProperty.call(body, 'rules');
    const presetsProvided = Object.prototype.hasOwnProperty.call(body, 'rulePresetIds');
    const trustRepoConfigProvided = Object.prototype.hasOwnProperty.call(body, 'trustRepoConfig');
    const sandboxProvided = Object.prototype.hasOwnProperty.call(body, 'sandbox');
    const sandboxPathsProvided = Object.prototype.hasOwnProperty.call(body, 'sandboxPaths');
    const agentSearchScopeProvided = Object.prototype.hasOwnProperty.call(body, 'agentSearchScope');

    if (nameProvided && typeof body.name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }
    if (pathProvided && typeof body.rootPath !== 'string') {
      res.status(400).json({ error: 'rootPath required' });
      return;
    }
    if (trustRepoConfigProvided && typeof body.trustRepoConfig !== 'boolean') {
      res.status(400).json({ error: 'trustRepoConfig must be a boolean' });
      return;
    }
    if (sandboxProvided) {
      const s = body.sandbox;
      if (s !== null && s !== 'on' && s !== 'off') {
        res.status(400).json({ error: 'sandbox must be "on", "off" or null' });
        return;
      }
    }
    if (agentSearchScopeProvided) {
      const s = body.agentSearchScope;
      if (s !== null && s !== 'off' && s !== 'project' && s !== 'all') {
        res.status(400).json({ error: 'agentSearchScope must be "off", "project", "all" or null' });
        return;
      }
    }
    let sandboxPaths: SandboxPath[] | null | undefined;
    if (sandboxPathsProvided) {
      const parsed = parseSandboxPathList(body.sandboxPaths);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, entries: parsed.entries });
        return;
      }
      sandboxPaths = parsed.paths;
    }
    if (!nameProvided && !pathProvided && !rulesProvided && !presetsProvided && !trustRepoConfigProvided && !sandboxProvided && !sandboxPathsProvided && !agentSearchScopeProvided) {
      res.status(400).json({ error: 'name, rootPath, rules, rulePresetIds, trustRepoConfig, sandbox, sandboxPaths, or agentSearchScope required' });
      return;
    }

    let name: string | undefined;
    if (nameProvided) {
      name = (body.name as string).trim();
      if (!name) { res.status(400).json({ error: 'name required' }); return; }
      if (name.length > MAX_NAME_LENGTH) {
        res.status(400).json({ error: `name too long (max ${MAX_NAME_LENGTH})` });
        return;
      }
    }

    let rootPath: string | undefined;
    if (pathProvided) {
      rootPath = (body.rootPath as string).trim();
      if (!rootPath) { res.status(400).json({ error: 'rootPath required' }); return; }
      if (!isAbsolute(rootPath)) {
        res.status(400).json({ error: 'rootPath must be an absolute path (leading /)' });
        return;
      }
    }

    let rules: string | null | undefined;
    if (rulesProvided) {
      const parsed = normaliseRules(body.rules);
      if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
      rules = parsed.value;
    }

    const existing = getProject(getDb(), req.params.id);
    if (!existing) { res.status(404).json({ error: 'no such project' }); return; }
    if (existing.system) {
      res.status(409).json({ error: (rulesProvided || presetsProvided) && !nameProvided && !pathProvided
        ? 'system project cannot have rules'
        : 'system project cannot be renamed' });
      return;
    }
    if (pathProvided && existing.remoteHostId) {
      res.status(409).json({ error: 'rootPath of a remote-host project cannot change in P1' });
      return;
    }
    if (pathProvided && !existsSync(rootPath!)) {
      res.status(400).json({ error: `rootPath does not exist on disk: ${rootPath}` });
      return;
    }
    if (pathProvided && !existing.remoteHostId) {
      const hubErr = hubRootGuard(rootPath!);
      if (hubErr) { res.status(400).json({ error: hubErr }); return; }
    }

    let rulePresetIds: string[] | null | undefined;
    if (presetsProvided) {
      const parsed = normalisePresetIds(getDb(), body.rulePresetIds, existing.id);
      if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
      rulePresetIds = parsed.value;
    }

    const project = updateProject(getDb(), req.params.id, {
      name, rootPath,
      ...(rulesProvided ? { rules } : {}),
      ...(presetsProvided ? { rulePresetIds } : {}),
      ...(trustRepoConfigProvided ? { trustRepoConfig: body.trustRepoConfig as boolean } : {}),
      ...(sandboxProvided ? { sandbox: body.sandbox as import('@tierwyn/shared').SandboxSetting | null } : {}),
      ...(sandboxPathsProvided ? { sandboxPaths } : {}),
      ...(agentSearchScopeProvided ? { agentSearchScope: body.agentSearchScope as import('@tierwyn/shared').AgentSearchScopeSetting | null } : {}),
    });
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }

    if (((trustRepoConfigProvided && body.trustRepoConfig !== existing.trustRepoConfig)
      || sandboxProvided || sandboxPathsProvided) && opts?.sessions) {
      const db = getDb();
      const active = opts.sessions.activeSessions();
      const convIds = [...new Set(
        active
          .filter((s) => {
            const conv = getConversation(db, s.conversationId);
            return conv && conv.projectId === existing.id;
          })
          .map((s) => s.conversationId)
      )];
      await Promise.all(convIds.map((cid) => opts.sessions!.reapParkedSessions(cid, { all: true })));
    }

    res.json({ project });
  });

  app.post('/projects/:id/move', async (req, res) => {
    try {
      const { rootPath, dryRun } = (req.body ?? {}) as MoveProjectRequest;
      if (typeof rootPath !== 'string' || !rootPath || !isAbsolute(rootPath) || rootPath.includes('\0')) {
        res.status(400).json({ error: 'rootPath must be an absolute path (leading /)', code: 'bad_path' });
        return;
      }
      const to = resolve(rootPath.trim());

      const db = getDb();
      const project = getProject(db, req.params.id);
      if (!project) {
        res.status(404).json({ error: 'no such project', code: 'not_found' });
        return;
      }
      if (project.system) {
        res.status(409).json({ error: 'system project cannot be moved', code: 'system_project' });
        return;
      }
      if (!project.remoteHostId) {
        const hubErr = hubRootGuard(to);
        if (hubErr) { res.status(400).json({ error: hubErr, code: 'bad_path' }); return; }
      }
      const from = project.rootPath;
      if (to === from) {
        res.status(400).json({ error: 'target is the same as current project path', code: 'same_path' });
        return;
      }

      // contains_other_project: any other project on the same host whose rootPath === from or starts with from + '/'
      const allProjects = listProjects(db);
      const otherProject = allProjects.find((p) =>
        p.id !== project.id &&
        (p.remoteHostId ?? null) === (project.remoteHostId ?? null) &&
        (p.rootPath === from || p.rootPath.startsWith(from + '/'))
      );
      if (otherProject) {
        res.status(400).json({
          error: `another project (${otherProject.name}) lives inside this folder`,
          code: 'contains_other_project',
        });
        return;
      }

      if (!opts?.sessions) {
        res.status(500).json({ error: 'move unavailable', code: 'move_failed' });
        return;
      }

      const activeSessions = opts.sessions.activeSessions();
      const projectSessions: Array<{ id: string; conversationId: string; lastStatus?: AgentStatus; steerQueue: unknown[] }> = [];
      for (const s of activeSessions) {
        const conv = getConversation(db, s.conversationId);
        if (conv && conv.projectId === project.id) {
          projectSessions.push(s);
        }
      }

      const live = projectSessions.filter((s) =>
        !isParkedSession({ lastStatus: s.lastStatus, steerQueueLength: s.steerQueue.length })
      );
      if (live.length > 0) {
        const conversations = live.map((s) => {
          const conv = getConversation(db, s.conversationId);
          return {
            conversationId: s.conversationId,
            title: conv?.title ?? s.conversationId.slice(0, 8),
          };
        });
        const titles = conversations.map((c) => c.title).join(', ');
        res.status(409).json({
          error: `Cannot move: ${live.length} agent(s) active in this project (${titles})`,
          code: 'agents_active',
          conversations,
        });
        return;
      }

      const parkedConvIds = [...new Set(projectSessions.map((s) => s.conversationId))];

      let remoteRow: RemoteHostRow | undefined;
      let remoteView: ReturnType<ProjectNodeHub['view']> | undefined;
      if (project.remoteHostId) {
        remoteRow = getRemoteHost(db, project.remoteHostId);
        if (!remoteRow || remoteRow.status !== 'trusted' || !nodeHub || !nodeHub.isConnected(remoteRow.id) || nodeHub.view(remoteRow).state !== 'connected') {
          res.status(409).json({ error: 'remote host is not connected', code: 'host_disconnected' });
          return;
        }
        remoteView = nodeHub.view(remoteRow);
        if (!hostHasFeature(remoteView.hello, 'fs.move')) {
          res.status(501).json({ error: 'update tierwyn node on the host to move folders', code: 'node_update_required' });
          return;
        }
      }

      if (dryRun) {
        let dryResult: FsMoveResult;
        if (!project.remoteHostId) {
          const roots = (opts?.hubRoots ?? hubProjectRoots)();
          const doLocalMove = opts?.localMove ?? fsMove;
          dryResult = doLocalMove(roots, { from, to, dryRun: true });
        } else {
          dryResult = await nodeHub!.link(remoteRow!.id).request<FsMoveResult>('fs.move', { from, to, dryRun: true }, 60_000);
        }
        const response: MoveProjectResponse = {
          project,
          from,
          to: dryResult.path,
          moved: false,
        };
        res.json(response);
        return;
      }

      if (!beginProjectMove(project.id)) {
        res.status(409).json({ error: "This project's folder is already being moved", code: 'move_in_progress' });
        return;
      }

      try {
        await Promise.all(parkedConvIds.map((cid) => opts.sessions!.reapParkedSessions(cid, { all: true })));

        const recheckSessions = opts.sessions.activeSessions();
        const recheckLive = recheckSessions.filter((s) => {
          const conv = getConversation(db, s.conversationId);
          return conv && conv.projectId === project.id && !isParkedSession({ lastStatus: s.lastStatus, steerQueueLength: s.steerQueue.length });
        });
        if (recheckLive.length > 0) {
          const conversations = recheckLive.map((s) => {
            const conv = getConversation(db, s.conversationId);
            return { conversationId: s.conversationId, title: conv?.title ?? s.conversationId.slice(0, 8) };
          });
          const titles = conversations.map((c) => c.title).join(', ');
          res.status(409).json({
            error: `Cannot move: ${recheckLive.length} agent(s) active in this project (${titles})`,
            code: 'agents_active',
            conversations,
          });
          return;
        }

        let moveResult: FsMoveResult;
        if (!project.remoteHostId) {
          const roots = (opts?.hubRoots ?? hubProjectRoots)();
          const doLocalMove = opts?.localMove ?? fsMove;
          moveResult = doLocalMove(roots, { from, to });
        } else {
          const link = nodeHub!.link(remoteRow!.id);
          try {
            moveResult = await link.request<FsMoveResult>('fs.move', { from, to }, 60_000);
          } catch (err: unknown) {
            if (err instanceof RpcError && (err.code === 'timeout' || err.code === 'host_disconnected')) {
              let statTo: { exists?: boolean } | undefined;
              let statFrom: { exists?: boolean } | undefined;
              try {
                statTo = await link.request<{ exists?: boolean }>('fs.statPath', { path: to });
                statFrom = await link.request<{ exists?: boolean }>('fs.statPath', { path: from });
              } catch {
                /* ignore stat failure */
              }
              if (statTo?.exists && !statFrom?.exists) {
                moveResult = { path: to, moved: true };
              } else if (statFrom?.exists && !statTo?.exists) {
                res.status(409).json({ error: 'remote host disconnected during move; folder was not moved', code: 'host_disconnected' });
                return;
              } else {
                res.status(500).json({ error: `move state unknown: could not verify whether folder moved from ${from} to ${to}`, code: 'move_state_unknown' });
                return;
              }
            } else {
              throw err;
            }
          }
        }

        const doMoveRoot = opts?.moveRoot ?? moveProjectRoot;
        let updatedProject: Project | undefined;
        try {
          updatedProject = doMoveRoot(db, project.id, from, moveResult.path);
        } catch (dbErr: unknown) {
          let rollbackOk = false;
          try {
            if (!project.remoteHostId) {
              const roots = (opts?.hubRoots ?? hubProjectRoots)();
              const doLocalMove = opts?.localMove ?? fsMove;
              doLocalMove(roots, { from: moveResult.path, to: from });
              rollbackOk = true;
            } else {
              await nodeHub!.link(remoteRow!.id).request<FsMoveResult>('fs.move', { from: moveResult.path, to: from }, 60_000);
              rollbackOk = true;
            }
          } catch {
            rollbackOk = false;
          }
          if (rollbackOk) {
            res.status(500).json({ error: 'database update failed; folder moved back', code: 'move_failed' });
          } else {
            res.status(500).json({
              error: `folder is now at ${moveResult.path} but the project still points at ${from}; edit the project path to ${moveResult.path} to re-point`,
              code: 'rollback_failed',
            });
          }
          return;
        }

        const response: MoveProjectResponse = {
          project: updatedProject!,
          from,
          to: moveResult.path,
          moved: true,
          ...(moveResult.repairError ? { repairWarning: 'git worktree links could not be repaired: ' + moveResult.repairError } : {}),
        };
        res.json(response);
      } finally {
        endProjectMove(project.id);
      }
    } catch (err: unknown) {
      if (res.headersSent) return;
      if (err instanceof RpcError) {
        const code = err.code as MoveProjectErrorCode;
        let status = 500;
        if ([
          'bad_path', 'path_outside_roots', 'not_found', 'not_dir',
          'source_symlink', 'source_is_root', 'parent_missing', 'exists',
          'into_self', 'same_path', 'cross_device', 'contains_other_project',
        ].includes(code)) {
          status = 400;
        } else if (code === 'agents_active' || code === 'move_in_progress' || code === 'host_disconnected' || code === 'system_project') {
          status = 409;
        } else if (code === 'node_update_required') {
          status = 501;
        }
        res.status(status).json({ error: err.message, code });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'move_failed' });
    }
  });

  app.get('/projects/:id/rules', (req, res) => {
    const db = getDb();
    const project = getProject(db, req.params.id);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    const view = loadProjectRules(db, project);
    res.json({
      rendered: view ? renderedRules(view) : '',
      hash: view?.hash ?? null,
      omitted: view?.omitted ?? 0,
    });
  });
}
