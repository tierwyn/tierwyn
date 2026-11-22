import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { lstat, realpath } from 'fs/promises';
import {
  GIT_MUTATION_METHODS,
  GIT_READ_METHODS,
  GIT_SHADOW_METHODS,
  isSecretPath,
  type GitCallResult,
  type GitMethod,
} from '@tierwyn/shared';
import {
  GitCommandError,
  addOperatorWorktree,
  assertBranchName,
  assertRef,
  assertSha,
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
  fileHeadDiff,
  gitExec,
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
  validatePathspec,
} from '../git/workingTree.js';
import { createWorktree } from '../worktree.js';
import { pathUnderRoots } from './policy.js';
import { RpcError } from './rpc.js';
import {
  codeDiff,
  currentHead,
  deleteShadowRef,
  isGitRepo,
  isWorkingTreeClean,
  resolveShadowRef,
  restoreCode,
  snapshotCode,
} from '../git/shadowOps.js';
import type { CodeDiffMode, CodeRestoreMode } from '../git/shadowOps.js';

const ALLOWED = new Set<string>([...GIT_READ_METHODS, ...GIT_MUTATION_METHODS, ...GIT_SHADOW_METHODS]);

/** Shadow ids become ref path segments; keep them shell-/ref-safe. */
const SHADOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SPAWN_WORKTREE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const RESTORE_MODES: readonly CodeRestoreMode[] = ['worktree', 'shared'];
const DIFF_MODES: readonly CodeDiffMode[] = ['restore', 'captured'];

function asShadowId(v: unknown, label: string): string {
  if (typeof v !== 'string' || !SHADOW_ID_RE.test(v)) throw new RpcError('bad_name', label);
  return v;
}

function asSpawnWorktreeId(v: unknown): string {
  if (typeof v !== 'string' || !SPAWN_WORKTREE_ID_RE.test(v)) throw new Error('invalid conversationId');
  return v;
}

async function assertWorktreeParentAllowed(realCwd: string, roots: string[]): Promise<void> {
  const top = gitExec(realCwd, ['rev-parse', '--show-toplevel']).trim();
  const realTop = await realpath(top);
  const parent = dirname(realTop);
  if (!pathUnderRoots(parent, roots)) {
    throw new Error('worktree_outside_roots');
  }
}

function asShadowMode<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error('invalid mode');
  }
  return v as T;
}


const ARITY: Record<GitMethod, number> = {
  readWorkingTree: 0,
  listBranches: 0,
  stagedDiff: 0,
  stagedDiffStat: 0,
  listGitWorktrees: 0,
  headRef: 0,
  recentSubjects: 1,
  listNestedGitRepos: 1,
  listCommits: 1,
  refExists: 1,
  commitDetail: 1,
  fileHeadDiff: 1,
  commitFileDiff: 2,
  commitFileContent: 2,
  branchDiff: 2,
  branchFileDiff: 3,
  stagePath: 1,
  unstagePath: 1,
  discardWorktreePath: 1,
  deleteUntrackedPath: 1,
  commitStaged: 1,
  stashPush: 1,
  stashPop: 0,
  fetchRemotes: 0,
  pullFastForward: 0,
  switchBranch: 1,
  createBranch: 2,
  pushRemote: 1,
  restoreFileToHead: 1,
  addOperatorWorktree: 2,
  createSpawnWorktree: 1,
  isGitRepo: 0,
  isWorkingTreeClean: 0,
  currentHead: 0,
  snapshotCode: 2,
  restoreCode: 2,
  deleteShadowRef: 2,
  resolveShadowRef: 2,
  codeDiff: 2,
};

function asString(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`invalid ${label}`);
  return v;
}

function optionalInt(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error('invalid args');
  }
  return v;
}

function asCommitMessage(v: unknown): string {
  if (typeof v !== 'string') throw new Error('invalid message');
  if (!v.trim() || Buffer.byteLength(v, 'utf8') > 65536) throw new Error('invalid message');
  return v;
}

function asStashMessage(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || Buffer.byteLength(v, 'utf8') > 65536) {
    throw new Error('invalid message');
  }
  return v;
}

function asRemote(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || v.startsWith('-')) throw new Error('invalid remote');
  return v;
}

async function jailFile(path: unknown, realCwd: string, roots: string[]): Promise<string> {
  if (typeof path !== 'string' || !path) throw new RpcError('bad_path', 'path');
  const requested = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const target = isAbsolute(requested) ? requested : resolve(realCwd, requested);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new RpcError('not_found', path);
  }
  if (!pathUnderRoots(real, roots)) throw new RpcError('path_outside_roots', path);
  if (isSecretPath(real) || isSecretPath(path) || real.split(sep).includes('.git')) {
    throw new RpcError('path_not_allowed', path);
  }
  return real;
}

