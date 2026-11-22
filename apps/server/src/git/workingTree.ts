import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type {
  GitPathStatus, GitRemoteRef, GitWorkingTreeFile,
  GitCommitSummary, GitCommitDetail, GitCommitFileChange, GitCommitFileStatus,
  GitCommitDiffResponse, GitCommitFileResponse,
  GitBranchRef, GitBranchesResponse, GitBranchDiffResponse,
} from '@tierwyn/shared';
import { realpathWithinRoots } from '../files/listing.js';
import { isGitRepo } from '../worktree.js';
import { gitAsync, gitSync, profileFor, GitCommandError } from './gitExec.js';
export { GitCommandError, GitUnsafeConfigError } from './gitExec.js';

const SHA_RE = /^[0-9a-fA-F]{4,64}$/;

/** Only bare hex object names. Rejects `HEAD@{1}`, `--upload-pack=…`, `..`, refs. */
export function assertSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error('invalid sha');
  return sha;
}

// refs: letters digits . / - _ + ; no leading '-' or '.'; no '..', '//', '@{', trailing '/', '.lock', or '.'
const BRANCH_RE = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\.lock$|\/$|\.$))[\p{L}\p{N}._\/+-]{1,200}$/u;

export function assertBranchName(name: string): string {
  if (!BRANCH_RE.test(name)) throw new Error('invalid branch name');
  return name;
}

export function assertRef(ref: string): string {
  if (ref === 'HEAD' || SHA_RE.test(ref) || BRANCH_RE.test(ref)) return ref;
  throw new Error('invalid ref');
}

export function assertFolderName(folder: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(folder) || folder === '.' || folder === '..' || folder.startsWith('-') || folder.startsWith('.')) {
    throw new Error('invalid folder name');
  }
  return folder;
}

export async function gitExecAsync(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return gitAsync(cwd, args, { profile: profileFor(args), timeoutMs });
}

export function isNonFastForwardError(err: GitCommandError): boolean {
  return /not possible to fast-forward|diverging branches|non-fast-forward/i.test(err.stderr);
}


export function gitExec(cwd: string, args: string[], opts?: { input?: string }): string {
  return gitSync(cwd, args, { profile: profileFor(args), input: opts?.input });
}

export function sanitizeRemoteUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = '';
    if (parsed.username) parsed.username = '';
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/[^@]+@/, '//');
  }
}

export function listRemotes(cwd: string): GitRemoteRef[] {
  if (!isGitRepo(cwd)) return [];
  try {
    const raw = gitExec(cwd, ['remote', '-v']).trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const seen = new Set<string>();
    const remotes: GitRemoteRef[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0];
        const rawUrl = parts[1];
        if (!seen.has(name)) {
          seen.add(name);
          remotes.push({
            name,
            url: sanitizeRemoteUrl(rawUrl),
          });
        }
      }
    }
    return remotes;
  } catch {
    return [];
  }
}

