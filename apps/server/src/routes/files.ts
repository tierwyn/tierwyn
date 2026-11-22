import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import { constants as FS, realpathSync } from 'fs';
import { gitSync } from '../git/gitExec.js';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { open, readdir, realpath, rename, rm, stat, unlink } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { resolve as resolvePath, sep, extname, basename, dirname, isAbsolute, join } from 'path';
import { listProjects } from '../repositories/projects.js';
import { getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { getRemoteHost, remoteHostIdFor } from '../repositories/remoteHosts.js';
import { listEventsForConversation } from '../repositories/events.js';
import { hostHasFeature, isImageExtension, isAudioExtension, isVideoExtension, isOpenableExtension, isMarkdownExtension, isSecretPath, NODE_FILE_CHUNK_BYTES, NODE_FILE_MAX_BYTES } from '@tierwyn/shared';
import type { FileBrowserListing, FilesReadResult, FilesWriteResult } from '@tierwyn/shared';
import { RpcError } from '../node/rpc.js';
import { resolveConversationCwd, snapshotCode } from '../git/shadowCheckpoint.js';
import { checkpointOpsFor } from '../git/checkpointOps.js';
import { fileHeadDiff, restoreFileToHead, GitCommandError } from '../git/workingTree.js';
import { RemoteGitOps, WorkingTreeContextError } from '../git/remoteOps.js';
import { collectRemoteLiveAgents } from '../git/workingTreeContext.js';
import type { SessionRecord } from '../sessionManager.js';
import { getGeneralSettings } from '../repositories/settings.js';
import { OutboundUrlError, safeFetch } from '../net/outboundUrl.js';

/**
 * Roots the file-serving endpoint is allowed to read from. Computed per request
 * so $HOME changes are picked up without restart. All roots are absolute and
 * end with `path.sep` for safe prefix matching.
 *
 * The list is intentionally narrow to the agent homes we know about — adding
 * a new adapter means extending this list.
 */
const AGENT_HOME_SUBDIRS = [
  '.claude',
  '.pi',
  '.gemini',
  '.local/share/opencode',
  '.config/opencode',
  '.cursor',
  '.hermes',
  '.agents',
];

// ponytail: user-facing dirs worth serving by default; screenshots + operator media library.
const USER_HOME_SUBDIRS = ['Pictures', 'Downloads', 'Media', 'Desktop', 'Documents', 'Videos', 'Music'];

const EXTRA_TMP_ROOTS = ['/var/tmp'];

import { isRetentionArchivePath, listUnderRoot, withTrailingSep, realpathWithinRoots } from '../files/listing.js';
export { isRetentionArchivePath, realpathWithinRoots };
import { isWritePathAllowed, versionToken, type WriteAllowOptions } from '../files/writePolicy.js';
export { isWritePathAllowed };
export type { WriteAllowOptions };

/** Minimal slice of the hub's node registry that file routes need. `link`
 * returns a per-host RPC client (or throws/returns undefined when the host is
 * disconnected, mapped by `remoteErrorStatus`).
 */
export interface FileRoutesNodeHub {
  link(hostId: string): {
    request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T>;
  };
}

/** Chunk size for hub→node `files.read` data calls. */
export let REMOTE_READ_CHUNK = NODE_FILE_CHUNK_BYTES;
/** @internal test seam — restore with NODE_FILE_CHUNK_BYTES after use. */
export function setRemoteReadChunkForTests(n: number): void {
  REMOTE_READ_CHUNK = n;
}

/**
 * Map a node-side RPC error onto an HTTP response for remote file routes.
 * Never echoes the node's error text to the client.
 */
export function remoteErrorStatus(e: unknown): { status: number; error: string } {
  const code = e instanceof RpcError ? e.code : undefined;
  switch (code) {
    case 'path_outside_roots':
    case 'path_not_allowed':
    case 'not_allowed':
      return { status: 403, error: 'path not allowed' };
    case 'bad_path':
      return { status: 400, error: 'invalid path' };
    case 'not_found':
      return { status: 404, error: 'file not found' };
    case 'too_large':
      return { status: 413, error: 'file too large for remote view' };
    case 'host_disconnected':
    case 'disconnected':
    case 'timeout':
      return { status: 503, error: 'remote host not connected' };
    case 'no_method':
      return { status: 501, error: 'remote host needs update' };
    default:
      return { status: 502, error: 'remote read failed' };
  }
}

/** Build the allow-list of absolute directory roots (with trailing sep). */
export function buildAllowedRoots(): string[] {
  const home = homedir();
  const roots = new Set<string>();
  // Per-project roots
  // (caller passes project roots in via opts so this fn can be unit-tested
  // without a DB)
  for (const sub of AGENT_HOME_SUBDIRS) {
    roots.add(withTrailingSep(resolvePath(home, sub)));
  }
  for (const sub of USER_HOME_SUBDIRS) {
    roots.add(withTrailingSep(resolvePath(home, sub)));
  }
  roots.add(withTrailingSep(tmpdir()));
  for (const t of EXTRA_TMP_ROOTS) roots.add(withTrailingSep(t));
  return [...roots];
}

export interface AllowListOptions {
  projectRoots?: string[];
  /** Injected for tests; defaults to buildAllowedRoots() at call time. */
  extraRoots?: string[];
  /** DB data directory; paths under `<dataDir>/archive/` are always denied. */
  dataDir?: string;
}

/** C31: emit both header names for one release so SPA tabs that stay open still read. */
export function setFileMetaHeaders(
  res: Response,
  meta: { path: string; version: string; writable: string },
): void {
  const encoded = encodeURIComponent(meta.path);
  for (const prefix of ['X-Tierwyn-File-'] as const) {
    res.setHeader(`${prefix}Path`, encoded);
    res.setHeader(`${prefix}Version`, meta.version);
    res.setHeader(`${prefix}Writable`, meta.writable);
  }
}

export function attachmentsRoot(dataDir: string): string {
  return withTrailingSep(resolvePath(dataDir, 'attachments'));
}

export function isAttachmentShardPath(absPath: string, dataDir: string): boolean {
  if (!absPath || !dataDir) return false;
  // resolvePath would happily absorb a relative `path` into cwd, letting a
  // attacker-chosen relative name land inside <dataDir>/attachments/ — the
  // carve-out only makes sense for hub-owned absolute shard paths.
  if (!isAbsolute(absPath)) return false;
  const root = attachmentsRoot(dataDir);
  const resolved = withTrailingSep(resolvePath(absPath));
  return resolved !== root && resolved.startsWith(root);
}

const CONV_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Best-effort rm of `<dataDir>/attachments/<id>` for deleted conversations. */
export async function rmAttachmentShards(dataDir: string, ids: string[]): Promise<void> {
  if (!dataDir || ids.length === 0) return;
  const root = resolvePath(dataDir, 'attachments');
  await Promise.all(ids
    .filter((id) => CONV_ID_RE.test(id))
    .map((id) => rm(join(root, id), { recursive: true, force: true }).catch(() => undefined)));
}

/**
 * Map a bare/relative display name (e.g. `test-file.txt` from markdown linkify)
 * to the absolute shard path stored on a conversation's message `files` payload.
 * Newest matching `status: 'ok'` row wins. Only returns paths under ATT_ROOT.
 */
export function findConversationAttachmentPath(
  db: Database,
  conversationId: string,
  wantName: string,
  dataDir: string,
): string | null {
  if (!conversationId || !wantName || !dataDir) return null;
  const want = wantName.trim();
  if (!want || want.includes('/') || want.includes('\\')) return null;
  const wantLower = want.toLowerCase();
  const events = listEventsForConversation(db, conversationId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'message') continue;
    const files = (e.payload as { files?: Array<{ name?: string; status?: string; path?: string }> }).files;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (f.status !== 'ok' || typeof f.path !== 'string' || !f.path) continue;
      if (!isAttachmentShardPath(f.path, dataDir)) continue;
      const display = typeof f.name === 'string' ? f.name : '';
      if (display === want || display.toLowerCase() === wantLower || basename(f.path) === want) {
        return f.path;
      }
    }
  }
  return null;
}

