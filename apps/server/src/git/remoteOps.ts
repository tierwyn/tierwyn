import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type {
  GitBranchDiffResponse,
  GitBranchesResponse,
  GitCallResult,
  GitCommitDetail,
  GitCommitDiffResponse,
  GitCommitFileResponse,
  GitCommitSummary,
  GitMethod,
} from '@tierwyn/shared';
import { RpcError } from '../node/rpc.js';
import {
  GitCommandError,
  addOperatorWorktree,
  branchDiff,
  branchFileDiff,
  commitDetail,
  commitFileContent,
  commitFileDiff,
  commitStaged,
  createBranch,
  deleteUntrackedPath,
  discardWorktreePath,
  fetchRemotes,
  fileHeadDiff as fileHeadDiffAbs,
  headRef,
  listBranches,
  listCommits,
  listGitWorktrees,
  listNestedGitRepos,
  pullFastForward,
  pushRemote,
  readWorkingTree,
  recentSubjects,
  refExists,
  restoreFileToHead,
  stagePath,
  stagedDiff,
  stagedDiffStat,
  stashPop,
  stashPush,
  switchBranch,
  unstagePath,
  validatePathspec as validatePathspecLocal,
  type GitWorktreeEntry,
  type NestedGitRepoEntry,
  type WorkingTreeReadResult,
} from './workingTree.js';
import { createWorktree } from '../worktree.js';

export const GIT_NETWORK_TIMEOUT_MS = 180_000;

export class WorkingTreeContextError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkingTreeContextError';
  }
}

export interface GitNodeHub {
  link(hostId: string): { request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> };
}

export interface GitOps {
  readWorkingTree(cwd: string): Promise<WorkingTreeReadResult>;
  listBranches(cwd: string): Promise<GitBranchesResponse>;
  listCommits(cwd: string, opts?: { limit?: number; skip?: number; ref?: string }): Promise<{ commits: GitCommitSummary[]; hasMore: boolean }>;
  commitDetail(cwd: string, sha: string): Promise<GitCommitDetail>;
  commitFileDiff(cwd: string, sha: string, relPath: string): Promise<GitCommitDiffResponse>;
  commitFileContent(cwd: string, sha: string, relPath: string): Promise<GitCommitFileResponse>;
  branchDiff(cwd: string, base: string, target: string): Promise<GitBranchDiffResponse>;
  branchFileDiff(cwd: string, from: string, to: string, relPath: string): Promise<GitCommitDiffResponse>;
  stagedDiff(cwd: string): Promise<string>;
  stagedDiffStat(cwd: string): Promise<string>;
  recentSubjects(cwd: string, limit?: number): Promise<string[]>;
  listGitWorktrees(root: string): Promise<GitWorktreeEntry[]>;
  listNestedGitRepos(root: string, maxDepth?: number): Promise<NestedGitRepoEntry[]>;
  headRef(cwd: string): Promise<{ branch: string; detached: boolean; headSha: string; toplevel: string }>;
  refExists(cwd: string, ref: string): Promise<boolean>;
  fileHeadDiff(cwd: string, path: string): Promise<{ modified: boolean; diff: string; isTracked: boolean }>;
  stagePath(cwd: string, relPath: string): Promise<void>;
  unstagePath(cwd: string, relPath: string): Promise<void>;
  commitStaged(cwd: string, message: string): Promise<string>;
  discardWorktreePath(cwd: string, relPath: string): Promise<void>;
  deleteUntrackedPath(cwd: string, relPath: string): Promise<void>;
  stashPush(cwd: string, message?: string): Promise<void>;
  stashPop(cwd: string): Promise<void>;
  switchBranch(cwd: string, branch: string): Promise<string>;
  createBranch(cwd: string, name: string, baseRef?: string): Promise<string>;
  fetchRemotes(cwd: string): Promise<string>;
  pullFastForward(cwd: string): Promise<string>;
  pushRemote(cwd: string, remote?: string): Promise<{ remote: string; branch: string; output: string }>;
  restoreFileToHead(cwd: string, path: string): Promise<{ action: 'restored' | 'deleted'; path: string }>;
  addOperatorWorktree(cwd: string, branch: string, opts?: { newBranch?: boolean; folder?: string }): Promise<{ cwd: string; branch: string }>;
  createSpawnWorktree(cwd: string, conversationId: string): Promise<{ path: string; branch: string }>;
  /** local: the real validatePathspec. remote: lexical pre-check only (node is authoritative). */
  validatePathspec(cwd: string, relPath: string): Promise<string>;
  /** local: existsSync. remote: fs.statPath → exists. */
  exists(path: string): Promise<boolean>;
}

