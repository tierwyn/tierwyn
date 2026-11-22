import { existsSync } from 'fs';
import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import type { ServerFrame } from '@tierwyn/shared';
import { hostHasFeature, isSidecarAgentBackend } from '@tierwyn/shared';
import type { SessionRecord } from '../sessionManager.js';
import {
  GitCommandError, isIndexLockError, readWorkingTree,
  addOperatorWorktree, isNonFastForwardError,
  type WorkingTreeReadResult,
} from '../git/workingTree.js';
import {
  WorkingTreeContextError, resolveWorkingTreeRequest,
  healWorkingTreesForRequest, resolveGitRequest, buildGitWorkingTreeStatus,
  liveAgentsFor, commitDraftKey,
  type ResolvedGitRequest,
} from '../git/workingTreeContext.js';
import { RemoteGitOps, type GitNodeHub } from '../git/remoteOps.js';
import { sidecarSiteReady } from '../sidecar.js';
import { getSidecarLlmSettings } from '../repositories/settings.js';
import { getRemoteHost, remoteHostIdFor } from '../repositories/remoteHosts.js';
import { generateCommitMessage } from '../commitMessage.js';
import {
  getCommitDraft, setCommitDraft, clearCommitDraft,
  beginCommitGeneration, cancelCommitGeneration, endCommitGeneration,
} from '../repositories/gitCommitDrafts.js';

export interface GitWorkingTreeRouteDeps {
  getDb: () => Database;
  getActiveSessions: () => SessionRecord[];
  broadcastAll?: (frame: ServerFrame) => void;
  nodeHub?: GitNodeHub;
}

/** Strip `//user:token@` credentials that git echoes from remote URLs in stderr. */
export function stripUrlCredentials(text: string): string {
  return text.replace(/\/\/[^@\s/]+@/g, '//');
}

function mapGitError(res: Response, err: GitCommandError): void {
  const status = isIndexLockError(err) ? 409 : 400;
  res.status(status).json({ error: stripUrlCredentials(err.stderr.trim()) || err.message });
}

function historyCtx(req: Request) {
  const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
  return { conversationId: q('conversationId'), projectId: q('projectId'), cwd: q('cwd') };
}

async function resolveRepo(
  db: Database,
  ctx: { conversationId?: string; projectId?: string; cwd?: string },
  nodeHub?: GitNodeHub,
  opts?: { isMutation?: boolean; requireCwd?: boolean },
): Promise<ResolvedGitRequest & { wt: WorkingTreeReadResult }> {
  const remoteHostId = remoteHostIdFor(db, ctx);
  if (opts?.isMutation && ctx.cwd && (opts.requireCwd !== false || remoteHostId)) {
    if (remoteHostId) {
      if (!nodeHub) throw new WorkingTreeContextError(503, 'remote host not connected');
      if (!(await new RemoteGitOps(nodeHub, remoteHostId).exists(ctx.cwd))) {
        throw new WorkingTreeContextError(404, `working tree directory does not exist: ${ctx.cwd}`);
      }
    } else if (!existsSync(ctx.cwd)) {
      throw new WorkingTreeContextError(404, `working tree directory does not exist: ${ctx.cwd}`);
    }
  }
  const resolved = await resolveGitRequest(db, ctx, nodeHub);
  const wt = await resolved.ops.readWorkingTree(resolved.cwd);
  if (!wt.isRepo) {
    throw new WorkingTreeContextError(400, 'not a git repository');
  }
  return { ...resolved, wt };
}

async function assertNoLiveAgents(
  db: Database,
  resolved: ResolvedGitRequest,
  sessions: SessionRecord[],
  verb: string,
): Promise<void> {
  const liveAgents = await liveAgentsFor(db, resolved, sessions);
  if (liveAgents.length > 0) {
    const titles = liveAgents.map((a) => a.title).join(', ');
    throw new WorkingTreeContextError(
      409,
      `Cannot ${verb}: ${liveAgents.length} agent(s) active on this checkout (${titles})`,
    );
  }
}

async function guardMutation(
  db: Database,
  resolved: ResolvedGitRequest & { wt: WorkingTreeReadResult },
  activeSessions: SessionRecord[],
  opts: { verb: string; clean?: boolean },
): Promise<void> {
  await assertNoLiveAgents(db, resolved, activeSessions, opts.verb);
  if (opts.clean && (resolved.wt.staged.length || resolved.wt.unstaged.length)) {
    throw new WorkingTreeContextError(
      409,
      'Cannot switch branch: working tree has uncommitted changes. Stash or commit first.',
    );
  }
  if (resolved.wt.hasConflicts) {
    throw new WorkingTreeContextError(409, 'unmerged paths; resolve conflicts first');
  }
}

