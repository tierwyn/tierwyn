import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FsMoveParams, FsMoveResult } from '@tierwyn/shared';
import { pathUnderRoots } from './policy.js';
import { RpcError } from './rpc.js';
import { gitArgv } from '../git/gitExec.js';

export function fsMove(
  roots: string[],
  p: FsMoveParams,
  opts?: { git?: string },
): FsMoveResult {
  // 1. Validate `from`
  if (
    typeof p?.from !== 'string' || !p.from
    || !isAbsolute(p.from) || p.from.includes('\0')
    || resolve(p.from) !== p.from
    || basename(p.from) === '' || basename(p.from) === '.' || basename(p.from) === '..'
  ) {
    throw new RpcError('bad_path', 'invalid source path');
  }
  if (p.from.split(/[/\\]+/).includes('.git')) {
    throw new RpcError('bad_path', 'source path cannot contain .git segment');
  }

  // 2. lstatSync(from)
  let fromStat;
  try {
    fromStat = lstatSync(p.from);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RpcError('not_found', 'source not found');
    }
    throw new RpcError('move_failed', (err as NodeJS.ErrnoException).code ?? 'cannot inspect source');
  }
  if (fromStat.isSymbolicLink()) {
    throw new RpcError('source_symlink', 'source is a symlink');
  }
  if (!fromStat.isDirectory()) {
    throw new RpcError('not_dir', 'source is not a directory');
  }

  // 3. realFrom = pathUnderRoots(from, roots)
  const realFrom = pathUnderRoots(p.from, roots);
  if (!realFrom) {
    throw new RpcError('path_outside_roots', 'source outside roots');
  }
  for (const root of roots) {
    let realRoot: string | undefined;
    try {
      realRoot = realpathSync(root);
    } catch {
      /* ignore unresolvable root */
    }
    if (realRoot && realRoot === realFrom) {
      throw new RpcError('source_is_root', 'source cannot be a root directory');
    }
  }

  // 4. Validate `to`
  if (
    typeof p?.to !== 'string' || !p.to
    || !isAbsolute(p.to) || p.to.includes('\0')
    || resolve(p.to) !== p.to
    || basename(p.to) === '' || basename(p.to) === '.' || basename(p.to) === '..'
  ) {
    throw new RpcError('bad_path', 'invalid target path');
  }
  if (p.to.split(/[/\\]+/).includes('.git')) {
    throw new RpcError('bad_path', 'target path cannot contain .git segment');
  }

  // 5. Check target ancestor & roots
  let ancestor = dirname(p.to);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = pathUnderRoots(ancestor, roots);
  if (!realAncestor) {
    throw new RpcError('path_outside_roots', 'target parent outside roots');
  }
  const target = join(realAncestor, relative(ancestor, p.to));

  // 6. Same / inside self
  if (target === realFrom || p.to === p.from) {
    throw new RpcError('same_path', 'source and target are the same path');
  }
  if (target.startsWith(realFrom + sep) || p.to.startsWith(p.from + sep)) {
    throw new RpcError('into_self', 'cannot move a folder inside itself');
  }

  // 7. Target lstat exists check
  try {
    const targetStat = lstatSync(target);
    const sourceStat = statSync(realFrom);
    if (targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) {
      // Same inode (e.g. case-only rename on case-insensitive fs) - continue
    } else if (targetStat.isDirectory()) {
      if (readdirSync(target).length > 0) {
        throw new RpcError('exists', 'target directory is not empty');
      }
    } else {
      throw new RpcError('exists', 'target already exists');
    }
  } catch (err: unknown) {
    if (err instanceof RpcError) throw err;
    // ENOENT is expected when target does not exist
  }

  // 8. Cross-device check
  if (statSync(realAncestor).dev !== statSync(realFrom).dev) {
    throw new RpcError('cross_device', 'cannot move across filesystems');
  }

  // 9. Writable check
  try {
    accessSync(realAncestor, constants.W_OK);
    accessSync(dirname(realFrom), constants.W_OK);
  } catch {
    throw new RpcError('move_failed', 'directory not writable');
  }

  // 10. dryRun check
  if (p.dryRun) {
    return { path: target, moved: false };
  }

  // 11. Create missing parent directories inside roots (Q1)
  if (!existsSync(dirname(target))) {
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch (err: unknown) {
      throw new RpcError('parent_missing', `cannot create parent directory: ${(err as NodeJS.ErrnoException).code ?? err}`);
    }
  }

  // 12. renameSync
  try {
    renameSync(realFrom, target);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') throw new RpcError('cross_device', 'cannot move across filesystems');
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') throw new RpcError('exists', 'target already exists');
    if (code === 'EINVAL') throw new RpcError('into_self', 'cannot move a folder inside itself');
    throw new RpcError('move_failed', code ?? 'move failed');
  }

  // 13. Git repair
  let repairError: string | undefined;
  const gitPath = join(target, '.git');
  if (existsSync(gitPath)) {
    const gitBin = opts?.git ?? 'git';
    try {
      const stat = statSync(gitPath);
      if (stat.isDirectory()) {
        const listOut = execFileSync(gitBin, gitArgv(['-C', target, 'worktree', 'list', '--porcelain'], 'background'), {
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf8',
        });
        const wtPaths: string[] = [];
        const lines = listOut.split('\n');
        let isFirst = true;
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            const wt = line.slice('worktree '.length).trim();
            if (isFirst) {
              isFirst = false;
            } else if (wt && existsSync(wt)) {
              wtPaths.push(wt);
            }
          }
        }
        if (wtPaths.length > 0) {
          execFileSync(gitBin, gitArgv(['-C', target, 'worktree', 'repair', ...wtPaths], 'background'), {
            timeout: 30_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }
      } else if (stat.isFile()) {
        execFileSync(gitBin, gitArgv(['-C', target, 'worktree', 'repair'], 'background'), {
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer | string }).stderr;
      const msg = stderr ? String(stderr) : (err as Error).message;
      repairError = msg.slice(0, 500);
    }
  }

  return { path: realpathSync(target), moved: true, ...(repairError ? { repairError } : {}) };
}
