import {
  existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'fs';
import { join, resolve, sep } from 'path';
import { randomBytes } from 'crypto';
import type { SchedulePackFile } from '@tierwyn/shared';
import { PACK_SLUG_RE } from '@tierwyn/shared';
import { PROJECT_STATE_DIR } from '../config/brand.js';

function withTrailingSep(abs: string): string {
  return abs.endsWith(sep) ? abs : abs + sep;
}

function underProject(abs: string, realProject: string): boolean {
  return withTrailingSep(abs).startsWith(withTrailingSep(realProject));
}

export class PackFileConflict extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super('pack file conflict');
    this.name = 'PackFileConflict';
    this.conflicts = conflicts;
  }
}

export class PackFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackFilePathError';
  }
}

/**
 * Apply-time [[token]] substitution. One scan of the original string so a value
 * containing `[[…]]` is not re-expanded. Values are copied verbatim (no
 * String.replace), so `$&` / `$1` in operator text cannot corrupt the output.
 * A loop of split/join over the token table (prompt.ts) would re-scan values.
 */
export function substitutePackTokens(body: string, vars: Record<string, string>): string {
  const parts: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    parts.push(body.slice(last, m.index));
    const key = m[1]!;
    parts.push(Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : m[0]);
    last = m.index + m[0].length;
  }
  parts.push(body.slice(last));
  return parts.join('');
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * If `path` exists, require its realpath to sit under `realProject`.
 * Symlinked parents that escape are refused before any mkdir.
 * Absent paths are fine (caller may create them later under the project).
 */
function assertExistingPathInsideProject(path: string, realProject: string): void {
  let real: string;
  try {
    real = realpathSync(path);
  } catch (err) {
    if (isEnoent(err)) return;
    throw new PackFilePathError('schedule directory escapes project root');
  }
  if (!underProject(real, realProject)) {
    throw new PackFilePathError('schedule directory escapes project root');
  }
}

/**
 * lstat without following. ENOENT → absent (null). Any other error → path error.
 */
function lstatOrAbsent(abs: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(abs);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new PackFilePathError('target escapes schedule directory');
  }
}

/**
 * Write pack files under `<projectRoot>/.tierwyn/schedule/<jobSlug>-<kind>.md`.
 * ponytail: filenames are derived from jobSlug + a closed kind enum rather than
 * supplied — that is what makes traversal unreachable, not a sanitiser.
 *
 * Writes go temp-file (`wx`) + `renameSync` so a dangling symlink at the target
 * is replaced rather than followed (overwrite escape). Non-dangling symlinks
 * are still refused on overwrite.
 */