function mapRpcError(e: unknown): WorkingTreeContextError {
  const code = e instanceof RpcError ? e.code : '';
  if (code === 'path_outside_roots' || code === 'path_not_allowed') {
    return new WorkingTreeContextError(403, 'cwd is not a worktree of this project');
  }
  if (code === 'bad_path') return new WorkingTreeContextError(400, 'bad path');
  if (code === 'not_found') return new WorkingTreeContextError(404, 'file not found');
  if (code === 'host_disconnected' || code === 'disconnected' || code === 'timeout') {
    return new WorkingTreeContextError(503, 'remote host not connected');
  }
  if (code === 'no_method') return new WorkingTreeContextError(501, 'remote host needs update');
  return new WorkingTreeContextError(502, 'remote git failed');
}

export const localGitOps: GitOps = {
  readWorkingTree: async (cwd) => readWorkingTree(cwd),
  listBranches: async (cwd) => listBranches(cwd),
  listCommits: async (cwd, opts) => listCommits(cwd, opts),
  commitDetail: async (cwd, sha) => commitDetail(cwd, sha),
  commitFileDiff: async (cwd, sha, relPath) => commitFileDiff(cwd, sha, relPath),
  commitFileContent: async (cwd, sha, relPath) => commitFileContent(cwd, sha, relPath),
  branchDiff: async (cwd, base, target) => branchDiff(cwd, base, target),
  branchFileDiff: async (cwd, from, to, relPath) => branchFileDiff(cwd, from, to, relPath),
  stagedDiff: async (cwd) => stagedDiff(cwd),
  stagedDiffStat: async (cwd) => stagedDiffStat(cwd),
  recentSubjects: async (cwd, limit) => recentSubjects(cwd, limit),
  listGitWorktrees: async (root) => listGitWorktrees(root),
  listNestedGitRepos: async (root, maxDepth) => listNestedGitRepos(root, maxDepth),
  headRef: async (cwd) => headRef(cwd),
  refExists: async (cwd, ref) => refExists(cwd, ref),
  fileHeadDiff: async (cwd, path) => fileHeadDiffAbs(resolve(cwd, path)),
  stagePath: async (cwd, relPath) => stagePath(cwd, relPath),
  unstagePath: async (cwd, relPath) => unstagePath(cwd, relPath),
  commitStaged: async (cwd, message) => commitStaged(cwd, message),
  discardWorktreePath: async (cwd, relPath) => discardWorktreePath(cwd, relPath),
  deleteUntrackedPath: async (cwd, relPath) => deleteUntrackedPath(cwd, relPath),
  stashPush: async (cwd, message) => stashPush(cwd, message),
  stashPop: async (cwd) => stashPop(cwd),
  switchBranch: async (cwd, branch) => switchBranch(cwd, branch),
  createBranch: async (cwd, name, baseRef) => createBranch(cwd, name, baseRef),
  fetchRemotes: async (cwd) => fetchRemotes(cwd),
  pullFastForward: async (cwd) => pullFastForward(cwd),
  pushRemote: async (cwd, remote) => pushRemote(cwd, remote),
  restoreFileToHead: async (cwd, path) => restoreFileToHead(resolve(cwd, path)),
  addOperatorWorktree: async (cwd, branch, opts) => addOperatorWorktree(cwd, branch, opts),
  createSpawnWorktree: async (cwd, conversationId) => createWorktree(cwd, conversationId),
  validatePathspec: (cwd, relPath) => validatePathspecLocal(cwd, relPath),
  exists: async (path) => existsSync(path),
};

export class RemoteGitOps implements GitOps {
  constructor(private readonly hub: GitNodeHub, private readonly hostId: string) {}

  protected async call<T>(method: GitMethod, cwd: string, args?: unknown[], timeoutMs?: number): Promise<T> {
    let result: GitCallResult;
    try {
      result = await this.hub.link(this.hostId).request<GitCallResult>('git.call', { method, cwd, args }, timeoutMs);
    } catch (e) {
      throw mapRpcError(e);
    }
    if (result.ok === true) return result.r as T;
    if (result.kind === 'git') {
      throw new GitCommandError([method], result.stderr, result.exitCode, result.stdout);
    }
    throw new Error(result.message);
  }

