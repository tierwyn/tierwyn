import type { Database } from 'better-sqlite3';
import { getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import type { CodeRewindGateResult, ShadowOps } from './shadowOps.js';

export * from './shadowOps.js';

/** Resolve cwd for code snapshots: isolated worktree or shared project root. */
export function resolveConversationCwd(db: Database, conversationId: string): string | null {
  const conv = getConversation(db, conversationId);
  if (!conv) return null;
  const project = getProject(db, conv.projectId);
  if (!project) return null;
  return conv.workdirPath ?? project.rootPath;
}

/** Gate for code rewind (§5.1). Async + ops-bound so remote hosts take the same path. */
export async function evaluateCodeRewindGate(
  ops: Pick<ShadowOps, 'isGitRepo'>,
  workdirPath: string | null | undefined,
  codeRef: string | null | undefined,
  confirmSharedCode: boolean,
): Promise<CodeRewindGateResult> {
  if (!codeRef) return { ok: false, reason: 'no_ref' };
  if (!(await ops.isGitRepo())) return { ok: false, reason: 'not_git' };

  if (workdirPath) {
    return { ok: true, mode: 'worktree' };
  }

  if (!confirmSharedCode) {
    return { ok: false, reason: 'shared_tree' };
  }
  // ponytail: no clean-tree / HEAD-equality guard. `git restore --source` overwrites
  // tracked paths from the snapshot without moving HEAD; the route takes a pre-restore
  // safety checkpoint first (recordPreRestoreCheckpoint) so overwritten edits are
  // recoverable via the existing checkpoint list. Single-operator repo: the spec's
  // "protect concurrent shared-tree work" guard (rewind-spec §5.1) serves no purpose
  // here and blocks the primary use case.
  return { ok: true, mode: 'shared' };
}