/**
 * True iff `absPath` is lexically inside one of the allowed roots AND has an
 * openable extension. Does NOT follow symlinks — see plan caveats. `absPath`
 * should already be resolved (absolute, no `..`).
 */
export function isPathAllowed(absPath: string, opts: AllowListOptions = {}): boolean {
  if (!absPath || !absPath.startsWith('/')) return false;
  if (opts.dataDir && isRetentionArchivePath(absPath, opts.dataDir)) return false;
  const underAtt = Boolean(opts.dataDir && isAttachmentShardPath(absPath, opts.dataDir));
  const ext = extname(absPath).slice(1).toLowerCase();
  // Attachment shards skip the openable-extension gate (.gz, .deb, .pdf, …).
  if (!underAtt && (!ext || !isOpenableExtension(ext))) return false;

  // Non-hidden files located directly in the user's home directory (e.g. ~/notes.md, ~/Screenshot 2026-09-11.png)
  if (dirname(absPath) === homedir() && !basename(absPath).startsWith('.')) {
    return true;
  }

  const roots = new Set<string>(buildAllowedRoots());
  for (const r of opts.extraRoots ?? []) roots.add(withTrailingSep(r));
  for (const r of opts.projectRoots ?? []) roots.add(withTrailingSep(r));
  if (opts.dataDir) roots.add(attachmentsRoot(opts.dataDir));

  const withSep = withTrailingSep(absPath);
  for (const root of roots) {
    if (withSep === root) continue; // exact dir match — not a file
    if (withSep.startsWith(root)) return true;
    try {
      const realRoot = withTrailingSep(realpathSync(root.endsWith(sep) ? root.slice(0, -1) : root));
      if (withSep === realRoot) continue;
      if (withSep.startsWith(realRoot)) return true;
    } catch {
      /* root missing or unreadable */
    }
  }
  return false;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  mdx: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonc: 'application/json; charset=utf-8',
  json5: 'application/json; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  // Everything else openable (code + text) gets plain UTF-8 text — the
  // client fetches via .text() and renders through the markdown pipeline's
  // code block path, so the content-type here is just for direct browser
  // opens / curl.
};

interface ResolveTargetResult {
  status: 200 | 400 | 403 | 404 | 409;
  error?: string;
  resolved?: string;
  info?: Awaited<ReturnType<typeof stat>>;
  projectRoots?: string[];
  workdirRoot?: string;
}

/**
 * Recursively search a directory up to maxDepth for a file matching rel.
 * Used as a fallback when git is not available or path is untracked.
 */
async function searchDirectoryForSubpath(
  dir: string,
  rel: string,
  maxDepth = 4,
  currentDepth = 0,
): Promise<string | undefined> {
  if (currentDepth > maxDepth) return undefined;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // First pass: check direct files in this directory
    for (const entry of entries) {
      if (entry.isFile()) {
        const full = resolvePath(dir, entry.name);
        if (full.endsWith(`/${rel}`) || entry.name === rel) {
          return full;
        }
      }
    }
    // Second pass: recurse into subdirectories (skipping common ignored dirs)
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if (
          name.startsWith('.') ||
          name === 'node_modules' ||
          name === 'dist' ||
          name === 'build' ||
          name === 'coverage' ||
          name === '.turbo'
        ) {
          continue;
        }
        const found = await searchDirectoryForSubpath(
          resolvePath(dir, name),
          rel,
          maxDepth,
          currentDepth + 1,
        );
        if (found) return found;
      }
    }
  } catch {
    /* unreadable directory */
  }
  return undefined;
}

/**
 * Resolve bare filenames or partial subpaths in a project workspace.
 * First tries `git ls-files` inside basePath; falls back to directory walk.
 */