function mutationCatch(res: Response, err: unknown, opts: { isNetworkOp?: boolean } = {}): void {
  if (err instanceof WorkingTreeContextError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof GitCommandError) {
    const sanitize = (text: string) => {
      let t = text.trim();
      if (opts.isNetworkOp) {
        t = t.replace(/\/\/[^@\s]+@/g, '//');
      }
      return t;
    };
    if (isNonFastForwardError(err)) {
      res.status(409).json({
        error: 'Fast-forward pull not possible: branch has diverged. Rebase or merge via terminal or agent.',
      });
      return;
    }
    if (/local changes would be overwritten/i.test(err.stderr)) {
      res.status(409).json({ error: sanitize(err.stderr) || err.message });
      return;
    }
    if (/already exists|already checked out|is already checked out|already used by worktree/i.test(err.stderr)) {
      res.status(409).json({ error: sanitize(err.stderr) || err.message });
      return;
    }
    if (isIndexLockError(err)) {
      res.status(409).json({ error: sanitize(err.stderr) || err.message });
      return;
    }
    if (/CONFLICT/i.test(err.stderr) || /CONFLICT/i.test(err.stdout)) {
      res.status(409).json({
        error: 'Stash applied with conflicts; stash entry kept. Resolve via terminal or agent.',
      });
      return;
    }
    if (/does not exist|unknown revision|bad object|branch not found/i.test(err.stderr)) {
      res.status(404).json({ error: sanitize(err.stderr) || err.message });
      return;
    }
    if (opts.isNetworkOp) {
      const sanitized = sanitize(err.stderr) || err.message;
      res.status(502).json({ error: sanitized });
      return;
    }
    mapGitError(res, err);
    return;
  }
  if (err instanceof Error) {
    if (err.message === 'branch not found' || err.message.startsWith('unknown ')) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (
      err.message === 'no common ancestor' ||
      err.message === 'folder already exists' ||
      err.message.includes('already exists') ||
      err.message.includes('shadowing remote')
    ) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err.message.includes('pathspec')) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err.message === 'worktree_outside_roots') {
      res.status(400).json({
        error: "worktree folder would be outside the host's roots — add the parent directory to roots in node.json",
      });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'internal error' });
}

function historyCatch(res: Response, err: unknown): void {
  if (err instanceof WorkingTreeContextError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof GitCommandError) {
    if (isIndexLockError(err)) {
      res.status(409).json({ error: err.stderr.trim() || err.message });
      return;
    }
    if (/does not exist|unknown revision|bad object/i.test(err.stderr)) {
      res.status(404).json({ error: err.stderr.trim() || err.message });
      return;
    }
    mapGitError(res, err);
    return;
  }
  if (err instanceof Error) {
    if (err.message.includes('pathspec')) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err.message === 'worktree_outside_roots') {
      res.status(400).json({
        error: "worktree folder would be outside the host's roots — add the parent directory to roots in node.json",
      });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'internal error' });
}

