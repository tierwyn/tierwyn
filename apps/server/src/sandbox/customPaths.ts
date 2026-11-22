import { realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { EffectivePath, SandboxPath } from '@tierwyn/shared';
import { SANDBOX_PROFILES } from './profiles.js';

export interface CustomPathCtx {
  home: string;
  cwd: string;
  repoRoot: string;
  agentType: string;
  /** Remote node.json roots; rw paths must sit strictly inside one of these. */
  roots?: string[];
  /** Extra hard-deny trees (node config dir, key, storage). */
  extraDeny?: string[];
  uid?: number;
  pathEnv?: string;
  dataDir?: string;
  realpath?: (p: string) => string;
}

export type CustomPathCheck = { ok: true } | { ok: false; reason: string };

const HOME_SECRET_RELS = [
  '.ssh',
  '.gnupg',
  '.git-credentials',
  '.config/tierwyn',
] as const;

const RW_HOME_RELS = [
  '.local/bin',
  '.local/lib',
  '.nvm',
  '.npm-global',
  '.bun',
  '.volta',
  '.cargo/bin',
  '.deno',
  'go/bin',
  '.pyenv',
  '.local/share/pnpm',
  '.opencode/bin',
  '.bashrc',
  '.profile',
  '.zshrc',
  '.bash_profile',
  '.config/systemd',
  '.config/autostart',
  '.config/git',
  '.gitconfig',
] as const;

const RW_SYSTEM_PREFIXES = ['/etc', '/usr', '/opt', '/var/spool/cron'] as const;

const OVERLAP_ABS = [
  '/etc/tierwyn',
  '/etc/shadow',
  '/etc/gshadow',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/var/lib/docker',
] as const;

/** Exact match only — descendants like `/tmp/my-models` are allowed after socket checks. */
const SHARED_TMP_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'] as const;

export function normAbs(p: string): string {
  const r = resolve(p);
  return r === '/' ? '/' : r.replace(/\/+$/, '');
}

function equalOrInside(inner: string, outer: string): boolean {
  const i = normAbs(inner);
  const o = normAbs(outer);
  return i === o || (o !== '/' && i.startsWith(o + '/')) || (o === '/' && i !== '/');
}

function strictlyInside(inner: string, outer: string): boolean {
  const i = normAbs(inner);
  const o = normAbs(outer);
  if (o === '/') return i !== '/';
  return i !== o && i.startsWith(o + '/');
}

/** P equals D, or P is a descendant of D, or P is an ancestor of D. */
function overlaps(p: string, d: string): boolean {
  return equalOrInside(p, d) || equalOrInside(d, p);
}

function isAncestorOf(p: string, d: string): boolean {
  return p !== d && equalOrInside(d, p);
}

function cwdAncestorsUpToHome(cwd: string, home: string): string[] {
  const h = normAbs(home);
  const out: string[] = [];
  let p = dirname(normAbs(cwd));
  while (p !== '/') {
    out.push(p);
    if (p === h || isAncestorOf(p, h)) break;
    const next = dirname(p);
    if (next === p) break;
    p = next;
  }
  return out;
}

function firstHomeRel(p: string, home: string): string | null {
  const h = normAbs(home);
  const abs = normAbs(p);
  if (abs === h || !equalOrInside(abs, h)) return null;
  return abs.slice(h.length + 1).split('/')[0] ?? null;
}

function socketName(p: string): boolean {
  const b = basename(normAbs(p));
  return b === 'docker.sock' || b === 'podman.sock'
    || b === 'unix.socket' || b === 'containerd.sock';
}

function sharedSocketReason(abs: string, uid: number): string | null {
  if (SHARED_TMP_ROOTS.includes(abs as typeof SHARED_TMP_ROOTS[number])) {
    return 'shared temp dir';
  }
  if (equalOrInside(abs, `/tmp/tmux-${uid}`) || /^\/tmp\/tmux-\d+(\/|$)/.test(abs)) {
    return 'tmux socket';
  }
  if (equalOrInside(abs, '/tmp/.X11-unix')) return 'X11 socket';
  if (/^\/tmp\/ssh-/.test(abs)) return 'ssh-agent socket';
  if (equalOrInside(abs, '/var/snap/lxd/common/lxd') || equalOrInside(abs, '/var/lib/lxd')) {
    return 'lxd socket';
  }
  if (socketName(abs)) return 'container socket';
  return null;
}

function maskedTrees(ctx: CustomPathCtx): string[] {
  const home = normAbs(ctx.home);
  const uid = ctx.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const out = [
    normAbs(ctx.repoRoot),
    ...HOME_SECRET_RELS.map((rel) => join(home, rel)),
    ...OVERLAP_ABS,
    `/run/user/${uid}`,
  ];
  if (ctx.dataDir) out.push(normAbs(ctx.dataDir));
  for (const d of ctx.extraDeny ?? []) out.push(normAbs(d));
  return out;
}

/** Symlink / outside-repo mount that would expose a masked tree at a path deny masks don't cover. */
function aliasMaskedReason(lexical: string, real: string, ctx: CustomPathCtx): string | null {
  const repo = normAbs(ctx.repoRoot);
  if (!equalOrInside(lexical, repo) && overlaps(real, repo)) {
    return 'alias of repo tree';
  }
  if (lexical === real) return null;
  for (const s of maskedTrees(ctx)) {
    if (real === s || isAncestorOf(real, s)) return 'alias of masked path';
  }
  return null;
}

function sudoers(p: string): boolean {
  const abs = normAbs(p);
  return abs === '/etc/sudoers' || abs.startsWith('/etc/sudoers');
}

function reasonFor(p: string, ctx: CustomPathCtx): string | null {
  const abs = normAbs(p);
  const home = normAbs(ctx.home);
  const uid = ctx.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);

  if (abs === '/') return 'filesystem root';
  if (abs === home || isAncestorOf(abs, home)) return 'home or ancestor of home';

  for (const a of cwdAncestorsUpToHome(ctx.cwd, ctx.home)) {
    if (abs === normAbs(a)) return 'cwd ancestor';
  }

  const sock = sharedSocketReason(abs, uid);
  if (sock) return sock;
  if (sudoers(abs)) return 'sudoers';

  const overlap: Array<{ path: string; reason: string }> = [
    ...OVERLAP_ABS.map((d) => ({ path: d, reason: d })),
    { path: `/run/user/${uid}`, reason: 'user runtime dir' },
    ...HOME_SECRET_RELS.map((rel) => ({ path: join(home, rel), reason: `~/${rel}` })),
    ...(ctx.extraDeny ?? []).map((d) => ({ path: d, reason: 'node secret path' })),
  ];
  // data dir: equals or inside, not ancestor. Ancestor-as-alias is rejected in aliasMaskedReason.
  if (ctx.dataDir && equalOrInside(abs, ctx.dataDir)) return 'hub data dir';

  for (const [type, prof] of Object.entries(SANDBOX_PROFILES)) {
    if (ctx.agentType && type === ctx.agentType) continue;
    for (const rel of [...prof.rw, ...(prof.ro ?? [])]) {
      overlap.push({ path: join(home, rel), reason: `other agent profile (${type})` });
    }
  }

  for (const d of overlap) {
    if (overlaps(abs, d.path)) return d.reason;
  }
  return null;
}

