/**
 * Single source of truth for which file extensions count as "openable" in agent
 * output, and the regex that finds their paths in free text. The server's file
 * route re-uses these lists so the client and server never drift on what's
 * considered an image vs a markdown file.
 */

export const IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
] as const;
export const AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus',
] as const;
export const VIDEO_EXTENSIONS = [
  'mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi',
] as const;
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'] as const;

/**
 * Source code extensions. Kept broad — agents frequently reference source
 * files in prose, and the user wants every reference clickable. highlight.js
 * (already loaded for chat code blocks) handles the highlighting by extension
 * alias, so no extra deps.
 */
export const CODE_EXTENSIONS = [
  // JS / TS
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  // Web markup / style
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'vue', 'svelte', 'astro', 'xml',
  // Config / data
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'csv', 'tsv',
  // Systems
  'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx', 'rs', 'go', 'zig', 'nim',
  // JVM
  'java', 'kt', 'kts', 'scala', 'groovy', 'clj', 'cljs',
  // Mobile
  'swift', 'm', 'mm',
  // Microsoft
  'cs', 'fs', 'vb', 'ps1', 'psm1',
  // Scripting
  'py', 'pyi', 'rb', 'php', 'lua', 'pl', 'pm', 'r', 'dart', 'jl',
  // Shell
  'sh', 'bash', 'zsh', 'fish',
  // Query / schema
  'sql', 'graphql', 'gql', 'proto', 'prisma',
  // Misc
  'diff', 'patch', 'ini', 'cfg', 'conf', 'toml', 'editorconfig',
  'dockerfile', 'makefile', 'lock',
] as const;

/**
 * Plain-text / log extensions. Rendered as plain text (no syntax colouring
 * beyond what highlight.js auto-detect picks up — usually nothing).
 */
export const TEXT_EXTENSIONS = ['txt', 'log', 'text', 'out', 'err'] as const;

export const OPENABLE_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
] as const;

export type OpenableExtension = typeof OPENABLE_EXTENSIONS[number];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXT_ALTS = OPENABLE_EXTENSIONS.map(escapeRe).join('|');

/** One path segment without spaces — bare relative paths like `docs/diagram.png`. */
const SEG_PLAIN = '[\\w.\\-@]+';

/** Token without dots. Used so spaced segments cannot swallow `file.ext word`. */
const SEG_NODOT = '[\\w\\-@]+';

/**
 * Intermediate directory segment: spaces OK (`My Project`), dots forbidden.
 * Forbidding dots kills the slash bridge (`plan.md and ../docs/b.txt`) where
 * a prior path's basename + prose would otherwise form a legal spaced segment
 * immediately before the next path's `/`.
 */
const SEG_DIR = `${SEG_NODOT}(?:[ ]+${SEG_NODOT})*`;

/**
 * Terminal basename: spaced nodot tokens (`Screenshot From 2026-09-11`) OR a
 * single plain segment that may contain dots (`file.name`). Spaced form is
 * first so multi-token basenames win; this also kills the terminal bridge
 * (`/home/u/a.md see notes.txt`) because a spaced run cannot start at `a.md`
 * (dot in the first token).
 */
const SEG_TERMINAL = `(?:${SEG_NODOT}(?:[ ]+${SEG_NODOT})+|${SEG_PLAIN})`;

/** Reject matches inside http(s)/ftp URLs (e.g. `/cdn.example.com/x.png`). */
const NOT_IN_URL = '(?<!(?:https?|ftp)://[^\\s]*)';

/**
 * Match an absolute POSIX path that ends in an openable extension. Boundaries
 * reject paths inside longer filenames (`/a/b.pngc` won't match). The terminal
 * basename may contain spaces (screenshot names); intermediate dirs may too,
 * but only without dots (see SEG_DIR).
 */
export const OPENABLE_PATH_RE = new RegExp(
  // Excludes "~", ".", ":", and "/" (blocks `/example.com/x.png` after `https://`).
  // eslint-disable-next-line no-useless-escape
  `(?<![\\w$~.:/])${NOT_IN_URL}(/(?:${SEG_DIR}/)*${SEG_TERMINAL}\\.(?:${EXT_ALTS}))(?![\\w$])`,
  'gi',
);

/**
 * Match relative paths starting with `./` or `~/`. Nested directories after
 * the prefix are supported; terminal basename may contain spaces.
 */