async function resolveProjectSubpath(
  basePath: string,
  rel: string,
): Promise<string | undefined> {
  const normRel = rel.replace(/^\.\//, '');
  try {
    const gitPattern = normRel.includes('/') ? `*${normRel}` : `*${normRel}`;
    const gitOut = gitSync(
      basePath,
      ['ls-files', '--cached', '--others', '--exclude-standard', gitPattern],
      { timeoutMs: 2000 },
    );
    const lines = gitOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const matches = lines.filter((l) => l === normRel || l.endsWith(`/${normRel}`));
    // Sort shortest path first (closer to root)
    matches.sort((a, b) => a.length - b.length);
    if (matches.length > 0) {
      return resolvePath(basePath, matches[0]);
    }
  } catch {
    /* git not available or failed */
  }

  return searchDirectoryForSubpath(basePath, normRel);
}

/**
 * Resolve template date strings like `YYYY-MM-DD` or `YYYYMMDD` by scanning
 * the target folder for existing date-stamped files matching the rest of the name.
 */
export async function resolveDateTemplatePath(
  dir: string,
  filePattern: string,
): Promise<string | undefined> {
  try {
    const entries = await readdir(dir);
    const regexStr = '^' + filePattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/YYYY-MM-DD/g, '(\\d{4}-\\d{2}-\\d{2})')
      .replace(/YYYYMMDD/g, '(\\d{8})') + '$';
    const re = new RegExp(regexStr, 'i');
    const matches = entries.filter((e) => re.test(e));
    if (matches.length === 0) return undefined;
    // Sort descending so the most recent date comes first
    matches.sort().reverse();
    return resolvePath(dir, matches[0]);
  } catch {
    return undefined;
  }
}

/**
 * Fuzzy screenshot resolver: if a user or agent specifies a screenshot with a date
 * (e.g. `Screenshot 2026-09-11.png`) but the exact file doesn't exist, search
 * standard screenshot directories for a matching date.
 */