function rwReason(p: string, ctx: CustomPathCtx): string | null {
  const abs = normAbs(p);
  const home = normAbs(ctx.home);
  const repo = normAbs(ctx.repoRoot);

  if (overlaps(abs, repo)) return 'Tierwyn repo root as rw';

  for (const rel of RW_HOME_RELS) {
    if (overlaps(abs, join(home, rel))) return `~/${rel} as rw`;
  }

  const rel = firstHomeRel(abs, home);
  if (rel?.startsWith('.')) return "home dot-dir as rw";

  for (const sys of RW_SYSTEM_PREFIXES) {
    if (overlaps(abs, sys)) return `${sys} as rw`;
  }

  const pathEnv = ctx.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir || dir[0] !== '/') continue;
    if (overlaps(abs, dir)) return 'PATH entry as rw';
  }

  if (ctx.roots) {
    if (!ctx.roots.some((r) => strictlyInside(abs, r))) return 'outside node.json roots';
  }
  return null;
}

function checkOne(abs: string, mode: 'ro' | 'rw', ctx: CustomPathCtx): CustomPathCheck {
  const always = reasonFor(abs, ctx);
  if (always) return { ok: false, reason: always };
  if (mode === 'rw') {
    const rw = rwReason(abs, ctx);
    if (rw) return { ok: false, reason: rw };
  }
  return { ok: true };
}

export function checkCustomPath(p: SandboxPath, ctx: CustomPathCtx): CustomPathCheck {
  const lexical = normAbs(p.path);
  const first = checkOne(lexical, p.mode, ctx);
  if (!first.ok) return first;
  let real = lexical;
  try {
    real = normAbs((ctx.realpath ?? realpathSync)(lexical));
  } catch {
    const alias = aliasMaskedReason(lexical, lexical, ctx);
    if (alias) return { ok: false, reason: alias };
    return first;
  }
  if (real !== lexical) {
    const second = checkOne(real, p.mode, ctx);
    if (!second.ok) return second;
  }
  const alias = aliasMaskedReason(lexical, real, ctx);
  if (alias) return { ok: false, reason: alias };
  return { ok: true };
}

export function annotateEffectivePaths(
  paths: EffectivePath[],
  ctx: CustomPathCtx,
  exists: (path: string) => boolean,
): EffectivePath[] {
  return paths.map((p) => {
    const st = statusCustomPath(p, ctx, exists);
    return { ...p, status: st.status, ...(st.reason ? { reason: st.reason } : {}) };
  });
}

export function statusCustomPath(
  p: SandboxPath,
  ctx: CustomPathCtx,
  exists: (path: string) => boolean,
): { status: 'ok' | 'missing' | 'denied'; reason?: string } {
  const checked = checkCustomPath(p, ctx);
  if (!checked.ok) return { status: 'denied', reason: checked.reason };
  let real = p.path;
  try {
    real = (ctx.realpath ?? realpathSync)(normAbs(p.path));
  } catch {
    real = p.path;
  }
  if (!exists(p.path) && !exists(real)) {
    return { status: 'missing', reason: 'path does not exist' };
  }
  return { status: 'ok' };
}

export function hubTierwynRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export function hubDataDir(dbPath: string | undefined): string | undefined {
  if (!dbPath || dbPath === ':memory:') return undefined;
  return resolve(dirname(dbPath));
}
