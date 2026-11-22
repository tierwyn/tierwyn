/**
 * C18: at session start in a git cwd, append `/.tierwyn/` to `.git/info/exclude`
 * if missing. Idempotent. Never touches the tracked `.gitignore`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { gitSync } from './gitExec.js';
import { isGitRepo } from '../worktree.js';

const EXCLUDE_LINE = '/.tierwyn/';

export function ensureProjectStateGitExclude(cwd: string): void {
  if (!cwd || !isGitRepo(cwd)) return;
  let gitDir: string;
  try {
    gitDir = gitSync(cwd, ['rev-parse', '--git-dir'], { skipConfigScan: true }).trim();
  } catch {
    return;
  }
  if (!gitDir) return;
  const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
  const infoDir = join(absGitDir, 'info');
  const excludePath = join(infoDir, 'exclude');
  try {
    mkdirSync(infoDir, { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    if (lines.some((l) => l.trim() === EXCLUDE_LINE)) return;
    const body = existing.length === 0 || existing.endsWith('\n')
      ? `${existing}${EXCLUDE_LINE}\n`
      : `${existing}\n${EXCLUDE_LINE}\n`;
    writeFileSync(excludePath, body);
  } catch {
    // best-effort — a missing exclude must never block a session
  }
}
