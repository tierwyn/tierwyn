import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { envPref } from '../config/env.js';
import { isGitRepo } from '../worktree.js';
import { gitSync } from './gitExec.js';
export { isGitRepo };

export type CodeRestoreMode = 'worktree' | 'shared';
export type CodeSkippedReason = 'shared_tree' | 'diverged' | 'no_ref' | 'not_git' | 'remote_host';

export interface CodeRewindGateOk {
  ok: true;
  mode: CodeRestoreMode;
}

export interface CodeRewindGateFail {
  ok: false;
  reason: CodeSkippedReason;
}

export type CodeRewindGateResult = CodeRewindGateOk | CodeRewindGateFail;

function git(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): string {
  return gitSync(cwd, args, { profile: 'background', env: extraEnv }).trim();
}

function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

const TIERWYN_CHECKPOINT_NS = 'refs/tierwyn/checkpoints';
// Legacy namespaces, kept for upgrade compatibility (C26):
// still listed and resolved as fallbacks for checkpoints created before the rename.
const NUNCII_CHECKPOINT_NS = 'refs/nuncii/checkpoints';

function writeCheckpointNs(): string {
  return envPref('CHECKPOINT_NS')?.trim() || TIERWYN_CHECKPOINT_NS;
}

function resolveCheckpointNamespaces(): string[] {
  const write = writeCheckpointNs();
  const rest = [TIERWYN_CHECKPOINT_NS, NUNCII_CHECKPOINT_NS].filter((ns) => ns !== write);
  return [write, ...rest];
}

function checkpointRef(ns: string, conversationId: string, checkpointId: string): string {
  return `${ns}/${conversationId}/${checkpointId}`;
}

/** Parent HEAD recorded as commit^ on the shadow commit (§5.2). */
export function parentHeadForCodeRef(cwd: string, codeRef: string): string | null {
  return tryGit(cwd, ['rev-parse', '-q', '--verify', `${codeRef}^`]);
}

/** Snapshot working tree into a private shadow ref; never touches HEAD/index/branches.
 *  Returns null when the working tree is identical to its parent — there is nothing
 *  distinct to roll back to, so no `code_ref` is recorded. This keeps the "Code"
 *  badge an honest signal that a restore would actually change files. */