export interface ParsedXY {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

export function parsePorcelainStatus(raw: string): { branchHeader: string | null; files: ParsedXY[] } {
  if (!raw) return { branchHeader: null, files: [] };
  const tokens = raw.split('\0').filter((t, i, arr) => t.length > 0 || i < arr.length - 1);
  const trimmed = tokens[tokens.length - 1] === '' ? tokens.slice(0, -1) : tokens;

  let branchHeader: string | null = null;
  const files: ParsedXY[] = [];
  let i = 0;

  if (trimmed[0]?.startsWith('##')) {
    branchHeader = trimmed[0];
    i = 1;
  }

  while (i < trimmed.length) {
    const entry = trimmed[i];
    if (!entry || entry.length < 3) {
      i += 1;
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    let origPath: string | undefined;
    if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && i + 1 < trimmed.length) {
      origPath = trimmed[i + 1];
      i += 2;
    } else {
      i += 1;
    }
    files.push({ x, y, path, origPath });
  }

  return { branchHeader, files };
}

function xyStatus(x: string, y: string, staged: boolean): GitPathStatus {
  if (isConflicted(x, y)) return 'conflicted';
  const c = staged ? x : y;
  if (c === '?' || c === 'A') return 'new';
  if (c === 'D') return 'deleted';
  if (c === 'R' || c === 'C') return 'renamed';
  return 'modified';
}

function isConflicted(x: string, y: string): boolean {
  const pair = `${x}${y}`;
  if (['AA', 'UU', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(pair)) return true;
  return x === 'U' || y === 'U';
}

function isStagedIndex(x: string): boolean {
  return x !== ' ' && x !== '?';
}

function isUnstagedIndex(y: string, x: string): boolean {
  if (x === '?' && y === '?') return true;
  return y !== ' ' && y !== '?';
}

export function groupXy(
  files: ParsedXY[],
  treeRoot: string,
): { staged: GitWorkingTreeFile[]; unstaged: GitWorkingTreeFile[]; hasConflicts: boolean } {
  const staged: GitWorkingTreeFile[] = [];
  const unstaged: GitWorkingTreeFile[] = [];
  let hasConflicts = false;

  for (const f of files) {
    const base = {
      path: f.path.replace(/\\/g, '/'),
      origPath: f.origPath?.replace(/\\/g, '/'),
      absPath: join(treeRoot, f.path),
    };
    if (isConflicted(f.x, f.y)) hasConflicts = true;
    if (isStagedIndex(f.x)) {
      staged.push({ ...base, status: xyStatus(f.x, f.y, true) });
    }
    if (isUnstagedIndex(f.y, f.x)) {
      unstaged.push({ ...base, status: xyStatus(f.x, f.y, false) });
    }
  }

  return { staged, unstaged, hasConflicts };
}

export async function validatePathspec(treeRoot: string, relPath: string): Promise<string> {
  if (!relPath || relPath.includes('\0')) {
    throw new Error('invalid pathspec');
  }
  if (isAbsolute(relPath)) {
    throw new Error('absolute pathspec rejected');
  }
  const abs = resolve(treeRoot, relPath);
  const rootResolved = resolve(treeRoot);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error('pathspec escapes tree');
  }
  for (const seg of relPath.split(/[/\\]/)) {
    if (seg === '.git' || seg === '..') {
      throw new Error('pathspec contains forbidden segment');
    }
  }
  const { existsSync, lstatSync } = await import('fs');
  if (existsSync(abs)) {
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) {
      // A symlink is a single git object (mode 120000): stage/delete the link
      // itself, not its target's contents. Target must stay inside the tree.
      const real = await realpathWithinRoots(abs, [treeRoot]);
      if (!real) throw new Error('pathspec escapes tree via symlink');
      return relPath.replace(/\\/g, '/');
    }
    if (lst.isDirectory()) {
      throw new Error('directory pathspec rejected');
    }
    const real = await realpathWithinRoots(abs, [treeRoot]);
    if (!real) throw new Error('pathspec escapes tree via symlink');
    const rel = relative(treeRoot, real).split(sep).join('/');
    return rel;
  }
  return relPath.replace(/\\/g, '/');
}

export interface WorkingTreeReadResult {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  headSha: string;
  staged: GitWorkingTreeFile[];
  unstaged: GitWorkingTreeFile[];
  hasConflicts: boolean;
  remotes: GitRemoteRef[];
  upstream: string | null;
  ahead: number;
  behind: number;
  stashCount?: number;
  stashTop?: string;
}

export function stashPush(cwd: string, message?: string): void {
  let m = message?.trim();
  if (m) {
    m = m.replace(/[\r\n]+/g, ' ').slice(0, 200).trim();
  }
  const args = ['stash', 'push', '-u'];
  if (m) {
    args.push('-m', m);
  }
  gitExec(cwd, args);
}

export function stashPop(cwd: string): void {
  try {
    gitExec(cwd, ['stash', 'pop']);
  } catch (e) {
    if (e instanceof GitCommandError) {
      if (/CONFLICT/i.test(e.stdout) || /CONFLICT/i.test(e.stderr)) {
        throw e;
      }
      try {
        const unmerged = gitExec(cwd, ['diff', '--name-only', '--diff-filter=U']).trim();
        if (unmerged) {
          throw new GitCommandError(e.args, e.stderr || 'CONFLICT', e.status, e.stdout || 'CONFLICT');
        }
      } catch (inner) {
        if (inner instanceof GitCommandError && (inner.stderr === 'CONFLICT' || inner.stdout === 'CONFLICT')) throw inner;
      }
    }
    throw e;
  }
}

export function readStashTop(cwd: string): { count: number; top?: string } {
  try {
    const raw = gitExec(cwd, ['stash', 'list', '--format=%gs']).trim();
    if (!raw) return { count: 0 };
    const lines = raw.split('\n').filter(Boolean);
    return { count: lines.length, top: lines[0] };
  } catch {
    return { count: 0 };
  }
}

export function countFileLines(absPath: string): { added?: number; deleted?: number; binary: boolean } {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return { binary: false };
    if (st.size > 10 * 1024 * 1024) {
      return { binary: true };
    }
    if (st.size === 0) {
      return { added: 0, deleted: 0, binary: false };
    }
    const buf = readFileSync(absPath);
    const checkLen = Math.min(buf.length, 8000);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) {
        return { binary: true };
      }
    }
    let lines = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) lines++;
    }
    if (buf.length > 0 && buf[buf.length - 1] !== 10) {
      lines++;
    }
    return { added: lines, deleted: 0, binary: false };
  } catch {
    return { binary: false };
  }
}