/** Mutation-safe file jail that preserves symlinks so restore/discard operates on the link, not its target (I2). */
async function jailFileForRestore(path: unknown, realCwd: string, roots: string[]): Promise<string> {
  if (typeof path !== 'string' || !path) throw new RpcError('bad_path', 'path');
  const requested = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const target = isAbsolute(requested) ? requested : resolve(realCwd, requested);
  const parent = dirname(target);
  const base = basename(target);
  if (!base || base === '.' || base === '..') throw new RpcError('bad_path', path);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch {
    throw new RpcError('not_found', path);
  }
  const candidate = join(realParent, base);
  try {
    await lstat(candidate);
  } catch {
    throw new RpcError('not_found', path);
  }
  if (!pathUnderRoots(realParent, roots)) throw new RpcError('path_outside_roots', path);
  if (isSecretPath(candidate) || isSecretPath(path) || candidate.split(sep).includes('.git')) {
    throw new RpcError('path_not_allowed', path);
  }
  return candidate;
}

async function dispatch(method: GitMethod, realCwd: string, args: unknown[], roots: string[]): Promise<unknown> {
  switch (method) {
    case 'readWorkingTree': return readWorkingTree(realCwd);
    case 'listBranches': return listBranches(realCwd);
    case 'stagedDiff': return stagedDiff(realCwd);
    case 'stagedDiffStat': return stagedDiffStat(realCwd);
    case 'listGitWorktrees': return listGitWorktrees(realCwd);
    case 'headRef': return headRef(realCwd);
    case 'recentSubjects': return recentSubjects(realCwd, optionalInt(args[0], 1, 50));
    case 'listNestedGitRepos': return listNestedGitRepos(realCwd, optionalInt(args[0], 0, 4));
    case 'listCommits': {
      const raw = args[0];
      if (raw === undefined) return listCommits(realCwd);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid args');
      const o = raw as Record<string, unknown>;
      const opts: { limit?: number; skip?: number; ref?: string } = {};
      if (typeof o.limit === 'number') opts.limit = o.limit;
      if (typeof o.skip === 'number') opts.skip = o.skip;
      if (typeof o.ref === 'string') {
        assertRef(o.ref);
        opts.ref = o.ref;
      }
      return listCommits(realCwd, opts);
    }
    case 'refExists': {
      const ref = asString(args[0], 'ref');
      assertRef(ref);
      return refExists(realCwd, ref);
    }
    case 'commitDetail':
      return commitDetail(realCwd, assertSha(asString(args[0], 'sha')));
    case 'commitFileDiff': {
      const sha = assertSha(asString(args[0], 'sha'));
      const rel = await validatePathspec(realCwd, asString(args[1], 'pathspec'));
      return commitFileDiff(realCwd, sha, rel);
    }
    case 'commitFileContent': {
      const sha = assertSha(asString(args[0], 'sha'));
      const rel = await validatePathspec(realCwd, asString(args[1], 'pathspec'));
      return commitFileContent(realCwd, sha, rel);
    }
    case 'branchDiff':
      return branchDiff(realCwd, assertRef(asString(args[0], 'ref')), assertRef(asString(args[1], 'ref')));
    case 'branchFileDiff': {
      const from = assertSha(asString(args[0], 'sha'));
      const to = assertSha(asString(args[1], 'sha'));
      const rel = await validatePathspec(realCwd, asString(args[2], 'pathspec'));
      return branchFileDiff(realCwd, from, to, rel);
    }
    case 'fileHeadDiff':
      return fileHeadDiff(await jailFile(args[0], realCwd, roots));
    case 'stagePath':
      return stagePath(realCwd, await validatePathspec(realCwd, asString(args[0], 'pathspec')));
    case 'unstagePath':
      return unstagePath(realCwd, await validatePathspec(realCwd, asString(args[0], 'pathspec')));
    case 'discardWorktreePath':
      return discardWorktreePath(realCwd, await validatePathspec(realCwd, asString(args[0], 'pathspec')));
    case 'deleteUntrackedPath':
      return deleteUntrackedPath(realCwd, await validatePathspec(realCwd, asString(args[0], 'pathspec')));
    case 'commitStaged':
      return commitStaged(realCwd, asCommitMessage(args[0]));
    case 'stashPush':
      return stashPush(realCwd, asStashMessage(args[0]));
    case 'stashPop':
      return stashPop(realCwd);
    case 'fetchRemotes':
      return fetchRemotes(realCwd);
    case 'pullFastForward':
      return pullFastForward(realCwd);
    case 'switchBranch':
      return switchBranch(realCwd, assertBranchName(asString(args[0], 'branch')));
    case 'createBranch': {
      const name = assertBranchName(asString(args[0], 'branch'));
      const baseRef = args[1] !== undefined ? assertRef(asString(args[1], 'ref')) : undefined;
      return createBranch(realCwd, name, baseRef);
    }
    case 'pushRemote':
      return pushRemote(realCwd, asRemote(args[0]));
    case 'restoreFileToHead':
      return restoreFileToHead(await jailFileForRestore(args[0], realCwd, roots));
    case 'addOperatorWorktree': {
      const branch = assertBranchName(asString(args[0], 'branch'));
      const rawOpts = args[1];
      const opts: { newBranch?: boolean; folder?: string } = {};
      if (rawOpts !== undefined) {
        if (rawOpts === null || typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
          throw new Error('invalid args');
        }
        const o = rawOpts as Record<string, unknown>;
        if (typeof o.newBranch === 'boolean') opts.newBranch = o.newBranch;
        if (typeof o.folder === 'string') opts.folder = o.folder;
      }
      await assertWorktreeParentAllowed(realCwd, roots);
      return addOperatorWorktree(realCwd, branch, opts);
    }
    case 'createSpawnWorktree': {
      const id = asSpawnWorktreeId(args[0]);
      await assertWorktreeParentAllowed(realCwd, roots);
      const wt = createWorktree(realCwd, id);
      return { path: await realpath(wt.path), branch: wt.branch };
    }
    case 'isGitRepo':
      return isGitRepo(realCwd);
    case 'snapshotCode':
      return snapshotCode(realCwd, asShadowId(args[0], 'conversationId'), asShadowId(args[1], 'checkpointId'));
    case 'restoreCode':
      return restoreCode(realCwd, assertSha(asString(args[0], 'codeRef')), asShadowMode(args[1], RESTORE_MODES));
    case 'deleteShadowRef':
      return deleteShadowRef(realCwd, asShadowId(args[0], 'conversationId'), asShadowId(args[1], 'checkpointId'));
    case 'resolveShadowRef':
      return resolveShadowRef(realCwd, asShadowId(args[0], 'conversationId'), asShadowId(args[1], 'checkpointId'));
    case 'codeDiff':
      return codeDiff(
        realCwd,
        assertSha(asString(args[0], 'codeRef')),
        args[1] === undefined ? undefined : asShadowMode(args[1], DIFF_MODES),
      );
    case 'isWorkingTreeClean':
      return isWorkingTreeClean(realCwd);
    case 'currentHead':
      return currentHead(realCwd);
  }
}