export const OPENABLE_RELATIVE_RE = new RegExp(
  // eslint-disable-next-line no-useless-escape
  `(?<![\\w$/.])${NOT_IN_URL}((?:\\./|~/)(?:${SEG_DIR}/)*${SEG_TERMINAL}\\.(?:${EXT_ALTS}))(?![\\w$])`,
  'gi',
);

/**
 * Match multi-segment bare relative paths like `docs/plan/foo.md`. Intermediate
 * segments must not contain spaces; terminal basename may contain spaces.
 * Overlap with a longer path match is filtered in extractOpenablePaths.
 */
export const OPENABLE_BARE_RELATIVE_RE = new RegExp(
  // eslint-disable-next-line no-useless-escape
  `(?<![\\w$/.])((?:${SEG_PLAIN}/)+${SEG_TERMINAL}\\.(?:${EXT_ALTS}))(?![\\w$])`,
  'gi',
);

/**
 * Match a single bare filename that ends in an openable extension (e.g. `CLAUDE.md`,
 * `README.md`, `agent-profiles.json`, `Screenshot 2026-09-11.png`). Anchored so it
 * is only used to linkify whole inlineCode tokens (backtick spans) without matching prose words.
 */
export const OPENABLE_BARE_FILENAME_RE = new RegExp(
  `^(${SEG_TERMINAL}\\.(?:${EXT_ALTS}))(?![\\w$])`,
  'i',
);

/**
 * Extension gate for bare filenames in plain prose. Full OPENABLE_EXTENSIONS
 * minus the collision-prone set: single-letter extensions (`.c`/`.h`/`.m`/`.r`)
 * and extensions that collide with English words or brand names written with a
 * dot (`.go` as in "go", `.js` as in Node.js / Next.js / Vue.js, `.out`/`.err`).
 * Full and directory-qualified paths are unaffected — they match the main regexes.
 */
const BARE_FILENAME_INLINE_DENYLIST = new Set(['c', 'h', 'm', 'r', 'go', 'js', 'out', 'err']);
const BARE_FILENAME_INLINE_EXTS: readonly string[] = OPENABLE_EXTENSIONS.filter(
  (ext) => !BARE_FILENAME_INLINE_DENYLIST.has(ext),
);
const BARE_FILENAME_INLINE_EXT_ALTS = BARE_FILENAME_INLINE_EXTS.map(escapeRe).join('|');
const IMG_ALTS = IMAGE_EXTENSIONS.map(escapeRe).join('|');

/**
 * Match screenshot filenames with spaces in inline prose (e.g. `Screenshot 2026-09-11.png`,
 * `Screenshot From 2026-09-11 08-11-20.png`, `Screen Shot 2026-09-11 at 10.30.00.png`).
 * Starts with 'Screenshot' or 'Screen Shot' to avoid swallowing arbitrary English sentences.
 */
export const OPENABLE_SCREENSHOT_INLINE_RE = new RegExp(
  // eslint-disable-next-line no-useless-escape
  `(?<![\\w$/.-])((?:Screenshot|Screen Shot)[\\w\\s\\-@().]*?\\.(?:${IMG_ALTS}))(?![\\w$])`,
  'gi',
);

/**
 * Match a bare filename inside a longer text run (not `^`-anchored). Same
 * boundary guards as OPENABLE_BARE_RELATIVE_RE; gated by
 * BARE_FILENAME_INLINE_EXTS (all openable extensions minus collision-prone ones).
 */
export const OPENABLE_BARE_FILENAME_INLINE_RE = new RegExp(
  // eslint-disable-next-line no-useless-escape
  `(?<![\\w$/.])(${SEG_PLAIN}\\.(?:${BARE_FILENAME_INLINE_EXT_ALTS}))(?![\\w$])`,
  'gi',
);

export type OpenablePathMatch = { start: number; end: number; path: string };

/**
 * Find every openable path substring in `text` (absolute, relative, file://,
 * bare multi-segment, and conservative bare filenames). Overlaps are resolved
 * by earliest start, then longest match. Used by prose linkifiers so markdown
 * and tool-block text classify identically.
 */