export function readWorkingTree(cwd: string): WorkingTreeReadResult {
  if (!isGitRepo(cwd)) {
    return {
      isRepo: false,
      branch: '',
      detached: false,
      headSha: '',
      staged: [],
      unstaged: [],
      hasConflicts: false,
      remotes: [],
      upstream: null,
      ahead: 0,
      behind: 0,
      stashCount: 0,
    };
  }

  const treeRoot = gitExec(cwd, ['rev-parse', '--show-toplevel']).trim();
  const raw = gitExec(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const { files } = parsePorcelainStatus(raw);
  const { staged, unstaged, hasConflicts } = groupXy(files, treeRoot);

  if (staged.length > 0) {
    let stagedNumRaw = '';
    try {
      stagedNumRaw = gitExec(cwd, ['diff', '--cached', '--numstat', '-z', '--no-color', '--no-ext-diff', '-M']);
    } catch {
      try {
        stagedNumRaw = gitExec(cwd, ['diff', '--cached', '--numstat', '-z', '--no-color', '--no-ext-diff', '-M', '4b825dc642cb6eb9a060e54bf8d69288fbee4904']);
      } catch {
        stagedNumRaw = '';
      }
    }
    const stagedStats = new Map(parseNumstatZ(stagedNumRaw).map((n) => [n.path, n]));
    for (const f of staged) {
      const s = stagedStats.get(f.path);
      if (s) {
        f.addedLines = s.added;
        f.deletedLines = s.deleted;
        f.binary = s.binary;
      }
    }
  }

  if (unstaged.length > 0) {
    let unstagedNumRaw = '';
    try {
      unstagedNumRaw = gitExec(cwd, ['diff', '--numstat', '-z', '--no-color', '--no-ext-diff', '-M']);
    } catch {
      unstagedNumRaw = '';
    }
    const unstagedStats = new Map(parseNumstatZ(unstagedNumRaw).map((n) => [n.path, n]));
    for (const f of unstaged) {
      const s = unstagedStats.get(f.path);
      if (s) {
        f.addedLines = s.added;
        f.deletedLines = s.deleted;
        f.binary = s.binary;
      } else if (f.status === 'new') {
        const stats = countFileLines(f.absPath);
        f.addedLines = stats.added;
        f.deletedLines = stats.deleted;
        f.binary = stats.binary;
      }
    }
  }

  let branch = 'HEAD';
  let detached = false;
  try {
    branch = gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    detached = branch === 'HEAD';
  } catch {
    branch = 'HEAD';
    detached = true;
  }

  let headSha = '';
  try {
    headSha = gitExec(cwd, ['rev-parse', '--short', 'HEAD']).trim();
  } catch {
    headSha = '';
  }

  const remotes = listRemotes(cwd);
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (!detached && branch && branch !== 'HEAD') {
    try {
      upstream = gitExec(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).trim();
    } catch {
      upstream = null;
    }

    if (upstream) {
      try {
        const counts = gitExec(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).trim();
        const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
        if (!isNaN(a)) ahead = a;
        if (!isNaN(b)) behind = b;
      } catch {
        ahead = 0;
        behind = 0;
      }
    }
  }

  const { count: stashCount, top: stashTop } = readStashTop(cwd);

  return {
    isRepo: true,
    branch,
    detached,
    headSha,
    staged,
    unstaged,
    hasConflicts,
    remotes,
    upstream,
    ahead,
    behind,
    stashCount,
    stashTop,
  };
}

export function stagePath(cwd: string, relPath: string): void {
  gitExec(cwd, ['add', '--', `:(literal)${relPath}`]);
}

export function unstagePath(cwd: string, relPath: string): void {
  gitExec(cwd, ['restore', '--staged', '--', `:(literal)${relPath}`]);
}

export function commitStaged(cwd: string, message: string): string {
  const trimmed = message.trim();
  const input = trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  gitExec(cwd, ['commit', '-F', '-'], { input });
  return gitExec(cwd, ['rev-parse', '--short', 'HEAD']).trim();
}

/** Unified diff of the index vs HEAD. Binary blobs appear as "Binary files … differ"
 *  (git's default — we never pass --text, so no blob bytes reach the model). */
export function stagedDiff(cwd: string): string {
  return gitExec(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M']);
}

/** `git diff --cached --stat` + name list, for the over-budget fallback. */
export function stagedDiffStat(cwd: string): string {
  return gitExec(cwd, ['diff', '--cached', '--no-color', '--stat']);
}

/** Newest-first commit subjects for style exemplars. Empty on an unborn branch. */
export function recentSubjects(cwd: string, limit = 12): string[] {
  try {
    return gitExec(cwd, ['log', `--max-count=${limit}`, '--format=%s'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];   // ponytail: unborn HEAD / empty repo — no exemplars, prompt says so
  }
}

export function pushRemote(
  cwd: string,
  targetRemote?: string,
): { remote: string; branch: string; output: string } {
  if (!isGitRepo(cwd)) {
    throw new Error('not a git repository');
  }

  let branch = '';
  try {
    branch = gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    branch = 'HEAD';
  }

  if (!branch || branch === 'HEAD') {
    throw new Error('cannot push detached HEAD');
  }

  const remotes = listRemotes(cwd);
  if (remotes.length === 0) {
    throw new Error('no remotes configured');
  }

  const remoteNames = remotes.map((r) => r.name);

  if (targetRemote === 'all') {
    const outputs: string[] = [];
    for (const r of remotes) {
      let hasUpstream = false;
      try {
        const u = gitExec(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).trim();
        if (u.startsWith(`${r.name}/`)) hasUpstream = true;
      } catch {
        hasUpstream = false;
      }
      const args = hasUpstream
        ? ['push', r.name, branch]
        : ['push', '-u', r.name, branch];
      outputs.push(gitExec(cwd, args));
    }
    return { remote: 'all', branch, output: outputs.join('\n') };
  }

  let remoteToPush = targetRemote?.trim();
  if (remoteToPush) {
    if (!remoteNames.includes(remoteToPush)) {
      throw new Error(`remote "${remoteToPush}" not found`);
    }
  } else {
    remoteToPush = remoteNames.includes('origin') ? 'origin' : remoteNames[0];
  }

  let hasUpstream = false;
  try {
    const u = gitExec(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).trim();
    if (u.startsWith(`${remoteToPush}/`)) hasUpstream = true;
  } catch {
    hasUpstream = false;
  }

  const args = hasUpstream
    ? ['push', remoteToPush, branch]
    : ['push', '-u', remoteToPush, branch];

  const output = gitExec(cwd, args);
  return { remote: remoteToPush, branch, output };
}

export function listBranches(cwd: string): GitBranchesResponse {
  if (!isGitRepo(cwd)) {
    return { current: '', detached: false, branches: [] };
  }
  let current = 'HEAD';
  let detached = false;
  try {
    current = gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    detached = current === 'HEAD';
  } catch {
    current = 'HEAD';
    detached = true;
  }
  if (detached) {
    current = '';
  }

  const raw = gitExec(cwd, [
    'for-each-ref',
    '--format=%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)',
    'refs/heads/',
    'refs/remotes/',
  ]);

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const localBranches: GitBranchRef[] = [];
  const remoteBranches: GitBranchRef[] = [];

  for (const line of lines) {
    const parts = line.split('\x1f');
    if (parts.length < 5) continue;
    const [headMarker, refname, shortName, shortSha, upstream] = parts;
    if (refname.startsWith('refs/remotes/') && (refname.endsWith('/HEAD') || shortName.endsWith('/HEAD'))) {
      continue;
    }
    const isRemote = refname.startsWith('refs/remotes/');
    const isCurrent = headMarker === '*';
    const refItem: GitBranchRef = {
      name: shortName,
      isRemote,
      isCurrent,
      shortSha,
      ...(upstream && !isRemote ? { upstream } : {}),
    };
    if (isRemote) {
      remoteBranches.push(refItem);
    } else {
      localBranches.push(refItem);
    }
  }

  localBranches.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return a.name.localeCompare(b.name);
  });
  remoteBranches.sort((a, b) => a.name.localeCompare(b.name));

  return {
    current,
    detached,
    branches: [...localBranches, ...remoteBranches],
  };
}

export function switchBranch(cwd: string, branch: string): string {
  assertBranchName(branch);
  let isLocal = false;
  try {
    gitExec(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    isLocal = true;
  } catch {
    isLocal = false;
  }
  if (isLocal) {
    gitExec(cwd, ['switch', branch]);
    return branch;
  }

  let isRemote = false;
  try {
    gitExec(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/${branch}`]);
    isRemote = true;
  } catch {
    isRemote = false;
  }

  if (isRemote) {
    const slashIdx = branch.indexOf('/');
    const rest = slashIdx >= 0 ? branch.slice(slashIdx + 1) : branch;
    let restLocalExists = false;
    try {
      gitExec(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${rest}`]);
      restLocalExists = true;
    } catch {
      restLocalExists = false;
    }
    if (restLocalExists) {
      gitExec(cwd, ['switch', rest]);
      return rest;
    } else {
      gitExec(cwd, ['switch', '--track', branch]);
      return rest;
    }
  }

  throw new Error('branch not found');
}

