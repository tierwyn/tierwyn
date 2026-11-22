import { basename, join } from 'path';
import { gitSync } from './git/gitExec.js';

/** True when `dir` is inside a git work tree. Cheap, non-throwing. */
export function isGitRepo(dir: string): boolean {
  try {
    const out = gitSync(dir, ['rev-parse', '--is-inside-work-tree'], { skipConfigScan: true }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * Create a git worktree off `projectRoot` for a child conversation.
 * Branch + dir are named from the conversation id so they're traceable.
 * Worktrees are NOT auto-removed — cleanup/merge is operator-driven.
 * ponytail: worktree dir is a sibling of the repo; collisions raise (git errors loudly).
 */
export function createWorktree(projectRoot: string, conversationId: string): { path: string; branch: string } {
  const short = conversationId.slice(0, 8);
  const branch = `tierwyn/spawn-${short}`;
  const path = join(projectRoot, '..', `${basename(projectRoot)}-spawn-${short}`);
  gitSync(projectRoot, ['worktree', 'add', '-b', branch, path], { profile: 'background' });
  return { path, branch };
}