export function registerGitWorkingTreeRoutes(app: Express, deps: GitWorkingTreeRouteDeps): void {
  const { getDb, getActiveSessions, broadcastAll, nodeHub } = deps;

  app.get('/files/working-tree', async (req: Request, res: Response) => {
    try {
      const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;

      if (!conversationId?.trim() && !projectId?.trim()) {
        return res.status(400).json({ error: 'conversationId or projectId required' });
      }

      const db = getDb();
      healWorkingTreesForRequest(db, { conversationId, projectId });
      const resolved = await resolveGitRequest(db, { conversationId, projectId, cwd }, nodeHub);
      const status = await buildGitWorkingTreeStatus(db, resolved, getActiveSessions());
      const draft = getCommitDraft(db, commitDraftKey(resolved));
      res.json({
        ...status,
        commitMessageReady: sidecarSiteReady(db, 'commit'),
        commitMessage: draft.message,
        commitMessageGenerating: draft.generating,
      });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      if (err instanceof Error) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/stage', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; path?: string; conversationId?: string; projectId?: string };
      if (!body.cwd || !body.path) {
        return res.status(400).json({ error: 'cwd and path required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true, requireCwd: false });
      if (resolved.remoteHostId) await assertNoLiveAgents(db, resolved, getActiveSessions(), 'stage');
      const rel = await resolved.ops.validatePathspec(resolved.cwd, body.path);
      await resolved.ops.stagePath(resolved.cwd, rel);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      if (err instanceof Error && err.message.includes('pathspec')) {
        return res.status(403).json({ error: err.message });
      }
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/unstage', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; path?: string; conversationId?: string; projectId?: string };
      if (!body.cwd || !body.path) {
        return res.status(400).json({ error: 'cwd and path required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true, requireCwd: false });
      if (resolved.remoteHostId) await assertNoLiveAgents(db, resolved, getActiveSessions(), 'unstage');
      const rel = await resolved.ops.validatePathspec(resolved.cwd, body.path);
      await resolved.ops.unstagePath(resolved.cwd, rel);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      if (err instanceof Error && err.message.includes('pathspec')) {
        return res.status(403).json({ error: err.message });
      }
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/commit', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; message?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) return res.status(400).json({ error: 'cwd required' });
      const message = typeof body.message === 'string' ? body.message : '';
      if (message.trim().length === 0) {
        return res.status(400).json({ error: 'commit message required' });
      }
      if (Buffer.byteLength(message, 'utf8') > 65536) {
        return res.status(400).json({ error: 'commit message too long' });
      }

      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true, requireCwd: false });
      if (resolved.remoteHostId) await assertNoLiveAgents(db, resolved, getActiveSessions(), 'commit');
      if (resolved.wt.hasConflicts) return res.status(400).json({ error: 'unmerged paths; commit refused' });
      if (resolved.wt.staged.length === 0) return res.status(400).json({ error: 'nothing staged' });

      const sha = await resolved.ops.commitStaged(resolved.cwd, message.trim());
      clearCommitDraft(db, commitDraftKey(resolved));
      // Mirror POST generate: every client must converge on empty after commit,
      // otherwise a second tab's debounced PUT resurrects the committed text.
      broadcastAll?.({
        type: 'git_commit_draft_updated',
        cwd: resolved.cwd,
        message: '',
        generating: false,
      });
      res.json({ ok: true, sha });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.put('/files/working-tree/commit-message', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; message?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) return res.status(400).json({ error: 'cwd required' });
      const message = typeof body.message === 'string' ? body.message : '';
      if (Buffer.byteLength(message, 'utf8') > 65536) {
        return res.status(400).json({ error: 'commit message too long' });
      }
      const db = getDb();
      const resolved = await resolveGitRequest(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub);
      setCommitDraft(db, commitDraftKey(resolved), message);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) return res.status(err.status).json({ error: err.message });
      if (err instanceof GitCommandError) return mapGitError(res, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/commit-message', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) return res.status(400).json({ error: 'cwd required' });

      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub);
      if (resolved.wt.hasConflicts) return res.status(400).json({ error: 'unmerged paths; resolve conflicts first' });
      if (resolved.wt.staged.length === 0) return res.status(400).json({ error: 'nothing staged' });

      if (!sidecarSiteReady(db, 'commit')) {
        const route = getSidecarLlmSettings(db).commit;
        const error = route.enabled === false
          ? 'Commit message generation is disabled — enable it in Settings → Sidecar LLMs'
          : isSidecarAgentBackend(route.backend)
            ? 'Commit message LLM not configured — set Settings → Sidecar LLMs tab adapter/model'
            : 'Commit message LLM not configured — set Settings → Sidecar LLMs tab provider/model';
        return res.status(400).json({ error });
      }

      const now = Date.now();
      const draftKey = commitDraftKey(resolved);
      if (!beginCommitGeneration(db, draftKey, now)) {
        // Already running for this worktree — idempotent success (see D2).
        return res.json({ ok: true, generating: true });
      }

      const cwd = resolved.cwd;
      const staged = resolved.wt.staged.length;
      const ops = resolved.ops;
      const remoteHostId = resolved.remoteHostId;
      void (async () => {
        let message: string | undefined;
        let error: string | undefined;
        try {
          message = (await generateCommitMessage(db, cwd, staged, ops, remoteHostId)).message;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          console.warn('[commit-message] failed:', error);
        }
        // Settle must never reject — SQLITE_BUSY / closed connection here would
        // be an unhandledRejection and kill the process on Node ≥15.
        try {
          const updated = endCommitGeneration(db, draftKey, message, now);
          if (!updated) {
            // ponytail: row cleared by a concurrent commit or cancelled — skip settle broadcast;
            // commit or cancel already handled broadcasting.
            return;
          }
          broadcastAll?.({
            type: 'git_commit_draft_updated',
            cwd,
            message: message ?? getCommitDraft(db, draftKey).message,
            generating: false,
            ...(error ? { error } : {}),
          });
        } catch (err) {
          console.warn(
            '[commit-message] settle failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      })();

      res.json({ ok: true, generating: true });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/commit-message/cancel', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) return res.status(400).json({ error: 'cwd required' });

      const db = getDb();
      const resolved = await resolveGitRequest(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub);
      const draftKey = commitDraftKey(resolved);

      cancelCommitGeneration(db, draftKey);

      broadcastAll?.({
        type: 'git_commit_draft_updated',
        cwd: resolved.cwd,
        message: getCommitDraft(db, draftKey).message,
        generating: false,
      });

      res.json({ ok: true, cancelled: true });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/push', async (req: Request, res: Response) => {
    let isRemote = false;
    try {
      const body = req.body as { cwd?: string; remote?: string; conversationId?: string; projectId?: string };
      const db = getDb();
      isRemote = !!remoteHostIdFor(db, { conversationId: body.conversationId, projectId: body.projectId });
      if (!body.cwd) return res.status(400).json({ error: 'cwd required' });

      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true, requireCwd: false });
      if (resolved.wt.detached) return res.status(400).json({ error: 'cannot push detached HEAD' });

      const result = await resolved.ops.pushRemote(resolved.cwd, body.remote);
      res.json({ ok: true, remote: result.remote, branch: result.branch, output: result.output });
    } catch (err) {
      if (isRemote) {
        mutationCatch(res, err, { isNetworkOp: true });
        return;
      }
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      if (err instanceof Error) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/delete', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; path?: string; conversationId?: string; projectId?: string };
      if (!body.cwd || !body.path) {
        return res.status(400).json({ error: 'cwd and path required' });
      }

      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true, requireCwd: false });
      if (resolved.remoteHostId) await assertNoLiveAgents(db, resolved, getActiveSessions(), 'delete');

      const rel = await resolved.ops.validatePathspec(resolved.cwd, body.path);
      await resolved.ops.deleteUntrackedPath(resolved.cwd, rel);
      res.json({ ok: true, path: rel });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      if (err instanceof Error) {
        if (err.message.includes('pathspec')) return res.status(403).json({ error: err.message });
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/files/working-tree/discard', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; path?: string; conversationId?: string; projectId?: string };
      if (!body.cwd || !body.path) {
        return res.status(400).json({ error: 'cwd and path required' });
      }

      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true, requireCwd: false });
      if (resolved.remoteHostId) await assertNoLiveAgents(db, resolved, getActiveSessions(), 'discard');

      const rel = await resolved.ops.validatePathspec(resolved.cwd, body.path);
      await resolved.ops.discardWorktreePath(resolved.cwd, rel);
      res.json({ ok: true, path: rel });
    } catch (err) {
      if (err instanceof WorkingTreeContextError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof GitCommandError) return mapGitError(res, err);
      if (err instanceof Error) {
        if (err.message.includes('pathspec')) return res.status(403).json({ error: err.message });
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/files/git-history', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const db = getDb();
      const resolved = await resolveGitRequest(db, ctx, nodeHub);
      const wt = await resolved.ops.readWorkingTree(resolved.cwd);
      if (!wt.isRepo) return res.status(400).json({ error: 'not a git repository' });
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const skip = typeof req.query.skip === 'string' ? Number(req.query.skip) : undefined;
      const refQuery = typeof req.query.ref === 'string' && req.query.ref.trim() ? req.query.ref.trim() : undefined;
      if (refQuery) {
        if (!(await resolved.ops.refExists(resolved.cwd, refQuery))) return res.status(404).json({ error: 'unknown ref' });
      }
      const { commits, hasMore } = await resolved.ops.listCommits(resolved.cwd, { limit, skip, ref: refQuery });
      res.json({
        cwd: resolved.cwd,
        branch: wt.branch,
        detached: wt.detached,
        commits,
        hasMore,
        ...(refQuery ? { ref: refQuery } : {}),
      });
    } catch (err) {
      historyCatch(res, err);
    }
  });

  app.get('/files/git-branches', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const db = getDb();
      const resolved = await resolveRepo(db, ctx, nodeHub);
      const result = await resolved.ops.listBranches(resolved.cwd);
      res.json(result);
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.post('/files/working-tree/switch-branch', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; branch?: string; conversationId?: string; projectId?: string };
      if (!body.cwd || !body.branch) {
        return res.status(400).json({ error: 'cwd and branch required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true });
      await guardMutation(db, resolved, getActiveSessions(), { verb: 'switch branch', clean: true });
      const resultingBranch = await resolved.ops.switchBranch(resolved.cwd, body.branch);
      res.json({ ok: true, branch: resultingBranch });
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.post('/files/working-tree/create-branch', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; name?: string; baseRef?: string; conversationId?: string; projectId?: string };
      if (!body.cwd || !body.name) {
        return res.status(400).json({ error: 'cwd and name required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true });
      await guardMutation(db, resolved, getActiveSessions(), { verb: 'create branch' });
      const resultingBranch = await resolved.ops.createBranch(resolved.cwd, body.name, body.baseRef);
      res.json({ ok: true, branch: resultingBranch });
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.post('/files/working-tree/fetch', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) {
        return res.status(400).json({ error: 'cwd required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true });
      if (resolved.wt.remotes.length === 0) {
        return res.status(400).json({ error: 'no remotes configured' });
      }
      const output = await resolved.ops.fetchRemotes(resolved.cwd);
      const wt2 = await resolved.ops.readWorkingTree(resolved.cwd);
      res.json({
        ok: true,
        output,
        upstream: wt2.upstream,
        ahead: wt2.ahead,
        behind: wt2.behind,
      });
    } catch (err) {
      mutationCatch(res, err, { isNetworkOp: true });
    }
  });

  app.post('/files/working-tree/pull', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) {
        return res.status(400).json({ error: 'cwd required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true });
      await guardMutation(db, resolved, getActiveSessions(), { verb: 'pull' });
      if (resolved.wt.detached) {
        return res.status(400).json({ error: 'cannot pull detached HEAD' });
      }
      if (!resolved.wt.upstream) {
        return res.status(400).json({ error: 'no upstream branch' });
      }
      const output = await resolved.ops.pullFastForward(resolved.cwd);
      const wt2 = await resolved.ops.readWorkingTree(resolved.cwd);
      res.json({
        ok: true,
        output,
        upstream: wt2.upstream,
        ahead: wt2.ahead,
        behind: wt2.behind,
      });
    } catch (err) {
      mutationCatch(res, err, { isNetworkOp: true });
    }
  });

  app.post('/files/working-tree/stash', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; message?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) {
        return res.status(400).json({ error: 'cwd required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true });
      await guardMutation(db, resolved, getActiveSessions(), { verb: 'stash' });
      if (resolved.wt.staged.length === 0 && resolved.wt.unstaged.length === 0) {
        return res.status(400).json({ error: 'nothing to stash' });
      }
      await resolved.ops.stashPush(resolved.cwd, body.message);
      res.json({ ok: true });
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.post('/files/working-tree/stash-pop', async (req: Request, res: Response) => {
    try {
      const body = req.body as { cwd?: string; conversationId?: string; projectId?: string };
      if (!body.cwd) {
        return res.status(400).json({ error: 'cwd required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, {
        conversationId: body.conversationId,
        projectId: body.projectId,
        cwd: body.cwd,
      }, nodeHub, { isMutation: true });
      await guardMutation(db, resolved, getActiveSessions(), { verb: 'pop stash' });
      if ((resolved.wt.stashCount ?? 0) === 0) {
        return res.status(400).json({ error: 'no stash entries' });
      }
      await resolved.ops.stashPop(resolved.cwd);
      res.json({ ok: true });
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.post('/files/working-tree/create-worktree', async (req: Request, res: Response) => {
    try {
      const body = req.body as { conversationId?: string; projectId?: string; branch?: string; newBranch?: boolean; folder?: string };
      if (!body.branch || typeof body.branch !== 'string') {
        return res.status(400).json({ error: 'branch required' });
      }
      const db = getDb();
      const ctx = { conversationId: body.conversationId, projectId: body.projectId };
      const remoteHostId = remoteHostIdFor(db, ctx);
      if (remoteHostId) {
        const host = getRemoteHost(db, remoteHostId);
        if (!host || !hostHasFeature(host.hello, 'git.worktree')) {
          return res.status(501).json({ error: 'remote host needs update', code: 'node_update_required' });
        }
        const resolved = await resolveRepo(db, ctx, nodeHub, { isMutation: true });
        if (!body.newBranch && body.branch.startsWith('origin/')) {
          return res.status(400).json({ error: 'pick a local branch or tick "new branch"' });
        }
        const result = await resolved.ops.addOperatorWorktree(resolved.project.rootPath, body.branch, {
          newBranch: body.newBranch,
          folder: body.folder,
        });
        return res.status(201).json({ ok: true, cwd: result.cwd, branch: result.branch });
      }
      const resolved = resolveWorkingTreeRequest(db, ctx);
      const rootPath = resolved.project.rootPath;
      const wt = readWorkingTree(rootPath);
      if (!wt.isRepo) {
        return res.status(400).json({ error: 'not a git repository' });
      }
      if (!body.newBranch && body.branch.startsWith('origin/')) {
        return res.status(400).json({ error: 'pick a local branch or tick "new branch"' });
      }
      const result = addOperatorWorktree(rootPath, body.branch, {
        newBranch: body.newBranch,
        folder: body.folder,
      });
      res.status(201).json({ ok: true, cwd: result.cwd, branch: result.branch });
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.get('/files/git-branch-diff', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const base = typeof req.query.base === 'string' ? req.query.base : '';
      const target = typeof req.query.target === 'string' ? req.query.target : '';
      if (!base || !target) {
        return res.status(400).json({ error: 'base and target required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, ctx, nodeHub);
      const result = await resolved.ops.branchDiff(resolved.cwd, base, target);
      res.json(result);
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.get('/files/git-branch-diff/file', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      if (!from || !to || !path) {
        return res.status(400).json({ error: 'from, to, and path required' });
      }
      const db = getDb();
      const resolved = await resolveRepo(db, ctx, nodeHub);
      const rel = await resolved.ops.validatePathspec(resolved.cwd, path);
      const result = await resolved.ops.branchFileDiff(resolved.cwd, from, to, rel);
      res.json(result);
    } catch (err) {
      mutationCatch(res, err);
    }
  });

  app.get('/files/git-history/commit', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const sha = typeof req.query.sha === 'string' ? req.query.sha : '';
      if (!sha) return res.status(400).json({ error: 'sha required' });
      const db = getDb();
      const resolved = await resolveGitRequest(db, ctx, nodeHub);
      const wt = await resolved.ops.readWorkingTree(resolved.cwd);
      if (!wt.isRepo) return res.status(400).json({ error: 'not a git repository' });
      const detail = await resolved.ops.commitDetail(resolved.cwd, sha);
      res.json(detail);
    } catch (err) {
      historyCatch(res, err);
    }
  });

  app.get('/files/git-history/diff', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const sha = typeof req.query.sha === 'string' ? req.query.sha : '';
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      if (!sha || !path) return res.status(400).json({ error: 'sha and path required' });
      const db = getDb();
      const resolved = await resolveGitRequest(db, ctx, nodeHub);
      const wt = await resolved.ops.readWorkingTree(resolved.cwd);
      if (!wt.isRepo) return res.status(400).json({ error: 'not a git repository' });
      const rel = await resolved.ops.validatePathspec(resolved.cwd, path);
      const result = await resolved.ops.commitFileDiff(resolved.cwd, sha, rel);
      res.json(result);
    } catch (err) {
      historyCatch(res, err);
    }
  });

  app.get('/files/git-history/file', async (req: Request, res: Response) => {
    try {
      const ctx = historyCtx(req);
      const sha = typeof req.query.sha === 'string' ? req.query.sha : '';
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      if (!sha || !path) return res.status(400).json({ error: 'sha and path required' });
      const db = getDb();
      const resolved = await resolveGitRequest(db, ctx, nodeHub);
      const wt = await resolved.ops.readWorkingTree(resolved.cwd);
      if (!wt.isRepo) return res.status(400).json({ error: 'not a git repository' });
      const rel = await resolved.ops.validatePathspec(resolved.cwd, path);
      const result = await resolved.ops.commitFileContent(resolved.cwd, sha, rel);
      res.json(result);
    } catch (err) {
      historyCatch(res, err);
    }
  });
}