export function createBranch(cwd: string, name: string, baseRef?: string): string {
  assertBranchName(name);
  const remotes = listRemotes(cwd).map((r) => r.name);
  const firstSeg = name.split('/')[0];
  if (remotes.includes(firstSeg)) {
    throw new Error(`cannot create branch shadowing remote '${firstSeg}'`);
  }
  gitExec(cwd, ['check-ref-format', '--branch', name]);
  if (baseRef) assertRef(baseRef);
  const args = ['switch', '-c', name];
  if (baseRef) args.push(baseRef);
  gitExec(cwd, args);
  return name;
}

export async function fetchRemotes(cwd: string): Promise<string> {
  return gitExecAsync(cwd, ['fetch', '--all', '--prune']);
}

export async function pullFastForward(cwd: string): Promise<string> {
  return gitExecAsync(cwd, ['pull', '--ff-only', '--no-rebase']);
}

export function addOperatorWorktree(
  projectRoot: string,
  branch: string,
  opts: { newBranch?: boolean; folder?: string } = {},
): { cwd: string; branch: string } {
  const toplevel = gitExec(projectRoot, ['rev-parse', '--show-toplevel']).trim();
  assertBranchName(branch);
  if (opts.newBranch) {
    const remotes = listRemotes(projectRoot).map((r) => r.name);
    const firstSeg = branch.split('/')[0];
    if (remotes.includes(firstSeg)) {
      throw new Error(`cannot create branch shadowing remote '${firstSeg}'`);
    }
  }
  const cleanBranch = branch.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '');
  const defaultFolder = `${basename(toplevel)}-${cleanBranch || 'worktree'}`;
  const folder = assertFolderName(opts.folder ?? defaultFolder);
  const path = join(dirname(toplevel), folder);
  if (existsSync(path)) {
    throw new Error('folder already exists');
  }
  if (opts.newBranch) {
    gitExec(projectRoot, ['check-ref-format', '--branch', branch]);
    gitExec(projectRoot, ['worktree', 'add', '-b', branch, '--', path]);
  } else {
    gitExec(projectRoot, ['worktree', 'add', '--', path, branch]);
  }
  return { cwd: realpathSync(path), branch };
}