export function findOpenablePaths(text: string): OpenablePathMatch[] {
  if (!text) return [];
  const found: OpenablePathMatch[] = [];

  const pushAll = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let path = m[1];
      let pathStart = m.index + (m[0].length - path.length);
      // withImagePathRefs prefixes `@` so CLIs treat the token as a path
      // mention. It is not part of the filesystem path GET /files expects.
      if (path.startsWith('@')) {
        const rest = path.slice(1);
        if (rest.startsWith('/') || rest.startsWith('~/') || rest.startsWith('./') || rest.startsWith('../')) {
          path = rest;
          pathStart += 1;
        }
      }
      found.push({ start: pathStart, end: pathStart + path.length, path });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  };

  pushAll(OPENABLE_PATH_RE);
  pushAll(OPENABLE_RELATIVE_RE);
  pushAll(OPENABLE_FILE_URI_RE);
  pushAll(OPENABLE_BARE_RELATIVE_RE);
  pushAll(OPENABLE_SCREENSHOT_INLINE_RE);
  pushAll(OPENABLE_BARE_FILENAME_INLINE_RE);

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const unique: OpenablePathMatch[] = [];
  let lastEnd = -1;
  for (const m of found) {
    if (m.start < lastEnd) continue;
    let path = m.path;
    if (path.startsWith('/') && !isPlausibleFsAbsolute(path)) {
      // Leading-slash path that is not under a real filesystem root
      // (`/docs/plan.md`) — treat as project-relative so GET /files can
      // resolve it against the conversation's workdir / project root.
      const rel = toProjectRelativePath(path);
      if (!rel) continue; // system root (/etc/..., /usr/...) — never a project file
      path = rel; // fetch target loses the slash; the visible label keeps the span
    } else if (!shouldLinkifyPath(path)) {
      continue;
    }
    unique.push({ start: m.start, end: m.end, path });
    lastEnd = m.end;
  }
  return unique;
}

/**
 * Match a file:/// URL that ends in an openable extension, with an optional
 * trailing hash line number (e.g. #L10 or #L10-L20). Accepts both literal spaces
 * and percent-encoded (%20) segments.
 *
 * Path body is a single linear class (`[^"'<>\\n]*`) — NOT nested
 * `(dir/)*terminal` quantifiers. The old form catastrophically backtracked on
 * long sandbox attachment URLs ending in non-openable exts (`.gz`, `.bin`),
 * freezing the SPA when tool results were path-linkified.
 */
export const OPENABLE_FILE_URI_RE = new RegExp(
  // eslint-disable-next-line no-useless-escape
  `(?<![\\w$])(file://(?:localhost)?/[^"'<>\\n]*\\.(?:${EXT_ALTS})(?:#L\\d+(?:-L\\d+)?)?)(?![\\w$])`,
  'gi',
);

/**
 * Absolute paths we treat as filesystem (not web-root URLs like `/tierwyn-icon.svg`
 * or `/icons/icon-192.png`). Real agent paths are under /home, /tmp, /var/tmp.
 */
export function isPlausibleFsAbsolute(path: string): boolean {
  if (path.startsWith('/home/') || path.startsWith('/tmp/') || path.startsWith('/var/tmp/')) {
    return true;
  }
  // file:// URIs are normalised elsewhere; bare absolute must have a known root.
  return false;
}

/**
 * First segment is a machine directory, never a project folder —
 * `/etc/nginx/nginx.conf` must not become a project-relative fetch.
 * (`home`/`tmp` are absent: paths under them are plausible-fs already.)
 */
const SYSTEM_ROOT_SEGMENTS = new Set([
  'bin', 'boot', 'dev', 'etc', 'lib', 'lib64', 'media', 'mnt', 'opt',
  'proc', 'run', 'sbin', 'snap', 'srv', 'sys', 'usr', 'var',
]);

/**
 * Rewrite a leading-slash path that is not under a real filesystem root
 * (`/docs/plan.md`, `/icons/icon-192.png`) into the project-relative path
 * GET /files resolves against the conversation's workdir / project root.
 * Returns null for known system roots, which are never project files.
 */
export function toProjectRelativePath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const rel = path.slice(1);
  if (!rel) return null;
  const firstSeg = rel.split('/', 1)[0];
  if (SYSTEM_ROOT_SEGMENTS.has(firstSeg.toLowerCase())) return null;
  return rel;
}

/**
 * Whether a matched path should become a clickable link. Drops web-root
 * absolutes (`/docs/plan.md`, `/icons/icon-192.png`) that never resolve via
 * GET /files. Relative, `~/`, `./`, and bare names always pass.
 */
export function shouldLinkifyPath(path: string): boolean {
  if (!path) return false;
  let p = path;
  if (p.startsWith('file://')) {
    p = p.slice(7);
    if (p.startsWith('localhost/')) p = p.slice(9);
    const hashIdx = p.indexOf('#');
    if (hashIdx >= 0) p = p.slice(0, hashIdx);
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep */
    }
  }
  if (p.startsWith('/') && !isPlausibleFsAbsolute(p)) {
    return toProjectRelativePath(p) !== null;
  }
  return true;
}