export function snapshotCode(cwd: string, conversationId: string, checkpointId: string): string | null {
  if (!isGitRepo(cwd)) return null;

  const tmpDir = mkdtempSync(join(tmpdir(), 'tierwyn-idx-'));
  const indexFile = join(tmpDir, 'index');
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(cwd, ['add', '-A'], env);
    const tree = git(cwd, ['write-tree'], env);
    const parent = tryGit(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
    // No working-tree changes since HEAD (or no HEAD at all on an empty repo):
    // nothing distinct to record. Skip the snapshot so codeRef stays null.
    if (parent && tree === tryGit(cwd, ['rev-parse', `${parent}^{tree}`])) {
      return null;
    }
    const commitArgs = ['commit-tree', tree];
    if (parent) commitArgs.push('-p', parent);
    commitArgs.push('-m', `tierwyn-checkpoint ${checkpointId}`);
    const commit = git(cwd, commitArgs, env);
    const ref = checkpointRef(writeCheckpointNs(), conversationId, checkpointId);
    git(cwd, ['update-ref', ref, commit]);
    return commit;
  } catch {
    return null;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function restoreCode(cwd: string, codeRef: string, mode: CodeRestoreMode): void {
  if (mode === 'worktree') {
    git(cwd, ['reset', '--hard', codeRef]);
    git(cwd, ['clean', '-fd']);
  } else {
    git(cwd, ['restore', '--source', codeRef, '--staged', '--worktree', '--', '.']);
  }
}

export function deleteShadowRef(cwd: string, conversationId: string, checkpointId: string): void {
  if (!isGitRepo(cwd)) return;
  for (const ns of resolveCheckpointNamespaces()) {
    try {
      git(cwd, ['update-ref', '-d', checkpointRef(ns, conversationId, checkpointId)]);
    } catch { /* best-effort */ }
  }
}

/** Resolve a shadow checkpoint SHA, preferring tierwyn then nuncii. */
export function resolveShadowRef(cwd: string, conversationId: string, checkpointId: string): string | null {
  for (const ns of resolveCheckpointNamespaces()) {
    const hit = tryGit(cwd, ['rev-parse', '-q', '--verify', checkpointRef(ns, conversationId, checkpointId)]);
    if (hit) return hit;
  }
  return null;
}

export type CodeDiffMode = 'restore' | 'captured';

/** Agent-internal dirs that `git add -A` sweeps into snapshots but are not
 *  user-visible "code". Excluded from diff views so the View-Diff popup shows
 *  real project changes (e.g. .claude/worktrees, etc.). */
const AGENT_INTERNAL_EXCLUDES = [
  '.claude',
  '.opencode',
  '.antigravity',
  '.cursor',
  '.hermes',
  '.agi',
  '.gemini',
];

/** Compute a diff for a checkpoint's code snapshot.
 *  - 'restore' (default): working tree vs checkpoint — what restoring would change.
 *    Includes untracked files, since they'd be wiped by a `git clean`.
 *  - 'captured': checkpoint vs its parent — what the checkpoint actually represents.
 *    By construction (snapshotCode skips no-op trees) this is always non-empty.
 *  Both modes exclude agent-internal dirs (.claude, …) — they're
 *  agent bookkeeping, not user code, and pollute the diff view. */
export function codeDiff(cwd: string, codeRef: string, mode: CodeDiffMode = 'restore'): string | null {
  if (!isGitRepo(cwd)) return null;
  try {
    const pathspecs = ['--', '.', ...AGENT_INTERNAL_EXCLUDES.map((d) => `:(exclude)${d}`)];
    if (mode === 'captured') {
      const parent = tryGit(cwd, ['rev-parse', '-q', '--verify', `${codeRef}^`]);
      const range = parent ? `${codeRef}^..${codeRef}` : codeRef;
      return git(cwd, ['diff', range, ...pathspecs]);
    }
    const diff = git(cwd, ['diff', codeRef, ...pathspecs]);
    const untracked = tryGit(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.', ...AGENT_INTERNAL_EXCLUDES.map((d) => `:(exclude)${d}`)]);
    if (!untracked) return diff;
    return [diff, `Untracked files:\n${untracked}`].filter(Boolean).join('\n\n');
  } catch {
    return null;
  }
}

export function isWorkingTreeClean(cwd: string): boolean {
  return tryGit(cwd, ['status', '--porcelain']) === '';
}

export function currentHead(cwd: string): string | null {
  return tryGit(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
}

/**
 * Cwd-bound shadow-checkpoint operations. The hub resolves either a local
 * (`localShadowOpsFor`) or remote (`RemoteShadowOps` over `git.call`) binding
 * from the conversation's host, so callers never branch on remote vs local.
 */
export interface ShadowOps {
  isGitRepo(): Promise<boolean>;
  snapshotCode(conversationId: string, checkpointId: string): Promise<string | null>;
  restoreCode(codeRef: string, mode: CodeRestoreMode): Promise<void>;
  deleteShadowRef(conversationId: string, checkpointId: string): Promise<void>;
  resolveShadowRef(conversationId: string, checkpointId: string): Promise<string | null>;
  codeDiff(codeRef: string, mode?: CodeDiffMode): Promise<string | null>;
  isWorkingTreeClean(): Promise<boolean>;
  currentHead(): Promise<string | null>;
}

/** Local (same-host) binding: thin async wrappers over the sync git helpers. */
export function localShadowOpsFor(cwd: string): ShadowOps {
  return {
    isGitRepo: async () => isGitRepo(cwd),
    snapshotCode: async (conversationId, checkpointId) => snapshotCode(cwd, conversationId, checkpointId),
    restoreCode: async (codeRef, mode) => { restoreCode(cwd, codeRef, mode); },
    deleteShadowRef: async (conversationId, checkpointId) => { deleteShadowRef(cwd, conversationId, checkpointId); },
    resolveShadowRef: async (conversationId, checkpointId) => resolveShadowRef(cwd, conversationId, checkpointId),
    codeDiff: async (codeRef, mode) => codeDiff(cwd, codeRef, mode),
    isWorkingTreeClean: async () => isWorkingTreeClean(cwd),
    currentHead: async () => currentHead(cwd),
  };
}