export interface GitWorktreeEntry {
  cwd: string;
  branch: string;
  detached: boolean;
  headSha: string;
}

export function listGitWorktrees(projectRoot: string): GitWorktreeEntry[] {
  if (!isGitRepo(projectRoot)) return [];
  const raw = gitExec(projectRoot, ['worktree', 'list', '--porcelain']);
  const entries: GitWorktreeEntry[] = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    let wtCwd: string | null = null;
    let branch = '';
    let detached = false;
    let headSha = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) wtCwd = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) headSha = line.slice('HEAD '.length).slice(0, 7);
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      }
      else if (line === 'detached') detached = true;
    }
    if (!wtCwd) continue;
    if (detached) branch = 'HEAD';
    entries.push({ cwd: wtCwd, branch, detached, headSha });
  }
  return entries;
}

export function headRef(cwd: string): { branch: string; detached: boolean; headSha: string; toplevel: string } {
  try {
    if (!isGitRepo(cwd)) {
      return { branch: '', detached: false, headSha: '', toplevel: '' };
    }
    let branch = 'HEAD';
    let detached = false;
    try {
      branch = gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      detached = branch === 'HEAD';
    } catch {
      branch = 'HEAD';
      detached = true;
    }
    let headSha = '';
    try {
      headSha = gitExec(cwd, ['rev-parse', '--short', 'HEAD']).trim();
    } catch {
      headSha = '';
    }
    let toplevel = '';
    try {
      toplevel = realpathSync(gitExec(cwd, ['rev-parse', '--show-toplevel']).trim());
    } catch {
      toplevel = '';
    }
    return { branch, detached, headSha, toplevel };
  } catch {
    return { branch: '', detached: false, headSha: '', toplevel: '' };
  }
}