/**
 * Extract all openable paths from a block of prose / event chunk.
 * Normalises `file://` prefixes into FS paths, rewrites web-root-looking
 * paths (`/docs/plan.md`) into project-relative targets, and deduplicates.
 *
 * Note: very short extensions like `.c`, `.h`, `.m` produce more false
 * positives in prose than `.tsx` does. That's accepted — the server still
 * enforces the allow-list, so a click on a non-file just 404s.
 */
export function extractOpenablePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const match of findOpenablePaths(text)) {
    let p = match.path;
    // Normalise file:// before the FS-root check so we filter web-looking paths only.
    if (p.startsWith('file://')) {
      p = p.slice(7);
      if (p.startsWith('localhost/')) p = p.slice(9);
      const hashIdx = p.indexOf('#');
      if (hashIdx >= 0) p = p.slice(0, hashIdx);
      try {
        p = decodeURIComponent(p);
      } catch {
        /* keep */
      }
    }
    // Rewrite web-root absolutes (`/docs/plan.md`) to project-relative targets
    // so they resolve via GET /files; system roots (`/etc/...`) are dropped.
    if (p.startsWith('/') && !isPlausibleFsAbsolute(p)) {
      const rel = toProjectRelativePath(p);
      if (!rel) continue;
      p = rel;
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** True when `p` names a location (absolute, ~/ ./ ../, or a nested relative),
 *  not a bare filename like `agent-activity.png` mentioned in prose. */
function isLocatedPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~/') || p.startsWith('./') || p.startsWith('../') || p.includes('/');
}

/** Only the image-bearing paths — used by the bottom preview strip. */
export function extractImagePaths(text: string): string[] {
  const img = new Set<string>(IMAGE_EXTENSIONS);
  return extractOpenablePaths(text).filter((p) => {
    const dot = p.lastIndexOf('.');
    if (dot < 0) return false;
    if (!img.has(p.slice(dot + 1).toLowerCase() as OpenableExtension)) return false;
    return isLocatedPath(p);
  });
}

export function isOpenableExtension(ext: string): boolean {
  return (OPENABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isImageExtension(ext: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isAudioExtension(ext: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isVideoExtension(ext: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isMarkdownExtension(ext: string): boolean {
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isCodeExtension(ext: string): boolean {
  return (CODE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isTextExtension(ext: string): boolean {
  return (TEXT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export const HTML_EXTENSIONS = ['html', 'htm'] as const;
export function isHtmlExtension(ext: string): boolean {
  return (HTML_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Basename patterns for files that should NEVER be served through the file
 * modal, regardless of extension or directory. Catches secrets that ride
 * inside otherwise-allowed extensions (e.g. `secrets.txt`, `credentials.log`)
 * and dotfiles that don't have a normal extension at all (`.env`,
 * `.npmrc`, `id_rsa`).
 *
 * The server checks this AFTER the extension allow-list, so this is
 * defense-in-depth: even if a future extension addition accidentally covers
 * a secrets shape, the basename check still rejects it.
 */
const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,                       // .env, .env.local, .env.production
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.htpasswd$/i,
  /^\.git-credentials$/i,
  /^\.netrc$/i,
  /^\.aws-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, // SSH keys + public counterparts
  /^credentials(\..*)?$/i,
  /^\.credentials\.json$/i,               // ~/.claude/.credentials.json
  /^auth\.json$/i,                        // ~/.codex/auth.json, ~/.local/share/opencode/auth.json
  /^oauth_creds\.json$/i,                 // ~/.gemini/oauth_creds.json
  /^google_accounts\.json$/i,             // ~/.gemini
  /^(cli-)?config\.json\.bak$/i,
  /^hosts\.yml$/i,                        // gh / copilot token store
  /^\.?token(s)?(\.json)?$/i,
  /^secrets?(\..*)?$/i,                    // secrets.txt, secret.log
  /^passwords?(\..*)?$/i,
  /^api[_-]?key(\..*)?$/i,
  /^service[_-]?account(\..*)?$/i,
];

/**
 * True iff `path`'s basename matches a known secrets pattern. Callers should
 * also enforce an extension allow-list — this is a deny-list on top.
 */
export function isSecretPath(path: string): boolean {
  if (!path) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(base));
}