async function resolveScreenshotDatePath(
  searchDirs: string[],
  baseName: string,
): Promise<string | undefined> {
  const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(baseName);
  if (!dateMatch) return undefined;
  const dateStr = dateMatch[1];
  const ext = extname(baseName).toLowerCase();
  for (const dir of searchDirs) {
    try {
      const entries = await readdir(dir);
      const matches = entries.filter(
        (e) =>
          /screenshot/i.test(e) &&
          e.includes(dateStr) &&
          (!ext || e.toLowerCase().endsWith(ext)),
      );
      if (matches.length > 0) {
        matches.sort().reverse();
        return resolvePath(dir, matches[0]);
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Strip editor noise from a client-supplied path: file:// and localhost
 * prefixes, #fragments/?queries, trailing :line:col; percent-decode once. */
function cleanRequestedPath(raw: string): string {
  let cleaned = raw.trim().replace(/^file:\/{1,3}/i, '/');
  cleaned = cleaned.replace(/^\/?localhost\//i, '/');
  cleaned = cleaned.split('#')[0].split('?')[0].replace(/:\d+(?::\d+)?$/, '');
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

async function resolveReadTarget(
  raw: unknown,
  convoIdRaw: unknown,
  projectIdRaw: unknown,
  getDb: () => Database,
  opts?: { dataDir?: string },
): Promise<ResolveTargetResult> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { status: 400, error: 'path query param required' };
  }

  const cleaned = cleanRequestedPath(raw);

  // Expand leading `~` to the user's home before resolving.
  const expanded = cleaned.startsWith('~/')
    ? `${homedir()}${cleaned.slice(1)}`
    : cleaned;
  const isRelative = !isAbsolute(expanded);

  // Remote contexts resolve on the node, never from hub disk. ANY path in a
  // remote context is 409 — except attachment shards, which are always
  // hub-local (R1 carve-out).
  if (!(opts?.dataDir && isAttachmentShardPath(expanded, opts.dataDir))) {
    if (typeof convoIdRaw === 'string' && convoIdRaw.length > 0
      && remoteHostIdFor(getDb(), { conversationId: convoIdRaw })) {
      return { status: 409, error: 'not available for remote-host projects (P3)' };
    }
    if (typeof projectIdRaw === 'string' && projectIdRaw.length > 0
      && remoteHostIdFor(getDb(), { projectId: projectIdRaw })) {
      return { status: 409, error: 'not available for remote-host projects (P3)' };
    }
  }

  // For non-absolute paths (other than `~`-expanded ones), resolve against
  // a base directory when the client provides context:
  //   conversationId → convo.workdirPath ?? project.rootPath (worktrees first)
  //   projectId      → project.rootPath (schedule browser has no convo)
  // Falls through to plain resolvePath when neither is provided (server CWD).
  let basePath: string | undefined;
  let workdirRoot: string | undefined;
  if (isRelative && typeof convoIdRaw === 'string' && convoIdRaw.length > 0) {
    const db = getDb();
    const convo = getConversation(db, convoIdRaw);
    const project = convo ? getProject(db, convo.projectId) : undefined;
    if (!convo || !project) {
      return { status: 404, error: 'conversation or project not found' };
    }
    basePath = convo.workdirPath ?? project.rootPath;
    workdirRoot = convo.workdirPath;
  } else if (isRelative && typeof projectIdRaw === 'string' && projectIdRaw.length > 0) {
    const project = getProject(getDb(), projectIdRaw);
    if (!project) {
      return { status: 404, error: 'project not found' };
    }
    basePath = project.rootPath;
  }

  const projectRoots = listProjects(getDb()).filter((p) => !p.remoteHostId).map((p) => p.rootPath);
  // Worktrees live as a sibling dir outside any project root, so we have to
  // allowlist the conversation's worktree path explicitly for this request.
  if (workdirRoot) projectRoots.push(workdirRoot);

  // Relative candidates: project/workdir first, then $HOME (so ./Media/... and
  // Media/Images/foo.png resolve when agents mean the home media library),
  // Pictures/Screenshots (where OS screenshots land), then process.cwd() when
  // no conversation context was provided.
  const rel = expanded.replace(/^\.\//, '');
  const home = homedir();
  const candidates: string[] = isRelative
    ? [
        ...(basePath ? [resolvePath(basePath, rel)] : []),
        resolvePath(home, rel),
        resolvePath(home, 'Pictures', rel),
        resolvePath(home, 'Pictures', 'Screenshots', rel),
        resolvePath(home, 'Desktop', rel),
        resolvePath(home, 'Downloads', rel),
        ...(!basePath ? [resolvePath(rel)] : []),
      ]
    : [
        resolvePath(expanded),
        ...(dirname(resolvePath(expanded)) === home
          ? [
              resolvePath(home, 'Pictures', basename(expanded)),
              resolvePath(home, 'Pictures', 'Screenshots', basename(expanded)),
              resolvePath(home, 'Desktop', basename(expanded)),
            ]
          : []),
      ];

  const allowOpts: AllowListOptions = { projectRoots, dataDir: opts?.dataDir };

  // Pick the first candidate that is allow-listed, not a secrets file, and
  // exists as a regular file. Avoids confirming existence for rejected paths
  // that never pass the allow-list.
  let resolved: string | undefined;
  let info: Awaited<ReturnType<typeof stat>> | undefined;
  for (const candidate of candidates) {
    if (!isPathAllowed(candidate, allowOpts)) continue;
    if (isSecretPath(candidate)) continue;
    try {
      const st = await stat(candidate);
      if (!st.isFile()) continue;
      resolved = candidate;
      info = st;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!resolved || !info) {
    // Smart resolution fallbacks before failing:
    // 1. Date template strings (YYYY-MM-DD / YYYYMMDD):
    if (expanded.includes('YYYY-MM-DD') || expanded.includes('YYYYMMDD')) {
      const targetDir = basePath && isRelative
        ? resolvePath(basePath, dirname(rel))
        : dirname(resolvePath(expanded));
      const found = await resolveDateTemplatePath(targetDir, basename(expanded));
      if (found && isPathAllowed(found, allowOpts) && !isSecretPath(found)) {
        try {
          const st = await stat(found);
          if (st.isFile()) {
            resolved = found;
            info = st;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // 2. Subdirectory / Monorepo workspace search (bare filenames & partial subpaths):
    if (!resolved && isRelative && basePath) {
      const found = await resolveProjectSubpath(basePath, rel);
      if (found && isPathAllowed(found, allowOpts) && !isSecretPath(found)) {
        try {
          const st = await stat(found);
          if (st.isFile()) {
            resolved = found;
            info = st;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // 3. Screenshot fuzzy date match:
    if (!resolved && isImageExtension(extname(expanded).slice(1).toLowerCase()) && /screenshot/i.test(basename(expanded))) {
      const screenshotDirs = [
        resolvePath(home, 'Pictures', 'Screenshots'),
        resolvePath(home, 'Pictures'),
        resolvePath(home, 'Desktop'),
        home,
      ];
      const found = await resolveScreenshotDatePath(screenshotDirs, basename(expanded));
      if (found && isPathAllowed(found, allowOpts) && !isSecretPath(found)) {
        try {
          const st = await stat(found);
          if (st.isFile()) {
            resolved = found;
            info = st;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // 4. Bare filename → conversation attachment shard (Grok Bot chips / markdown labels).
    if (
      !resolved
      && isRelative
      && opts?.dataDir
      && typeof convoIdRaw === 'string'
      && CONV_ID_RE.test(convoIdRaw)
      && !rel.includes('/')
      && !rel.includes('\\')
    ) {
      const found = findConversationAttachmentPath(getDb(), convoIdRaw, basename(rel), opts.dataDir);
      if (found && isPathAllowed(found, allowOpts) && !isSecretPath(found)) {
        try {
          const st = await stat(found);
          if (st.isFile()) {
            resolved = found;
            info = st;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!resolved || !info) {
    // Distinguish "nothing allowed" (every candidate 403-shaped) from "not found".
    const anyAllowed = candidates.some(
      (c) => isPathAllowed(c, allowOpts) && !isSecretPath(c),
    );
    if (!anyAllowed) {
      return { status: 403, error: 'path not allowed' };
    }
    return { status: 404, error: 'file not found' };
  }

  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return { status: 404, error: 'not found' };
  }
  if (!isPathAllowed(real, allowOpts) || isSecretPath(real)) {
    return { status: 403, error: 'path not allowed' };
  }
  return { status: 200, resolved: real, info, projectRoots, workdirRoot };
}

/**
 * GET /files/list. Root comes from the DB (conversation workdir or project
 * root), never from the client; `path` is relative to it. Containment and
 * entry mapping live in `files/listing.ts` (shared with the node's
 * `files.list` RPC).
 */
/**
 * Proxy GET /files/list to a remote host. The node applies its own jail to
 * `root`; the hub trusts it exactly like the local branch trusts its realpath.
 */
async function nodeList(
  nodeHub: FileRoutesNodeHub,
  hostId: string,
  root: string,
  path: unknown,
): Promise<{ status: number; body: FileBrowserListing | { error: string } }> {
  const p = typeof path === 'string' ? path : undefined;
  try {
    return await nodeHub.link(hostId)
      .request<{ status: number; body: FileBrowserListing | { error: string } }>(
        'files.list', { root, path: p },
      );
  } catch (e) {
    const { status, error } = remoteErrorStatus(e);
    return { status, body: { error } };
  }
}

export async function listDirectory(
  db: Database,
  q: { conversationId?: unknown; projectId?: unknown; path?: unknown },
  dataDir?: string,
  nodeHub?: FileRoutesNodeHub,
): Promise<{ status: number; body: FileBrowserListing | { error: string } }> {
  const err = (status: number, error: string) => ({ status, body: { error } });
  let root: string | undefined;
  if (typeof q.conversationId === 'string' && q.conversationId) {
    const convo = getConversation(db, q.conversationId);
    const project = convo ? getProject(db, convo.projectId) : undefined;
    if (!convo || !project) return err(404, 'conversation or project not found');
    const hostId = remoteHostIdFor(db, { conversationId: q.conversationId });
    if (hostId) {
      if (!nodeHub) return err(503, 'remote host not connected');
      return nodeList(nodeHub, hostId, resolvePath(convo.workdirPath ?? project.rootPath), q.path);
    }
    root = resolvePath(convo.workdirPath ?? project.rootPath);
  } else if (typeof q.projectId === 'string' && q.projectId) {
    const project = getProject(db, q.projectId);
    if (!project) return err(404, 'project not found');
    const hostId = remoteHostIdFor(db, { projectId: q.projectId });
    if (hostId) {
      if (!nodeHub) return err(503, 'remote host not connected');
      return nodeList(nodeHub, hostId, resolvePath(project.rootPath), q.path);
    }
    root = resolvePath(project.rootPath);
  } else {
    return err(400, 'conversationId or projectId required');
  }
  return listUnderRoot(root, q.path, dataDir);
}

/** Remote-host context for GET /files: which host owns this convo/project. */
function remoteHostIdForQuery(
  db: Database,
  q: { conversationId?: unknown; projectId?: unknown },
): string | null {
  if (typeof q.conversationId === 'string' && q.conversationId.length > 0) {
    return remoteHostIdFor(db, { conversationId: q.conversationId });
  }
  if (typeof q.projectId === 'string' && q.projectId.length > 0) {
    return remoteHostIdFor(db, { projectId: q.projectId });
  }
  return null;
}

/** Root a remote files.read/files.list is addressed against (node-side jail
 * applies). Callers only reach this when the context IS remote. */
function remoteRootForQuery(
  db: Database,
  q: { conversationId?: unknown; projectId?: unknown },
): { root: string; projectRoot: string; workdirRoot?: string } | { status: number; error: string } {
  if (typeof q.conversationId === 'string' && q.conversationId.length > 0) {
    const convo = getConversation(db, q.conversationId);
    const project = convo ? getProject(db, convo.projectId) : undefined;
    if (!convo || !project) return { status: 404, error: 'conversation or project not found' };
    const projectRoot = resolvePath(project.rootPath);
    const workdirRoot = convo.workdirPath ? resolvePath(convo.workdirPath) : undefined;
    return { root: workdirRoot ?? projectRoot, projectRoot, workdirRoot };
  }
  const project = getProject(db, q.projectId as string);
  if (!project) return { status: 404, error: 'project not found' };
  const projectRoot = resolvePath(project.rootPath);
  return { root: projectRoot, projectRoot };
}

/**
 * Stream a remote file to the client over files.read RPCs: one metadata call,
 * then REMOTE_READ_CHUNK-sized data calls. The whole body (≤64 MiB) is
 * buffered on the hub so consistency failures (409) can replace the response
 * before anything is sent; pipe chunks to `res` instead if memory bites.
 */
async function serveRemoteFile(
  req: Request,
  res: Response,
  db: Database,
  nodeHub: FileRoutesNodeHub,
  hostId: string,
  rootInfo: { root: string; projectRoot: string; workdirRoot?: string },
): Promise<void> {
  const { root, projectRoot, workdirRoot } = rootInfo;
  const link = nodeHub.link(hostId);
  const raw = req.query.path;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  const cleaned = cleanRequestedPath(raw);
  // Node bytes are agent-controlled and may be HTML/SVG — sandbox every
  // response, not just attachment shards.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'no-store');
  let meta: FilesReadResult;
  try {
    meta = await link.request<FilesReadResult>('files.read', { root, path: cleaned });
  } catch (e) {
    const { status, error } = remoteErrorStatus(e);
    res.status(status).json({ error });
    return;
  }
  // The node is the wire — validate its metadata before it touches headers,
  // where a bad value would otherwise throw inside this async Express 4
  // handler and, as an unhandled rejection, take the hub down.
  if (
    !meta
    || typeof meta.path !== 'string' || meta.path.length === 0
    || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > NODE_FILE_MAX_BYTES
    || !Number.isFinite(meta.mtimeMs)
  ) {
    res.status(502).json({ error: 'malformed node metadata' });
    return;
  }
  res.setHeader('Content-Type', contentTypeFor(extname(meta.path).slice(1).toLowerCase()));
  res.setHeader('Accept-Ranges', 'bytes');
  // Header values are byte strings: a non-ASCII path (日本.md, emoji) makes
  // setHeader throw ERR_INVALID_CHAR. Percent-encode; the web client decodes
  // with a raw fallback so plain-ASCII headers from older nodes still work.
  const version = versionToken(meta);
  const editsEnabled = getGeneralSettings(db).fileEditsEnabled;
  const host = getRemoteHost(db, hostId);
  const writable = editsEnabled
    && hostHasFeature(host?.hello, 'files.write')
    && isWritePathAllowed(meta.path, { projectRoots: [projectRoot], workdirRoot })
    ? '1'
    : '0';
  setFileMetaHeaders(res, { path: meta.path, version, writable });
  setDisposition(res, req, meta.path);
  const range = parseRange(String(req.headers.range ?? ''), meta.size);
  if (range === 'invalid') {
    res.setHeader('Content-Length', '0');
    res.setHeader('Content-Range', `bytes */${meta.size}`);
    res.status(416).end();
    return;
  }
  const start = range ? range.start : 0;
  // Clamp single ranges to 16 MiB on the wire — a remote text view never
  // needs more, and it bounds hub memory if a client asks for something huge.
  const end = range ? Math.min(range.end, start + 16 * 1024 * 1024 - 1) : meta.size - 1;
  // HEAD is used by the draft path-chip strip to probe openability without
  // streaming the body (many chips × large files would thrash otherwise).
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(meta.size));
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for (let off = start; off <= end; ) {
    if (res.destroyed || req.socket.destroyed) return;
    const len = Math.min(REMOTE_READ_CHUNK, end - off + 1);
    let chunk: FilesReadResult;
    try {
      chunk = await link.request<FilesReadResult>('files.read', {
        root, path: cleaned, offset: off, length: len,
      });
    } catch (e) {
      const { status, error } = remoteErrorStatus(e);
      res.status(status).json({ error });
      return;
    }
    // The file must not change under us mid-stream: node stat and chunk
    // length both have to line up with the metadata call.
    if (chunk.size !== meta.size || chunk.mtimeMs !== meta.mtimeMs) {
      res.status(409).json({ error: 'file changed during read' });
      return;
    }
    const buf = Buffer.from(chunk.data, 'base64');
    if (buf.length !== len) {
      res.status(409).json({ error: 'file changed during read' });
      return;
    }
    chunks.push(buf);
    off += len;
  }
  const body = Buffer.concat(chunks);
  res.setHeader('Content-Length', String(body.length));
  if (range) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${meta.size}`);
    res.status(206);
  } else {
    res.status(200);
  }
  res.end(body);
}

/**
 * Byte-range header parse shared by the local and remote GET /files branches.
 * null → absent or malformed header, caller serves a full 200 body; 'invalid'
 * → unsatisfiable range, caller 416s; else the clamped {start,end} (inclusive).
 */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // Suffix range: last N bytes.
    const suffix = Math.min(Number(m[2]), size);
    start = size - suffix;
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
    return 'invalid';
  }
  return { start, end };
}

/** Content-Type for GET /files — explicit map, else UTF-8 text for openable
 * non-media extensions, else octet-stream. */
function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext]
    ?? (isMarkdownExtension(ext)
      || (isOpenableExtension(ext) && !isImageExtension(ext) && !isAudioExtension(ext) && !isVideoExtension(ext))
      ? 'text/plain; charset=utf-8'
      : 'application/octet-stream');
}

/** Content-Disposition for GET /files: inline with a sanitized basename, or
 * attachment (with a UTF-8 filename*) when ?download=1. */
function setDisposition(res: Response, req: Request, path: string): void {
  // Use the file's basename in a UTF-8 safe Content-Disposition so the
  // browser can show a sensible filename without a roundtrip.
  const safeName = basename(path).replace(/[^\w.\-@]/g, '_');
  const wantDownload = req.query.download === '1' || req.query.download === 'true';
  if (wantDownload) {
    const rawName = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const display = rawName || basename(path);
    const ascii = display.replace(/[^\w.\-@ ]/g, '_').slice(0, 200) || 'file';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(ascii)}`,
    );
  } else {
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeName}"`,
    );
  }
}

export function registerFileRoutes(
  app: Express,
  getDb: () => Database,
  opts?: { dataDir?: string; nodeHub?: FileRoutesNodeHub; getActiveSessions?: () => SessionRecord[] },
): void {
  app.get('/files/list', async (req, res) => {
    try {
      const { status, body } = await listDirectory(getDb(), req.query, opts?.dataDir, opts?.nodeHub);
      res.status(status).json(body);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/files/git-diff', async (req, res) => {
    const rawPath = req.query.path;
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      res.status(400).json({ error: 'path query param required' });
      return;
    }
    const shard = Boolean(
      opts?.dataDir && isAttachmentShardPath(cleanRequestedPath(rawPath), opts.dataDir),
    );
    const hostId = shard ? null : remoteHostIdForQuery(getDb(), req.query);
    if (hostId) {
      if (!opts?.nodeHub) {
        res.status(503).json({ error: 'remote host not connected' });
        return;
      }
      const root = remoteRootForQuery(getDb(), req.query);
      if ('error' in root) {
        res.status(root.status).json({ error: root.error });
        return;
      }
      try {
        const result = await new RemoteGitOps(opts.nodeHub, hostId).fileHeadDiff(
          root.root,
          cleanRequestedPath(rawPath),
        );
        res.json(result);
      } catch (e) {
        if (e instanceof WorkingTreeContextError) {
          const error = e.status === 403 ? 'path not allowed' : e.message;
          res.status(e.status).json({ error });
          return;
        }
        res.status(500).json({ error: 'git diff failed' });
      }
      return;
    }

    const target = await resolveReadTarget(
      rawPath,
      req.query.conversationId,
      req.query.projectId,
      getDb,
      opts,
    );
    if (target.status !== 200 || !target.resolved) {
      res.status(target.status).json({ error: target.error });
      return;
    }

    try {
      res.json(fileHeadDiff(target.resolved));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'git diff failed' });
    }
  });

  app.post('/files/git-restore', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawPath = body.path;
      const conversationId = body.conversationId;
      const projectId = body.projectId;

      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        res.status(400).json({ error: 'path is required string' });
        return;
      }

      const shard = Boolean(
        opts?.dataDir && isAttachmentShardPath(cleanRequestedPath(rawPath), opts.dataDir),
      );
      const hostId = shard ? null : remoteHostIdForQuery(getDb(), { conversationId, projectId });
      if (hostId) {
        if (!opts?.nodeHub) {
          res.status(503).json({ error: 'remote host not connected' });
          return;
        }
        const root = remoteRootForQuery(getDb(), { conversationId, projectId });
        if ('error' in root) {
          res.status(root.status).json({ error: root.error });
          return;
        }
        try {
          const db = getDb();
          const ops = new RemoteGitOps(opts.nodeHub, hostId);
          const top = (await ops.headRef(root.root)).toplevel || root.root;
          // ponytail: guard keys on the conversation/project root checkout; a file in a nested repo is guarded by its parent root's agents only.
          const live = await collectRemoteLiveAgents(db, hostId, top, ops, opts.getActiveSessions?.() ?? []);
          if (live.length > 0) {
            const titles = live.map((a) => a.title).join(', ');
            res.status(409).json({
              error: `Cannot discard changes: ${live.length} agent(s) active on this checkout (${titles})`,
            });
            return;
          }
          res.json(await ops.restoreFileToHead(root.root, cleanRequestedPath(rawPath)));
        } catch (e) {
          if (e instanceof WorkingTreeContextError) {
            res.status(e.status).json({ error: e.message });
            return;
          }
          if (e instanceof Error && e.message === 'file is not in a git repository') {
            res.status(400).json({ error: e.message });
            return;
          }
          if (e instanceof GitCommandError) {
            res.status(500).json({ error: e.stderr.trim() || e.message });
            return;
          }
          res.status(500).json({ error: e instanceof Error ? e.message : 'git restore failed' });
        }
        return;
      }

      const target = await resolveReadTarget(
        rawPath,
        conversationId,
        projectId,
        getDb,
        opts,
      );
      if (target.status !== 200 || !target.resolved) {
        res.status(target.status).json({ error: target.error });
        return;
      }

      const resolved = target.resolved;
      const { projectRoots = [], workdirRoot } = target;

      if (!isWritePathAllowed(resolved, { projectRoots, workdirRoot })) {
        res.status(403).json({ error: 'write path not allowed' });
        return;
      }

      try {
        res.json(await restoreFileToHead(resolved));
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'git restore failed';
        if (msg === 'file is not in a git repository') {
          res.status(400).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg });
      }
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'git restore failed' });
    }
  });

  app.get('/files', async (req, res) => {
    // R1: attachment shards always serve from hub disk, even in remote contexts.
    const shard = Boolean(
      opts?.dataDir && typeof req.query.path === 'string'
        && isAttachmentShardPath(cleanRequestedPath(req.query.path), opts.dataDir),
    );
    const hostId = shard ? null : remoteHostIdForQuery(getDb(), req.query);
    if (hostId) {
      if (!opts?.nodeHub) {
        res.status(503).json({ error: 'remote host not connected' });
        return;
      }
      const root = remoteRootForQuery(getDb(), req.query);
      if ('error' in root) {
        res.status(root.status).json({ error: root.error });
        return;
      }
      try {
        await serveRemoteFile(req, res, getDb(), opts.nodeHub, hostId, root);
      } catch {
        // Express 4 does not route async throws — a rejection here would
        // otherwise crash the hub as an unhandledRejection. 502 before
        // headers are sent; hard-reset the socket after.
        if (!res.headersSent) res.status(502).json({ error: 'remote read failed' });
        else res.destroy();
      }
      return;
    }
    const target = await resolveReadTarget(
      req.query.path,
      req.query.conversationId,
      req.query.projectId,
      getDb,
      opts,
    );
    if (target.status !== 200 || !target.resolved || !target.info) {
      res.status(target.status).json({ error: target.error });
      return;
    }

    let { resolved, info, projectRoots = [], workdirRoot } = target;
    const attRoot = opts?.dataDir ? resolvePath(opts.dataDir, 'attachments') : null;
    const underAtt = Boolean(attRoot && isAttachmentShardPath(resolved, opts!.dataDir!));
    if (underAtt && attRoot) {
      const real = await realpathWithinRoots(resolved, [attRoot]);
      if (!real) {
        res.status(403).json({ error: 'path not allowed' });
        return;
      }
      resolved = real;
      try {
        info = await stat(resolved);
      } catch {
        res.status(404).json({ error: 'file not found' });
        return;
      }
    }
    const ext = extname(resolved).slice(1).toLowerCase();
    // Code + text extensions default to plain UTF-8 text; see contentTypeFor.
    const contentType = contentTypeFor(ext);

    if (!info) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    try {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', info.size.toString());
      res.setHeader('Cache-Control', 'no-store');
      const editsEnabled = getGeneralSettings(getDb()).fileEditsEnabled;
      const writable = editsEnabled && isWritePathAllowed(resolved, { projectRoots, workdirRoot }) ? '1' : '0';
      const version = versionToken(info);
      setFileMetaHeaders(res, { path: resolved, version, writable });

      // Project/Downloads/tmp bytes may be agent- or attacker-written SVG/XML,
      // which execute script when opened directly — sandbox every response
      // (same as the remote branch), not just attachment shards.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');

      // Content-Disposition — inline filename or attachment; see setDisposition.
      setDisposition(res, req, resolved);

      // HEAD is used by the draft path-chip strip to probe openability without
      // streaming the body (many chips × large files would thrash otherwise).
      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      // Range support — media elements seek by asking for byte ranges, and
      // Safari refuses to play video at all without 206 responses. Malformed
      // headers fall through to a full 200 body.
      res.setHeader('Accept-Ranges', 'bytes');
      const size = Number(info.size); // fs.Stats.size is number | bigint
      const range = parseRange(String(req.headers.range ?? ''), size);
      if (range === 'invalid') {
        res.status(416);
        // Content-Length was already set to the full size above — an empty
        // body with a stale length corrupts the response framing.
        res.setHeader('Content-Length', '0');
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
        createReadStream(resolved, { start: range.start, end: range.end }).pipe(res);
        return;
      }

      createReadStream(resolved).pipe(res);
    } catch {
      // Express 4 does not route async throws — e.g. a setHeader on a
      // non-Latin-1 filename would otherwise surface as an unhandled
      // rejection and crash the hub. 500 before headers are sent; hard-reset
      // the socket after.
      if (!res.headersSent) res.status(500).json({ error: 'file serve failed' });
      else res.destroy();
    }
  });

  app.put('/files', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawPath = body.path;
    const content = body.content;
    const version = body.version;
    const conversationId = body.conversationId;
    const projectId = body.projectId;

    if (!getGeneralSettings(getDb()).fileEditsEnabled) {
      res.status(403).json({ error: 'file edits are disabled' });
      return;
    }

    if (typeof rawPath !== 'string' || rawPath.length === 0
        || typeof content !== 'string'
        || typeof version !== 'string' || version.length === 0) {
      res.status(400).json({ error: 'path, content, and version are required strings' });
      return;
    }

    // jsonAuthed (25mb, after requireAuth) is the outer backstop; a
    // route-level express.json would be a no-op once that parser has buffered.
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
      res.status(413).json({ error: 'content too large' });
      return;
    }

    const expanded = rawPath.startsWith('~/')
      ? `${homedir()}${rawPath.slice(1)}`
      : rawPath;
    const isRelative = !isAbsolute(expanded);

    let basePath: string | undefined;
    let projectRootPath: string | undefined;
    let workdirRoot: string | undefined;
    let remoteHostId: string | null = null;
    if (typeof conversationId === 'string' && conversationId.length > 0) {
      const db = getDb();
      const convo = getConversation(db, conversationId);
      const project = convo ? getProject(db, convo.projectId) : undefined;
      if (!convo || !project) {
        res.status(404).json({ error: 'conversation or project not found' });
        return;
      }
      remoteHostId = remoteHostIdFor(db, { conversationId });
      basePath = convo.workdirPath ?? project.rootPath;
      projectRootPath = project.rootPath;
      workdirRoot = convo.workdirPath;
    } else if (typeof projectId === 'string' && projectId.length > 0) {
      const db = getDb();
      const project = getProject(db, projectId);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      remoteHostId = remoteHostIdFor(db, { projectId });
      basePath = project.rootPath;
      projectRootPath = project.rootPath;
    }

    if (remoteHostId) {
      const db = getDb();
      if (!opts?.nodeHub) {
        res.status(503).json({ error: 'remote host not connected' });
        return;
      }
      const host = getRemoteHost(db, remoteHostId);
      if (!hostHasFeature(host?.hello, 'files.write')) {
        res.status(501).json({ error: 'remote host needs update', code: 'node_update_required' });
        return;
      }
      let link: ReturnType<FileRoutesNodeHub['link']>;
      try {
        link = opts.nodeHub.link(remoteHostId);
      } catch (e) {
        const { status, error } = remoteErrorStatus(e);
        res.status(status).json({ error });
        return;
      }
      const root = resolvePath(projectRootPath!);
      const resolvedWorkdir = workdirRoot ? resolvePath(workdirRoot) : undefined;
      const activeSessions = opts.getActiveSessions?.() ?? [];
      if (activeSessions.length > 0) {
        try {
          const ops = new RemoteGitOps(opts.nodeHub, remoteHostId);
          const top = (await ops.headRef(resolvedWorkdir ?? root)).toplevel || (resolvedWorkdir ?? root);
          const live = await collectRemoteLiveAgents(db, remoteHostId, top, ops, activeSessions);
          if (live.length > 0) {
            const titles = live.map((a) => a.title).join(', ');
            res.status(409).json({
              error: `Cannot save file: ${live.length} agent(s) active on this checkout (${titles})`,
              agents: live,
            });
            return;
          }
        } catch (e) {
          if (e instanceof WorkingTreeContextError && e.status === 503) {
            res.status(503).json({ error: e.message });
            return;
          }
          // Non-git root or git error: proceed without live-agent checkout guard.
        }
      }
      if (typeof conversationId === 'string' && conversationId.length > 0) {
        try {
          const cp = await checkpointOpsFor(db, conversationId);
          if (cp) await cp.ops.snapshotCode(conversationId, `fileedit-${Date.now()}`);
        } catch { /* a snapshot must never fail the save */ }
      }
      try {
        const result = await link.request<FilesWriteResult>('files.write', {
          root,
          path: cleanRequestedPath(rawPath),
          content,
          version,
          ...(resolvedWorkdir ? { workdirRoot: resolvedWorkdir } : {}),
        });
        if (!result.ok) {
          res.status(409).json({ error: 'file has changed', currentVersion: result.currentVersion });
          return;
        }
        res.json({ path: result.path, version: result.version });
      } catch (e) {
        const { status, error } = remoteErrorStatus(e);
        res.status(status).json({ error });
      }
      return;
    }

    if (isRelative && !basePath) {
      res.status(400).json({ error: 'relative path requires conversationId or projectId' });
      return;
    }

    const rel = expanded.replace(/^\.\//, '');
    const candidate = isRelative
      ? resolvePath(basePath!, rel)
      : resolvePath(expanded);

    // Deliberate scope decision: write roots span every *local* registered
    // project (pinned by test in files.write.test.ts) — remote-host roots
    // are host-side paths and must not unlock hub disk. Worktrees alone stay
    // conversation-scoped via workdirRoot.
    const projectRoots = listProjects(getDb()).filter((p) => !p.remoteHostId).map((p) => p.rootPath);
    const writeOpts: WriteAllowOptions = { projectRoots, workdirRoot };

    if (!isWritePathAllowed(candidate, writeOpts)) {
      res.status(403).json({ error: 'path not allowed' });
      return;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(candidate);
    } catch {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    if (!info.isFile()) {
      res.status(404).json({ error: 'file not found' });
      return;
    }

    const real = await realpathWithinRoots(
      candidate,
      [...projectRoots, ...(workdirRoot ? [workdirRoot] : [])],
    );
    if (!real) {
      res.status(403).json({ error: 'path not allowed' });
      return;
    }
    if (!isWritePathAllowed(real, writeOpts)) {
      res.status(403).json({ error: 'path not allowed' });
      return;
    }

    const current = versionToken(info);
    if (current !== version) {
      res.status(409).json({ error: 'file has changed', currentVersion: current });
      return;
    }

    if (typeof conversationId === 'string' && conversationId.length > 0) {
      try {
        const cwd = resolveConversationCwd(getDb(), conversationId);
        if (cwd) snapshotCode(cwd, conversationId, `fileedit-${Date.now()}`);
      } catch { /* a snapshot must never fail the save */ }
    }

    const dir = dirname(real);
    const tmp = join(dir, `.tierwyn-save-${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, info.mode & 0o777);
      try {
        await fh.writeFile(content, 'utf8');
      } finally {
        await fh.close();
      }
      await rename(tmp, real);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      res.status(500).json({ error: e instanceof Error ? e.message : 'write failed' });
      return;
    }

    try {
      const fresh = await stat(real);
      res.json({ path: real, version: versionToken(fresh) });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'stat failed' });
    }
  });

  // Tiny CORS-bypass proxy for the "Add from URL" modal. Single-user, 25mb cap,
  // GET only. Redirects are re-validated (public-only) so a 302 cannot land on
  // loopback/metadata.
  app.get('/proxy', async (req, res) => {
    // Lax cookies ride cross-site top-level GETs, so a link to /proxy?url=<evil
    // html> would render attacker script on our origin. Only same-origin fetch()
    // may call this; the body is always a sandboxed download, never a page.
    const site = req.headers['sec-fetch-site'];
    if ((site && site !== 'same-origin') || req.headers['sec-fetch-mode'] === 'navigate') {
      res.status(403).json({ error: 'cross-site proxy request refused' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Content-Disposition', 'attachment');
    const url = String(req.query.url ?? '');
    if (!/^https?:\/\//.test(url)) {
      res.status(400).json({ error: 'url must be http(s)' });
      return;
    }
    try {
      const r = await safeFetch(url, {}, 'public-only', 5);
      if (!r.ok) {
        res.status(r.status).json({ error: `upstream ${r.status}` });
        return;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) {
        res.status(413).json({ error: 'upstream body too large' });
        return;
      }
      res.setHeader('Content-Type', r.headers.get('content-type') ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) {
      if (e instanceof OutboundUrlError) {
        res.status(400).json({ error: e.message });
        return;
      }
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