  readWorkingTree(cwd: string) { return this.call<WorkingTreeReadResult>('readWorkingTree', cwd); }
  listBranches(cwd: string) { return this.call<GitBranchesResponse>('listBranches', cwd); }
  listCommits(cwd: string, opts?: { limit?: number; skip?: number; ref?: string }) {
    return this.call<{ commits: GitCommitSummary[]; hasMore: boolean }>('listCommits', cwd, opts ? [opts] : undefined);
  }
  commitDetail(cwd: string, sha: string) { return this.call<GitCommitDetail>('commitDetail', cwd, [sha]); }
  commitFileDiff(cwd: string, sha: string, relPath: string) {
    return this.call<GitCommitDiffResponse>('commitFileDiff', cwd, [sha, relPath]);
  }
  commitFileContent(cwd: string, sha: string, relPath: string) {
    return this.call<GitCommitFileResponse>('commitFileContent', cwd, [sha, relPath]);
  }
  branchDiff(cwd: string, base: string, target: string) {
    return this.call<GitBranchDiffResponse>('branchDiff', cwd, [base, target]);
  }
  branchFileDiff(cwd: string, from: string, to: string, relPath: string) {
    return this.call<GitCommitDiffResponse>('branchFileDiff', cwd, [from, to, relPath]);
  }
  stagedDiff(cwd: string) { return this.call<string>('stagedDiff', cwd); }
  stagedDiffStat(cwd: string) { return this.call<string>('stagedDiffStat', cwd); }
  recentSubjects(cwd: string, limit?: number) {
    return this.call<string[]>('recentSubjects', cwd, limit === undefined ? undefined : [limit]);
  }
  listGitWorktrees(root: string) { return this.call<GitWorktreeEntry[]>('listGitWorktrees', root); }
  listNestedGitRepos(root: string, maxDepth?: number) {
    return this.call<NestedGitRepoEntry[]>('listNestedGitRepos', root, maxDepth === undefined ? undefined : [maxDepth]);
  }
  headRef(cwd: string) {
    return this.call<{ branch: string; detached: boolean; headSha: string; toplevel: string }>('headRef', cwd);
  }
  refExists(cwd: string, ref: string) { return this.call<boolean>('refExists', cwd, [ref]); }
  fileHeadDiff(cwd: string, path: string) {
    return this.call<{ modified: boolean; diff: string; isTracked: boolean }>('fileHeadDiff', cwd, [path]);
  }
  stagePath(cwd: string, relPath: string) { return this.call<void>('stagePath', cwd, [relPath]); }
  unstagePath(cwd: string, relPath: string) { return this.call<void>('unstagePath', cwd, [relPath]); }
  commitStaged(cwd: string, message: string) { return this.call<string>('commitStaged', cwd, [message]); }
  discardWorktreePath(cwd: string, relPath: string) { return this.call<void>('discardWorktreePath', cwd, [relPath]); }
  deleteUntrackedPath(cwd: string, relPath: string) { return this.call<void>('deleteUntrackedPath', cwd, [relPath]); }
  stashPush(cwd: string, message?: string) {
    return this.call<void>('stashPush', cwd, message === undefined ? [] : [message]);
  }
  stashPop(cwd: string) { return this.call<void>('stashPop', cwd); }
  switchBranch(cwd: string, branch: string) { return this.call<string>('switchBranch', cwd, [branch]); }
  createBranch(cwd: string, name: string, baseRef?: string) {
    return this.call<string>('createBranch', cwd, baseRef === undefined ? [name] : [name, baseRef]);
  }
  fetchRemotes(cwd: string) { return this.call<string>('fetchRemotes', cwd, undefined, GIT_NETWORK_TIMEOUT_MS); }
  pullFastForward(cwd: string) { return this.call<string>('pullFastForward', cwd, undefined, GIT_NETWORK_TIMEOUT_MS); }
  pushRemote(cwd: string, remote?: string) {
    return this.call<{ remote: string; branch: string; output: string }>(
      'pushRemote', cwd, remote === undefined ? [] : [remote], GIT_NETWORK_TIMEOUT_MS,
    );
  }
  restoreFileToHead(cwd: string, path: string) {
    return this.call<{ action: 'restored' | 'deleted'; path: string }>('restoreFileToHead', cwd, [path]);
  }
  addOperatorWorktree(cwd: string, branch: string, opts?: { newBranch?: boolean; folder?: string }) {
    return this.call<{ cwd: string; branch: string }>('addOperatorWorktree', cwd, opts ? [branch, opts] : [branch]);
  }
  createSpawnWorktree(cwd: string, conversationId: string) {
    return this.call<{ path: string; branch: string }>('createSpawnWorktree', cwd, [conversationId]);
  }

  async validatePathspec(_cwd: string, relPath: string): Promise<string> {
    if (!relPath || relPath.includes('\0')) throw new Error('invalid pathspec');
    if (isAbsolute(relPath)) throw new Error('absolute pathspec rejected');
    for (const seg of relPath.split(/[/\\]/)) {
      if (seg === '.git' || seg === '..') throw new Error('pathspec contains forbidden segment');
    }
    return relPath.replace(/\\/g, '/');
  }

  async exists(path: string): Promise<boolean> {
    try {
      const st = await this.hub.link(this.hostId).request<{ exists: boolean; underRoots: boolean }>('fs.statPath', { path });
      return !!(st.exists && st.underRoots);
    } catch (e) {
      throw mapRpcError(e);
    }
  }
}