export function materialisePackFiles(
  projectRootPath: string,
  jobSlug: string,
  files: SchedulePackFile[],
  vars: Record<string, string>,
  opts: { overwrite?: boolean } = {},
): { written: string[] } {
  if (!PACK_SLUG_RE.test(jobSlug)) {
    throw new PackFilePathError('invalid job slug');
  }

  let st;
  try {
    st = statSync(projectRootPath);
  } catch {
    throw new PackFilePathError('project root does not exist');
  }
  if (!st.isDirectory()) {
    throw new PackFilePathError('project root does not exist');
  }

  let realProject: string;
  try {
    realProject = realpathSync(projectRootPath);
  } catch {
    throw new PackFilePathError('project root does not exist');
  }

  const brandPath = resolve(realProject, '.tierwyn');
  const schedulePath = resolve(realProject, '.tierwyn', 'schedule');
  // Escape-check existing parents BEFORE any mkdir — a symlinked `.tierwyn`
  // must not get an empty `schedule/` created outside the project.
  assertExistingPathInsideProject(brandPath, realProject);
  assertExistingPathInsideProject(schedulePath, realProject);

  mkdirSync(schedulePath, { recursive: true });

  let realRoot: string;
  try {
    realRoot = realpathSync(schedulePath);
  } catch {
    throw new PackFilePathError('project root does not exist');
  }
  if (!underProject(realRoot, realProject)) {
    throw new PackFilePathError('schedule directory escapes project root');
  }

  const planned: Array<{ abs: string; rel: string; body: string; kind: SchedulePackFile['kind'] }> = [];
  for (const file of files) {
    const name = `${jobSlug}-${file.kind}.md`;
    const target = resolve(realRoot, name);
    if (!withTrailingSep(target).startsWith(withTrailingSep(realRoot))) {
      throw new PackFilePathError('target escapes schedule directory');
    }
    planned.push({
      abs: target,
      rel: `.tierwyn/schedule/${name}`,
      body: substitutePackTokens(file.body, vars),
      kind: file.kind,
    });
  }

  if (!opts.overwrite) {
    const conflicts: string[] = [];
    for (const p of planned) {
      // Any directory entry (regular file OR symlink, dangling or not) conflicts.
      if (lstatOrAbsent(p.abs)) conflicts.push(p.rel);
    }
    if (conflicts.length) throw new PackFileConflict(conflicts);
  } else {
    for (const p of planned) {
      const lst = lstatOrAbsent(p.abs);
      if (!lst) continue;
      if (lst.isSymbolicLink()) {
        // Non-dangling symlink → refuse (would otherwise rename-replace, but
        // the live target may sit outside the project; keep prior policy).
        // Dangling → allow: rename replaces the link inode without following.
        let dangling = false;
        try {
          statSync(p.abs);
        } catch {
          dangling = true;
        }
        if (!dangling) {
          throw new PackFilePathError('target escapes schedule directory');
        }
      }
    }
  }

  const written: string[] = [];
  const absWritten: string[] = [];
  const temps: string[] = [];
  try {
    for (const p of planned) {
      const tmp = join(
        realRoot,
        `.pack-${jobSlug}-${p.kind}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
      );
      writeFileSync(tmp, p.body, { flag: 'wx' });
      temps.push(tmp);
      // rename replaces a dangling symlink inode; it does not follow the link.
      renameSync(tmp, p.abs);
      // temp is gone after successful rename
      temps.pop();
      absWritten.push(p.abs);
      written.push(p.rel);
    }
  } catch (err) {
    for (const t of temps) {
      try { unlinkSync(t); } catch { /* best-effort */ }
    }
    for (const abs of absWritten) {
      try { unlinkSync(abs); } catch { /* best-effort */ }
    }
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST') {
      throw new PackFileConflict(
        planned.filter((p) => lstatOrAbsent(p.abs)).map((p) => p.rel),
      );
    }
    throw err;
  }
  return { written };
}

/**
 * Best-effort unlink of computed pack file names. Refuses to follow/remove
 * symlinks (file or parent dir). Ignores missing files. Slug must pass PACK_SLUG_RE.
 */
export function unlinkPackFiles(
  projectRootPath: string,
  jobSlug: string,
  kinds: SchedulePackFile['kind'][],
): void {
  if (!PACK_SLUG_RE.test(jobSlug)) return;
  let realProject: string;
  try {
    realProject = realpathSync(projectRootPath);
  } catch {
    return;
  }
  for (const stateDir of [PROJECT_STATE_DIR]) {
    const scheduleLexical = resolve(realProject, stateDir, 'schedule');
    let realSchedule: string;
    try {
      realSchedule = realpathSync(scheduleLexical);
    } catch (err) {
      if (isEnoent(err)) continue;
      continue;
    }
    if (!underProject(realSchedule, realProject)) continue;

    for (const kind of kinds) {
      const name = `${jobSlug}-${kind}.md`;
      const target = resolve(realSchedule, name);
      if (!withTrailingSep(target).startsWith(withTrailingSep(realSchedule))) continue;
      try {
        const lst = lstatOrAbsent(target);
        if (!lst) continue;
        if (lst.isSymbolicLink()) continue;
        unlinkSync(target);
      } catch {
        /* best-effort */
      }
    }
  }
}