/** Sets GIT_TERMINAL_PROMPT=0 when the operator has not set it. */
export function hardenGitEnv(env: NodeJS.ProcessEnv): void {
  if (env.GIT_TERMINAL_PROMPT === undefined) env.GIT_TERMINAL_PROMPT = '0';
}

// ponytail: sync git on node event loop, worker pool if it stalls ev frames
// pushRemote is sync with no timeout — hardenGitEnv makes auth failures fast; a stalled network still blocks the node loop (worker pool is the upgrade)
export async function gitCall(roots: string[], p: unknown): Promise<GitCallResult> {
  const raw = (p ?? {}) as { method?: unknown; cwd?: unknown; args?: unknown };
  const method = raw.method;
  if (typeof method !== 'string' || !ALLOWED.has(method)) {
    throw new RpcError('method_not_allowed', String(method));
  }
  const cwd = raw.cwd;
  if (typeof cwd !== 'string' || !cwd) throw new RpcError('bad_path', 'cwd');
  if (!isAbsolute(cwd)) throw new RpcError('bad_path', 'cwd');
  const realCwd = pathUnderRoots(cwd, roots);
  if (!realCwd) throw new RpcError('path_outside_roots', cwd);
  if (realCwd.split(sep).includes('.git')) throw new RpcError('path_not_allowed', cwd);

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.length > ARITY[method as GitMethod]) {
      return { ok: false, kind: 'error', message: 'invalid args' };
    }
  }
  const args = Array.isArray(raw.args) ? raw.args : [];

  try {
    const r = await dispatch(method as GitMethod, realCwd, args, roots);
    return { ok: true, r };
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e instanceof GitCommandError) {
      return { ok: false, kind: 'git', stderr: e.stderr, stdout: e.stdout, exitCode: e.status };
    }
    return { ok: false, kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
