import { existsSync, realpathSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import type { Database } from 'better-sqlite3';
import type { GitLiveAgent, GitWorkingTreeRef, GitWorkingTreeStatus } from '@tierwyn/shared';
import type { Project, Conversation } from '@tierwyn/shared';
import { isParkedSession } from '../activeAgents.js';
import type { SessionRecord } from '../sessionManager.js';
import { getConversation, listConversationWorkdirs, pruneMissingConversationWorkdirs } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { remoteHostIdFor } from '../repositories/remoteHosts.js';
import { resolveConversationCwd } from './shadowCheckpoint.js';
import { isGitRepo } from '../worktree.js';
import {
  gitExec, listGitWorktrees, listNestedGitRepos, readWorkingTree, headRef,
} from './workingTree.js';
import {
  WorkingTreeContextError, localGitOps, RemoteGitOps,
  type GitOps, type GitNodeHub,
} from './remoteOps.js';
export { WorkingTreeContextError };

export interface ResolvedWorkingTreeRequest {
  project: Project;
  conversation?: Conversation;
  cwd: string;
}

export interface ResolvedGitRequest extends ResolvedWorkingTreeRequest {
  ops: GitOps;
  remoteHostId: string | null;
  trees?: GitWorkingTreeRef[];
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function getGitCommonDirReal(cwd: string): string | null {
  if (!isGitRepo(cwd)) return null;
  try {
    const out = gitExec(cwd, ['rev-parse', '--git-common-dir']).trim();
    const abs = out.startsWith('/') ? out : resolve(cwd, out);
    return realpathSync(abs);
  } catch {
    return null;
  }
}

export function isCwdAllowedForProject(
  db: Database,
  project: Project,
  requested: string,
): boolean {
  const reqReal = safeRealpath(requested);
  const rootReal = safeRealpath(project.rootPath);
  if (reqReal === rootReal) return true;

  if (reqReal.startsWith(rootReal + sep)) {
    try {
      const nested = listNestedGitRepos(project.rootPath);
      if (nested.some((nr) => safeRealpath(nr.cwd) === reqReal)) return true;
    } catch {
      // degraded
    }
  }

  const convWorkdirs = listConversationWorkdirs(db, project.id).map((r) => safeRealpath(r.workdirPath));
  const projCommon = getGitCommonDirReal(project.rootPath);
  const reqCommon = getGitCommonDirReal(requested);

  if (!isGitRepo(project.rootPath) && !existsSync(join(project.rootPath, '.git'))) {
    if (!convWorkdirs.includes(reqReal)) return false;
    return reqCommon !== null;
  }

  if (!reqCommon || projCommon !== reqCommon) return false;

  if (convWorkdirs.includes(reqReal)) return true;

  const worktrees = listGitWorktrees(project.rootPath);
  return worktrees.some((wt) => safeRealpath(wt.cwd) === reqReal);
}

/** Null missing conversation workdirs for this project and `git worktree prune` its root. */
export function healProjectWorkingTrees(db: Database, project: Project): number {
  const n = pruneMissingConversationWorkdirs(db, project.id);
  try {
    gitExec(project.rootPath, ['worktree', 'prune']);
  } catch {
    // Non-git roots and prune failures must not fail the panel GET.
  }
  return n;
}

/** Look up the project for a panel request and heal it. Missing ids are left for resolve to 404. */
export function healWorkingTreesForRequest(
  db: Database,
  input: { conversationId?: string; projectId?: string },
): void {
  const convId = input.conversationId?.trim();
  const projId = input.projectId?.trim();
  let project: Project | undefined;
  if (convId) {
    const conversation = getConversation(db, convId);
    if (!conversation) return;
    if (projId && projId !== conversation.projectId) return;
    project = getProject(db, conversation.projectId);
  } else if (projId) {
    project = getProject(db, projId);
  }
  if (!project) return;
  if (remoteHostIdFor(db, { projectId: project.id })) return;
  healProjectWorkingTrees(db, project);
}

function lookupContext(
  db: Database,
  input: { conversationId?: string; projectId?: string; cwd?: string },
): { project: Project; conversation?: Conversation } {
  const convId = input.conversationId?.trim();
  const projId = input.projectId?.trim();

  let project: Project | undefined;
  let conversation: Conversation | undefined;

  if (convId) {
    conversation = getConversation(db, convId);
    if (!conversation) throw new WorkingTreeContextError(404, 'conversation not found');
    project = getProject(db, conversation.projectId);
    if (!project) throw new WorkingTreeContextError(404, 'project not found');
    if (projId && projId !== project.id) {
      throw new WorkingTreeContextError(400, 'projectId does not match conversation');
    }
  } else if (projId) {
    project = getProject(db, projId);
    if (!project) throw new WorkingTreeContextError(404, 'project not found');
  } else {
    throw new WorkingTreeContextError(400, 'conversationId or projectId required');
  }
  return { project, conversation };
}

export function resolveWorkingTreeRequest(
  db: Database,
  input: { conversationId?: string; projectId?: string; cwd?: string },
): ResolvedWorkingTreeRequest {
  const { project, conversation } = lookupContext(db, input);

  if (remoteHostIdFor(db, { projectId: project.id })) {
    throw new WorkingTreeContextError(409, 'not available for remote-host projects (P3)');
  }

  const liveWorkdir = conversation?.workdirPath && existsSync(conversation.workdirPath)
    ? conversation.workdirPath
    : undefined;
  const defaultCwd = liveWorkdir ?? project!.rootPath;

  const cwdInput = input.cwd?.trim() ? input.cwd.trim() : undefined;
  // Ghost selectedCwd (gone from disk) falls back to the project root, not 403.
  // Existing foreign paths still go through isCwdAllowedForProject below.
  let requested = cwdInput
    ? (existsSync(cwdInput) ? cwdInput : project!.rootPath)
    : defaultCwd;

  if (isGitRepo(requested)) {
    requested = gitExec(requested, ['rev-parse', '--show-toplevel']).trim();
  } else {
    requested = safeRealpath(requested);
  }

  if (!isCwdAllowedForProject(db, project!, requested)) {
    throw new WorkingTreeContextError(403, 'cwd is not a worktree of this project');
  }

  return { project: project!, conversation, cwd: requested };
}

function refForCwd(cwd: string): Pick<GitWorkingTreeRef, 'branch' | 'detached' | 'headSha'> {
  const { branch, detached, headSha } = headRef(cwd);
  return { branch, detached, headSha };
}

export function buildTreeList(db: Database, project: Project): GitWorkingTreeRef[] {
  const seen = new Set<string>();
  const trees: GitWorkingTreeRef[] = [];

  const add = (ref: GitWorkingTreeRef) => {
    const key = safeRealpath(ref.cwd);
    if (seen.has(key)) return;
    seen.add(key);
    trees.push({ ...ref, cwd: key });
  };

  const rootMeta = refForCwd(project.rootPath);
  add({
    cwd: project.rootPath,
    label: project.name,
    ...rootMeta,
    source: 'project',
  });

  for (const row of listConversationWorkdirs(db, project.id)) {
    if (!existsSync(row.workdirPath)) continue;
    const meta = refForCwd(row.workdirPath);
    add({
      cwd: row.workdirPath,
      label: row.title,
      ...meta,
      source: 'conversation',
      conversationId: row.id,
    });
  }

  try {
    for (const wt of listGitWorktrees(project.rootPath)) {
      if (!existsSync(wt.cwd)) continue;
      const meta = refForCwd(wt.cwd);
      add({
        cwd: wt.cwd,
        label: basename(wt.cwd),
        branch: meta.branch || wt.branch,
        detached: meta.detached || wt.detached,
        headSha: meta.headSha || wt.headSha,
        source: 'worktree',
      });
    }
  } catch {
    // damaged shared root — degrade to project root + conversation workdirs only
  }

  try {
    for (const nr of listNestedGitRepos(project.rootPath)) {
      const meta = refForCwd(nr.cwd);
      add({
        cwd: nr.cwd,
        label: nr.label,
        ...meta,
        source: 'nested',
      });
    }
  } catch {
    // degraded
  }

  return trees;
}

export function collectLiveAgents(
  db: Database,
  selectedCwd: string,
  sessions: SessionRecord[],
): GitLiveAgent[] {
  const selectedReal = safeRealpath(selectedCwd);
  const agents: GitLiveAgent[] = [];

  for (const s of sessions) {
    if (isParkedSession({ lastStatus: s.lastStatus, steerQueueLength: s.steerQueue.length })) continue;
    if (remoteHostIdFor(db, { conversationId: s.conversationId })) continue;
    const sessionCwd = s.steerOrigin.cwd
      ?? resolveConversationCwd(db, s.conversationId)
      ?? '';
    if (!sessionCwd) continue;
    if (safeRealpath(sessionCwd) !== selectedReal) continue;
    const conv = getConversation(db, s.conversationId);
    agents.push({
      conversationId: s.conversationId,
      title: conv?.title ?? s.conversationId.slice(0, 8),
    });
  }

  return agents;
}

export async function collectRemoteLiveAgents(
  db: Database,
  hostId: string,
  cwd: string,
  ops: GitOps,
  sessions: SessionRecord[],
): Promise<GitLiveAgent[]> {
  const agents: GitLiveAgent[] = [];
  const toplevelByCwd = new Map<string, string>();

  for (const s of sessions) {
    if (isParkedSession({ lastStatus: s.lastStatus, steerQueueLength: s.steerQueue.length })) continue;
    if (remoteHostIdFor(db, { conversationId: s.conversationId }) !== hostId) continue;
    const conv = getConversation(db, s.conversationId);
    const project = conv ? getProject(db, conv.projectId) : undefined;
    const sessionCwd = s.steerOrigin.cwd
      ?? resolveConversationCwd(db, s.conversationId)
      ?? project?.rootPath
      ?? '';
    if (!sessionCwd) continue;
    let top = toplevelByCwd.get(sessionCwd);
    if (top === undefined) {
      try {
        top = (await ops.headRef(sessionCwd)).toplevel || resolve(sessionCwd);
      } catch (e) {
        if (e instanceof WorkingTreeContextError && (e.status === 400 || e.status === 403 || e.status === 404)) {
          top = '';
        } else {
          throw e;
        }
      }
      toplevelByCwd.set(sessionCwd, top);
    }
    if (!top || top !== cwd) continue;
    agents.push({
      conversationId: s.conversationId,
      title: conv?.title ?? s.conversationId.slice(0, 8),
    });
  }

  return agents;
}

export async function liveAgentsFor(
  db: Database,
  resolved: ResolvedGitRequest,
  sessions: SessionRecord[],
): Promise<GitLiveAgent[]> {
  if (resolved.remoteHostId) {
    return collectRemoteLiveAgents(db, resolved.remoteHostId, resolved.cwd, resolved.ops, sessions);
  }
  return collectLiveAgents(db, resolved.cwd, sessions);
}

export function commitDraftKey(resolved: Pick<ResolvedGitRequest, 'cwd' | 'remoteHostId'>): string {
  // ponytail: WS draft frames still carry bare cwd — a local modal on the identical path also applies a remote draft frame; add hostId to the frame if that bites.
  return resolved.remoteHostId ? `remote:${resolved.remoteHostId}:${resolved.cwd}` : resolved.cwd;
}

export function buildWorkingTreeStatus(
  db: Database,
  project: Project,
  cwd: string,
  sessions: SessionRecord[],
): GitWorkingTreeStatus {
  const wt = readWorkingTree(cwd);
  return {
    isRepo: wt.isRepo,
    cwd,
    branch: wt.branch,
    detached: wt.detached,
    headSha: wt.headSha,
    staged: wt.staged,
    unstaged: wt.unstaged,
    hasConflicts: wt.hasConflicts,
    remotes: wt.remotes,
    upstream: wt.upstream,
    ahead: wt.ahead,
    behind: wt.behind,
    stashCount: wt.stashCount,
    stashTop: wt.stashTop,
    trees: buildTreeList(db, project),
    liveAgents: collectLiveAgents(db, cwd, sessions),
  };
}

function lexicalKey(p: string): string {
  return resolve(p);
}

export async function buildRemoteTreeList(
  db: Database,
  project: Project,
  ops: GitOps,
): Promise<GitWorkingTreeRef[]> {
  // ponytail: one headRef RPC per tree row; batch into git.call 'treeRefs' if panels with many worktrees feel slow
  const seen = new Set<string>();
  const trees: GitWorkingTreeRef[] = [];

  const add = (ref: GitWorkingTreeRef) => {
    const key = lexicalKey(ref.cwd);
    if (seen.has(key)) return;
    seen.add(key);
    trees.push({ ...ref, cwd: key });
  };

  const rootMeta = await ops.headRef(project.rootPath);
  add({
    cwd: rootMeta.toplevel || project.rootPath,
    label: project.name,
    branch: rootMeta.branch,
    detached: rootMeta.detached,
    headSha: rootMeta.headSha,
    source: 'project',
  });

  for (const row of listConversationWorkdirs(db, project.id)) {
    if (!(await ops.exists(row.workdirPath))) continue;
    const meta = await ops.headRef(row.workdirPath);
    add({
      cwd: meta.toplevel || row.workdirPath,
      label: row.title,
      branch: meta.branch,
      detached: meta.detached,
      headSha: meta.headSha,
      source: 'conversation',
      conversationId: row.id,
    });
  }

  try {
    for (const wt of await ops.listGitWorktrees(project.rootPath)) {
      add({
        cwd: wt.cwd,
        label: basename(wt.cwd),
        branch: wt.branch,
        detached: wt.detached,
        headSha: wt.headSha,
        source: 'worktree',
      });
    }
  } catch (e) {
    if (e instanceof WorkingTreeContextError && (e.status === 503 || e.status === 501)) throw e;
  }

  try {
    for (const nr of await ops.listNestedGitRepos(project.rootPath)) {
      const meta = await ops.headRef(nr.cwd);
      add({
        cwd: meta.toplevel || nr.cwd,
        label: nr.label,
        branch: meta.branch,
        detached: meta.detached,
        headSha: meta.headSha,
        source: 'nested',
      });
    }
  } catch (e) {
    if (e instanceof WorkingTreeContextError && (e.status === 503 || e.status === 501)) throw e;
  }

  return trees;
}

export async function resolveGitRequest(
  db: Database,
  input: { conversationId?: string; projectId?: string; cwd?: string },
  nodeHub?: GitNodeHub,
): Promise<ResolvedGitRequest> {
  const hostId = remoteHostIdFor(db, input);
  if (!hostId) {
    return { ...resolveWorkingTreeRequest(db, input), ops: localGitOps, remoteHostId: null };
  }
  if (!nodeHub) throw new WorkingTreeContextError(503, 'remote host not connected');

  const { project, conversation } = lookupContext(db, input);
  const ops = new RemoteGitOps(nodeHub, hostId);
  const trees = await buildRemoteTreeList(db, project, ops);
  const treeKeys = new Set(trees.map((t) => t.cwd));

  const cwdInput = input.cwd?.trim() ? input.cwd.trim() : undefined;
  let c: string;
  if (cwdInput) {
    c = (await ops.exists(cwdInput)) ? cwdInput : project.rootPath;
  } else {
    const live = conversation?.workdirPath && (await ops.exists(conversation.workdirPath))
      ? conversation.workdirPath
      : undefined;
    c = live ?? project.rootPath;
  }
  const t = (await ops.headRef(c)).toplevel;
  c = t || c;
  if (!treeKeys.has(lexicalKey(c))) {
    throw new WorkingTreeContextError(403, 'cwd is not a worktree of this project');
  }
  return { project, conversation, cwd: c, ops, remoteHostId: hostId, trees };
}

export async function buildGitWorkingTreeStatus(
  db: Database,
  resolved: ResolvedGitRequest,
  sessions: SessionRecord[],
): Promise<GitWorkingTreeStatus> {
  if (!resolved.remoteHostId) {
    return buildWorkingTreeStatus(db, resolved.project, resolved.cwd, sessions);
  }
  const wt = await resolved.ops.readWorkingTree(resolved.cwd);
  return {
    isRepo: wt.isRepo,
    cwd: resolved.cwd,
    branch: wt.branch,
    detached: wt.detached,
    headSha: wt.headSha,
    staged: wt.staged,
    unstaged: wt.unstaged,
    hasConflicts: wt.hasConflicts,
    remotes: wt.remotes,
    upstream: wt.upstream,
    ahead: wt.ahead,
    behind: wt.behind,
    stashCount: wt.stashCount,
    stashTop: wt.stashTop,
    trees: resolved.trees ?? [],
    liveAgents: await liveAgentsFor(db, resolved, sessions),
  };
}