export function refExists(cwd: string, ref: string): boolean {
  assertRef(ref);
  try {
    gitExec(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function fileHeadDiff(absPath: string): { modified: boolean; diff: string; isTracked: boolean } {
  const dir = dirname(absPath);
  if (!isGitRepo(dir)) {
    return { modified: false, diff: '', isTracked: false };
  }

  let hasHead = false;
  try {
    gitExec(dir, ['rev-parse', '--verify', 'HEAD']);
    hasHead = true;
  } catch {
    hasHead = false;
  }

  const args = hasHead
    ? ['diff', 'HEAD', '--', absPath]
    : ['diff', '--', absPath];
  const diff = gitExec(dir, args);
  const modified = diff.trim().length > 0;

  let isTracked = false;
  if (hasHead) {
    try {
      const lsOut = gitExec(dir, ['ls-tree', 'HEAD', '--', absPath]).trim();
      isTracked = lsOut.length > 0;
    } catch {
      isTracked = false;
    }
  }

  return { modified, diff, isTracked };
}

export async function restoreFileToHead(absPath: string): Promise<{ action: 'restored' | 'deleted'; path: string }> {
  const dir = dirname(absPath);
  if (!isGitRepo(dir)) {
    throw new Error('file is not in a git repository');
  }

  let hasHead = false;
  try {
    gitExec(dir, ['rev-parse', '--verify', 'HEAD']);
    hasHead = true;
  } catch {
    hasHead = false;
  }

  let isTracked = false;
  if (hasHead) {
    try {
      const lsOut = gitExec(dir, ['ls-tree', 'HEAD', '--', absPath]).trim();
      isTracked = lsOut.length > 0;
    } catch {
      isTracked = false;
    }
  }

  if (isTracked) {
    try {
      gitExec(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', absPath]);
    } catch {
      gitExec(dir, ['checkout', 'HEAD', '--', absPath]);
    }
    return { action: 'restored', path: absPath };
  }

  await unlink(absPath);
  return { action: 'deleted', path: absPath };
}

export function isIndexLockError(err: GitCommandError): boolean {
  return err.stderr.includes('index.lock');
}

export function isPathUntracked(cwd: string, relPath: string): boolean {
  try {
    const lsOut = gitExec(cwd, ['ls-files', '--', `:(literal)${relPath}`]).trim();
    if (lsOut.length > 0) return false;
    const statusOut = gitExec(cwd, ['status', '--porcelain=v1', '-z', '--', `:(literal)${relPath}`]).trim();
    return statusOut.startsWith('??');
  } catch {
    return false;
  }
}

export async function deleteUntrackedPath(cwd: string, relPath: string): Promise<void> {
  const { unlink, lstat } = await import('fs/promises');
  const abs = resolve(cwd, relPath);
  let lst;
  try {
    lst = await lstat(abs);
  } catch {
    throw new Error('file does not exist');
  }
  if (lst.isDirectory()) {
    throw new Error('cannot delete directory');
  }
  if (!isPathUntracked(cwd, relPath)) {
    throw new Error('cannot delete tracked file');
  }
  await unlink(abs);
}

export interface NestedGitRepoEntry {
  cwd: string;
  label: string;
}

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  'data',
]);

export function listNestedGitRepos(
  projectRoot: string,
  maxDepth = 2,
): NestedGitRepoEntry[] {
  const rootReal = (() => {
    try {
      return realpathSync(projectRoot);
    } catch {
      return resolve(projectRoot);
    }
  })();

  const results: NestedGitRepoEntry[] = [];
  const visited = new Set<string>();
  visited.add(rootReal);

  function scan(currentDir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const name = ent.name;
      if (IGNORED_DIR_NAMES.has(name) || (name.startsWith('.') && name !== '.git')) continue;

      const subPath = join(currentDir, name);
      let realSub: string;
      try {
        realSub = realpathSync(subPath);
      } catch {
        continue;
      }

      if (realSub !== rootReal && !realSub.startsWith(rootReal + sep)) {
        continue;
      }

      if (visited.has(realSub)) continue;
      visited.add(realSub);

      const dotGit = join(realSub, '.git');
      if (existsSync(dotGit) && isGitRepo(realSub)) {
        const rel = relative(rootReal, realSub).split(sep).join('/');
        results.push({
          cwd: realSub,
          label: rel,
        });
        continue;
      }

      scan(subPath, depth + 1);
    }
  }

  scan(projectRoot, 1);
  return results;
}

/** Restore an unstaged tracked file to the *index* state. Never touches the index
 *  itself — a partially staged file keeps its staged hunks. */
export function discardWorktreePath(cwd: string, relPath: string): void {
  if (isPathUntracked(cwd, relPath)) {
    throw new Error('cannot discard untracked file');   // route maps to 400
  }
  try {
    gitExec(cwd, ['restore', '--worktree', '--', `:(literal)${relPath}`]);
  } catch (e) {
    // ponytail: git < 2.23 has no `restore`; checkout -- <path> is the same op.
    if (!(e instanceof GitCommandError)) throw e;
    gitExec(cwd, ['checkout', '--', `:(literal)${relPath}`]);
  }
}

function clampLimit(raw: number | undefined): number {
  const n = Math.floor(Number(raw ?? 50));
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, n));
}

function clampSkip(raw: number | undefined): number {
  const n = Math.floor(Number(raw ?? 0));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function parseCommitLog(raw: string): GitCommitSummary[] {
  if (!raw) return [];
  const out: GitCommitSummary[] = [];
  for (let rec of raw.split('\x1e')) {
    if (rec.startsWith('\n')) rec = rec.slice(1);
    if (!rec.trim()) continue;
    const fields = rec.split('\x1f');
    if (fields.length < 7) continue;
    const [sha, shortSha, authorName, authorEmail, at, subject, d] = fields;
    out.push({
      sha,
      shortSha,
      authorName,
      authorEmail,
      timestamp: Number(at) * 1000,
      subject,
      refs: d.split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

export function listCommits(
  cwd: string,
  opts: { limit?: number; skip?: number; ref?: string } = {},
): { commits: GitCommitSummary[]; hasMore: boolean } {
  const limit = clampLimit(opts.limit);
  const skip = clampSkip(opts.skip);
  const targetRef = assertRef(opts.ref ?? 'HEAD');
  try {
    const raw = gitExec(cwd, [
      'log',
      '--no-color',
      `--max-count=${limit + 1}`,
      `--skip=${skip}`,
      '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e',
      targetRef,
      '--',
    ]);
    const parsed = parseCommitLog(raw);
    const hasMore = parsed.length > limit;
    return { commits: parsed.slice(0, limit), hasMore };
  } catch (e) {
    if (e instanceof GitCommandError) return { commits: [], hasMore: false };
    throw e;
  }
}

export function parseCommitHeader(raw: string): Omit<GitCommitDetail, 'files' | 'stats'> {
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const fields = trimmed.split('\x1f');
  const sha = fields[0] ?? '';
  const shortSha = fields[1] ?? '';
  const authorName = fields[2] ?? '';
  const authorEmail = fields[3] ?? '';
  const at = fields[4] ?? '0';
  const d = fields[5] ?? '';
  const p = fields[6] ?? '';
  const subject = fields[7] ?? '';
  const body = fields.slice(8).join('\x1f');
  const parentShas = p.trim().split(/\s+/).filter(Boolean);
  return {
    sha,
    shortSha,
    authorName,
    authorEmail,
    timestamp: Number(at) * 1000,
    subject,
    refs: d.split(',').map((s) => s.trim()).filter(Boolean),
    body,
    parentShas,
    isMerge: parentShas.length > 1,
  };
}

function mapNameStatusCode(code: string): GitCommitFileStatus {
  if (/^[RC]\d*$/.test(code)) return 'renamed';
  if (code.charAt(0) === 'A') return 'new';
  if (code.charAt(0) === 'D') return 'deleted';
  return 'modified';
}

export function parseNameStatusZ(
  raw: string,
): { status: GitCommitFileStatus; path: string; origPath?: string }[] {
  if (!raw) return [];
  const tokens = raw.split('\0');
  const out: { status: GitCommitFileStatus; path: string; origPath?: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) {
      i += 1;
      continue;
    }
    const isRename = /^[RC]\d*$/.test(code);
    if (isRename) {
      const origPath = tokens[i + 1] ?? '';
      const path = tokens[i + 2] ?? '';
      if (path) out.push({ status: 'renamed', path, origPath: origPath || undefined });
      i += 3;
    } else {
      const path = tokens[i + 1] ?? '';
      if (path) out.push({ status: mapNameStatusCode(code), path });
      i += 2;
    }
  }
  return out;
}

export function parseNumstatZ(
  raw: string,
): { path: string; origPath?: string; added?: number; deleted?: number; binary: boolean }[] {
  if (!raw) return [];
  const tokens = raw.split('\0');
  const out: { path: string; origPath?: string; added?: number; deleted?: number; binary: boolean }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const chunk = tokens[i];
    if (!chunk) {
      i += 1;
      continue;
    }
    const m = chunk.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const addStr = m[1];
    const delStr = m[2];
    const samePath = m[3];
    const binary = addStr === '-' || delStr === '-';
    const added = binary ? undefined : Number(addStr);
    const deleted = binary ? undefined : Number(delStr);
    if (samePath.length === 0) {
      const origPath = tokens[i + 1] ?? '';
      const path = tokens[i + 2] ?? '';
      if (path) {
        out.push({
          path,
          origPath: origPath || undefined,
          added,
          deleted,
          binary,
        });
      }
      i += 3;
    } else {
      out.push({ path: samePath, added, deleted, binary });
      i += 1;
    }
  }
  return out;
}

export function mergeFileStats(
  names: { status: GitCommitFileStatus; path: string; origPath?: string }[],
  nums: { path: string; origPath?: string; added?: number; deleted?: number; binary: boolean }[],
): { files: GitCommitFileChange[]; stats: { added: number; deleted: number; filesCount: number } } {
  const numByPath = new Map(nums.map((n) => [n.path, n]));
  const files: GitCommitFileChange[] = names.map((n) => {
    const stats = numByPath.get(n.path);
    return {
      path: n.path,
      origPath: n.origPath,
      status: n.status,
      addedLines: stats?.added,
      deletedLines: stats?.deleted,
      binary: stats?.binary ?? false,
    };
  });
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    if (f.binary) continue;
    added += f.addedLines ?? 0;
    deleted += f.deletedLines ?? 0;
  }
  return { files, stats: { added, deleted, filesCount: files.length } };
}

export function commitDetail(cwd: string, sha: string): GitCommitDetail {
  const safe = assertSha(sha);
  const headerRaw = gitExec(cwd, [
    'show', '-s', '--no-color',
    `--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1f%s%x1f%b`,
    safe,
  ]);
  const header = parseCommitHeader(headerRaw);

  // Merge commits: per-file single-commit diffs are ambiguous/empty without
  // choosing a parent. Files stay empty and stats stay 0; UI renders merge notice.
  if (header.isMerge) {
    return {
      ...header,
      files: [],
      stats: { added: 0, deleted: 0, filesCount: 0 },
    };
  }

  const nameRaw = gitExec(cwd, [
    'show', '--no-color', '--no-ext-diff', '--format=', '--name-status', '-M', '-z', safe,
  ]);
  const numRaw = gitExec(cwd, [
    'show', '--no-color', '--no-ext-diff', '--format=', '--numstat', '-M', '-z', safe,
  ]);
  const names = parseNameStatusZ(nameRaw);
  const nums = parseNumstatZ(numRaw);
  const { files, stats } = mergeFileStats(names, nums);
  return {
    ...header,
    files,
    stats,
  };
}

const DIFF_CHAR_CAP = 1_000_000;
const FILE_CHAR_CAP = 1_000_000;

export function commitFileDiff(cwd: string, sha: string, relPath: string): GitCommitDiffResponse {
  const safe = assertSha(sha);
  const diff = gitExec(cwd, [
    'show', '--no-color', '--no-ext-diff', '--format=', '-M',
    safe, '--', `:(literal)${relPath}`,
  ]);
  if (diff.length > DIFF_CHAR_CAP) {
    return { sha: safe, path: relPath, diff: diff.slice(0, DIFF_CHAR_CAP), truncated: true };
  }
  return { sha: safe, path: relPath, diff, truncated: false };
}

export function commitFileContent(cwd: string, sha: string, relPath: string): GitCommitFileResponse {
  const safe = assertSha(sha);
  const content = gitExec(cwd, ['show', `${safe}:${relPath}`]);
  if (content.includes('\0')) {
    return { sha: safe, path: relPath, content: '', binary: true, truncated: false };
  }
  if (content.length > FILE_CHAR_CAP) {
    return {
      sha: safe,
      path: relPath,
      content: content.slice(0, FILE_CHAR_CAP),
      binary: false,
      truncated: true,
    };
  }
  return { sha: safe, path: relPath, content, binary: false, truncated: false };
}

export function branchDiff(cwd: string, base: string, target: string): GitBranchDiffResponse {
  assertRef(base);
  assertRef(target);
  let baseSha = '';
  let targetSha = '';
  try {
    baseSha = gitExec(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim();
  } catch {
    throw new Error(`unknown base ref: ${base}`);
  }
  try {
    targetSha = gitExec(cwd, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]).trim();
  } catch {
    throw new Error(`unknown target ref: ${target}`);
  }

  let mergeBaseSha = '';
  try {
    mergeBaseSha = gitExec(cwd, ['merge-base', baseSha, targetSha]).trim();
  } catch {
    throw new Error('no common ancestor');
  }
  if (!mergeBaseSha) {
    throw new Error('no common ancestor');
  }

  const nameRaw = gitExec(cwd, [
    'diff', '--no-color', '--no-ext-diff', '--name-status', '-M', '-z', mergeBaseSha, targetSha,
  ]);
  const numRaw = gitExec(cwd, [
    'diff', '--no-color', '--no-ext-diff', '--numstat', '-M', '-z', mergeBaseSha, targetSha,
  ]);
  const names = parseNameStatusZ(nameRaw);
  const nums = parseNumstatZ(numRaw);
  const { files, stats } = mergeFileStats(names, nums);
  // Cap the returned list at 2 000 files (slice; stats computed from the full list).
  // ponytail: arbitrary cap, add paging if real repos hit it
  const cappedFiles = files.slice(0, 2000);
  return {
    base,
    target,
    mergeBaseSha,
    targetSha,
    files: cappedFiles,
    stats,
  };
}

export function branchFileDiff(
  cwd: string,
  fromSha: string,
  toSha: string,
  relPath: string,
): GitCommitDiffResponse {
  const safeFrom = assertSha(fromSha);
  const safeTo = assertSha(toSha);
  const diff = gitExec(cwd, [
    'diff', '--no-color', '--no-ext-diff', '-M',
    safeFrom, safeTo, '--', `:(literal)${relPath}`,
  ]);
  if (diff.length > DIFF_CHAR_CAP) {
    return { sha: safeTo, path: relPath, diff: diff.slice(0, DIFF_CHAR_CAP), truncated: true };
  }
  return { sha: safeTo, path: relPath, diff, truncated: false };
}



