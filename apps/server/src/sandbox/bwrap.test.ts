import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  binaryExtraRo,
  buildBwrapArgv,
  sandboxSpawnFor,
  bwrapAvailable,
  _resetBwrapProbeForTests,
  SandboxError,
  withPwdSpawn,
  signalSandboxTree,
  termSandboxChild,
  HOME_DENY,
  SYSTEM_DENY,
} from './bwrap.js';
import { SANDBOX_PROFILES } from './profiles.js';

const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn(() => {
  throw new Error('no git');
});

vi.mock('child_process', async (orig) => ({
  ...(await orig()),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const HOME = '/home/u';
const CWD = '/work/repo';
const K_ROOT = '/repo';
const DATA = '/repo/data';
const ATT = `${DATA}/attachments`;
const GCD_OUT = '/work/main/.git';

function roBindTripleIndex(argv: string[], path: string): number {
  return argv.findIndex((v, i) => v === '--ro-bind' && argv[i + 1] === path && argv[i + 2] === path);
}

function maskIndex(argv: string[], path: string): number {
  const tmpfs = argv.findIndex((v, i) => v === '--tmpfs' && argv[i + 1] === path);
  if (tmpfs >= 0) return tmpfs;
  return argv.findIndex((v, i) => v === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === path);
}

function fixturePaths(): Set<string> {
  return new Set([
    '/usr',
    '/etc',
    '/etc/tierwyn',
    '/etc/tierwyn/prod.env',
    `${K_ROOT}/.env`,
    HOME,
    `${HOME}/.claude`,
    `${HOME}/.npm`,
    `${HOME}/.cache`,
    `${HOME}/.nvm`,
    `${HOME}/.gitconfig`,
    CWD,
    K_ROOT,
    DATA,
    ATT,
    `${ATT}/x.png`,
    '/abs/existing.json',
    '/',
    `${HOME}/.ssh/id_rsa`,
    `${HOME}/.aws/credentials`,
    `${HOME}/.config/tierwyn/secret`,
    GCD_OUT,
    `${CWD}/.git`,
    `${CWD}/.git/config`,
    `${CWD}/.git/hooks`,
    '/proc/self/environ',
    '/proc/1234/environ',
    '/etc/tierwyn/prod.env',
    '/run/user/1000/x',
  ]);
}

function baseInput(overrides: Partial<Parameters<typeof buildBwrapArgv>[0]> = {}) {
  const paths = fixturePaths();
  const exists = (p: string) => paths.has(p);
  const isFile = (p: string) => {
    if (p === '/' || p === HOME) return false;
    if (
      p.endsWith('.json') || p.endsWith('.png') || p.endsWith('id_rsa')
      || p.endsWith('credentials') || p.endsWith('prod.env') || p.endsWith('/.env')
      || p.endsWith('/config') || p.endsWith('/environ') || p.endsWith('/x')
    ) {
      return exists(p);
    }
    return false;
  };
  return {
    cmd: 'agent',
    args: [] as string[],
    cwd: CWD,
    home: HOME,
    profile: SANDBOX_PROFILES['claude-code'],
    tierwynRoot: K_ROOT,
    exists,
    isFile,
    listDir: (dir) => (dir === K_ROOT ? ['.env', '.env.example'] : []),
    deny: [
      `${HOME}/.config/tierwyn`,
      `${HOME}/.ssh`,
      `${HOME}/.git-credentials`,
      `${HOME}/.gnupg`,
      DATA,
    ],
    argvAllow: [ATT],
    realpath: (p: string) => p,
    ...overrides,
  };
}

describe('deny lists', () => {
  it('HOME_DENY and SYSTEM_DENY include the tierwyn config paths', () => {
    expect(HOME_DENY).toEqual(expect.arrayContaining(['.config/tierwyn']));
    expect(SYSTEM_DENY).toEqual(expect.arrayContaining(['/etc/tierwyn']));
  });
});

describe('buildBwrapArgv', () => {
  it('tmpfs home before home binds', () => {
    const argv = buildBwrapArgv(baseInput());
    const tmpfsIdx = argv.indexOf('--tmpfs');
    const homeTmpfsIdx = argv.indexOf(HOME, tmpfsIdx);
    const firstHomeBind = argv.findIndex(
      (v, i) => i > 0 && argv[i - 1] === '--ro-bind' && v.startsWith(HOME),
    );
    expect(homeTmpfsIdx).toBeGreaterThan(-1);
    expect(firstHomeBind).toBeGreaterThan(homeTmpfsIdx);
  });

  it('includes cwd bind and namespace flags', () => {
    const argv = buildBwrapArgv(baseInput());
    expect(argv).toContain('--die-with-parent');
    expect(argv).toContain('--unshare-pid');
    expect(argv).not.toContain('--unshare-net');
    expect(argv).toContain('--bind');
    const cwdBind = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === CWD);
    expect(cwdBind).toBeGreaterThan(-1);
    expect(argv[cwdBind + 2]).toBe(CWD);
  });

  it('binds git common dir when outside cwd', () => {
    const withGcd = buildBwrapArgv(baseInput({ gitCommonDir: GCD_OUT }));
    expect(withGcd).toContain('--bind');
    expect(withGcd).toContain(GCD_OUT);
    const inside = buildBwrapArgv(baseInput({ gitCommonDir: `${CWD}/.git` }));
    const self = inside.findIndex((v, i) => v === '--bind' && inside[i + 1] === `${CWD}/.git` && inside[i + 2] === `${CWD}/.git`);
    expect(self).toBeGreaterThan(-1);
  });

  it('binds git common dir for a worktree repo inside home', () => {
    const gcd = `${HOME}/Projects/repo/.git`;
    const argv = buildBwrapArgv(baseInput({
      gitCommonDir: gcd,
      exists: (p) => fixturePaths().has(p) || p === gcd,
      realpath: (p) => p,
    }));
    expect(argv).toContain(gcd);
  });

  it('binds existing profile rw paths and skips missing', () => {
    const argv = buildBwrapArgv(baseInput());
    expect(argv).toContain(`${HOME}/.claude`);
    expect(argv).not.toContain(`${HOME}/.claude.json`);
  });

  it('ro-binds absolute existing files; ignores flags', () => {
    const argv = buildBwrapArgv(
      baseInput({ args: ['/abs/existing.json', '--mcp-config'] }),
    );
    expect(roBindTripleIndex(argv, '/abs/existing.json')).toBeGreaterThan(-1);
    expect(argv.filter((x) => x === '--mcp-config').length).toBe(1);
  });

  it('ro-binds .git/config after the cwd rw bind', () => {
    const argv = buildBwrapArgv(baseInput());
    const cwdBind = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === CWD && argv[i + 2] === CWD);
    const cfg = roBindTripleIndex(argv, `${CWD}/.git/config`);
    expect(cwdBind).toBeGreaterThan(-1);
    expect(cfg).toBeGreaterThan(cwdBind);
  });

  it('self-binds cwd/.git as a mount point before ctl ro-binds', () => {
    const argv = buildBwrapArgv(baseInput());
    const self = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === `${CWD}/.git` && argv[i + 2] === `${CWD}/.git`);
    const cfg = roBindTripleIndex(argv, `${CWD}/.git/config`);
    expect(self).toBeGreaterThan(-1);
    expect(cfg).toBeGreaterThan(self);
  });

  it('mounts a missing .git/hooks as a read-only empty dir', () => {
    const argv = buildBwrapArgv(baseInput({
      exists: (p) => p !== `${CWD}/.git/hooks` && fixturePaths().has(p),
    }));
    const tmpfs = argv.findIndex((v, i) => v === '--tmpfs' && argv[i + 1] === `${CWD}/.git/hooks`);
    const remount = argv.findIndex((v, i) => v === '--remount-ro' && argv[i + 1] === `${CWD}/.git/hooks`);
    expect(tmpfs).toBeGreaterThan(-1);
    expect(remount).toBeGreaterThan(tmpfs);
  });

  it('ro-binds a worktree .git file', () => {
    const gitFile = `${CWD}/.git`;
    const argv = buildBwrapArgv(baseInput({
      isFile: (p) => p === gitFile || p.endsWith('.json'),
    }));
    expect(roBindTripleIndex(argv, gitFile)).toBeGreaterThan(-1);
  });

  it('does not auto-bind /proc environ, /etc secrets, or /run paths from argv', () => {
    const argv = buildBwrapArgv(baseInput({
      args: ['--resume', '/proc/self/environ'],
      realpath: (p) => (p === '/proc/self/environ' ? '/proc/1234/environ' : p),
    }));
    const bindSources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') bindSources.push(argv[i + 1]);
    }
    expect(bindSources).not.toContain('/proc/1234/environ');
    expect(bindSources).not.toContain('/proc/self/environ');

    const etcArgv = buildBwrapArgv(baseInput({ args: ['/etc/tierwyn/prod.env'] }));
    const etcBinds: string[] = [];
    for (let i = 0; i < etcArgv.length; i++) {
      if (etcArgv[i] === '--ro-bind' || etcArgv[i] === '--bind') etcBinds.push(etcArgv[i + 1]);
    }
    expect(etcBinds).not.toContain('/etc/tierwyn/prod.env');

    const runArgv = buildBwrapArgv(baseInput({ args: ['/run/user/1000/x'] }));
    const runBinds: string[] = [];
    for (let i = 0; i < runArgv.length; i++) {
      if (runArgv[i] === '--ro-bind' || runArgv[i] === '--bind') runBinds.push(runArgv[i + 1]);
    }
    expect(runBinds).not.toContain('/run/user/1000/x');
  });

  it('does not bind directory argv paths', () => {
    const argv = buildBwrapArgv(baseInput({ args: ['/', HOME] }));
    expect(argv.join(' ')).not.toMatch(/--ro-bind \/ \/|--bind \/ \//);
    const homeRo = argv.indexOf('--ro-bind', argv.indexOf('--tmpfs', argv.indexOf(HOME)));
    expect(argv.slice(homeRo + 1, homeRo + 3)).not.toEqual(['--ro-bind', HOME, HOME]);
  });

  it('does not bind sensitive home files from argv', () => {
    const argv = buildBwrapArgv(
      baseInput({
        args: [`${HOME}/.ssh/id_rsa`, `${HOME}/.aws/credentials`],
      }),
    );
    const bindSources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') bindSources.push(argv[i + 1]);
    }
    expect(bindSources).not.toContain(`${HOME}/.ssh/id_rsa`);
    expect(bindSources).not.toContain(`${HOME}/.aws/credentials`);
  });

  it('ro-binds hub attachment paths after masking the data dir', () => {
    const att = `${ATT}/x.png`;
    const argv = buildBwrapArgv(baseInput({ args: [att] }));
    const dataMask = maskIndex(argv, DATA);
    const attBind = roBindTripleIndex(argv, att);
    expect(dataMask).toBeGreaterThan(-1);
    expect(attBind).toBeGreaterThan(dataMask);
    expect(maskIndex(argv, att)).toBe(-1);
  });

  it('rejects profile paths that expose deny trees', () => {
    for (const bad of ['.ssh', '.config', '.config/tierwyn/x']) {
      expect(() =>
        buildBwrapArgv(baseInput({ profile: { rw: [bad] } })),
      ).toThrow(/sandbox profile path denied/);
    }
  });

  it('never bind-sources deny paths under home', () => {
    const argv = buildBwrapArgv(baseInput());
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') {
        sources.push(argv[i + 1]);
      }
    }
    for (const forbidden of [
      `${HOME}/.config/tierwyn`,
      `${HOME}/.ssh`,
      `${HOME}/.git-credentials`,
      `${HOME}/.gnupg`,
    ]) {
      expect(sources.some((s) => s === forbidden || s.startsWith(forbidden + '/'))).toBe(false);
    }
  });

  it('masks /etc/tierwyn under the /etc bind', () => {
    const argv = buildBwrapArgv(baseInput());
    expect(maskIndex(argv, '/etc/tierwyn')).toBeGreaterThan(-1);
    expect(roBindTripleIndex(argv, '/etc/tierwyn/prod.env')).toBe(-1);
  });

  it('masks repo .env files under the tierwynRoot bind', () => {
    const argv = buildBwrapArgv(baseInput());
    expect(maskIndex(argv, `${K_ROOT}/.env`)).toBeGreaterThan(-1);
    expect(roBindTripleIndex(argv, `${K_ROOT}/.env`)).toBe(-1);
  });

  it('rejects cwd equal to home or an ancestor of home', () => {
    expect(() => buildBwrapArgv(baseInput({ cwd: HOME }))).toThrow(SandboxError);
    expect(() => buildBwrapArgv(baseInput({ cwd: '/home' }))).toThrow(SandboxError);
  });

  it('masks hub data dir inside tierwyn root bind', () => {
    const paths = fixturePaths();
    paths.add('/repo');
    paths.add('/repo/data');
    const argv = buildBwrapArgv(
      baseInput({
        tierwynRoot: '/repo',
        cwd: '/repo',
        deny: ['/repo/data'],
        exists: (p) => paths.has(p) || p === '/repo' || p === '/repo/data',
      }),
    );
    const repoRo = argv.findIndex((v, i) => v === '--ro-bind' && argv[i + 1] === '/repo');
    expect(repoRo).toBeGreaterThan(-1);
    const tmpfsData = argv.indexOf('--tmpfs', repoRo);
    expect(argv[tmpfsData + 1]).toBe('/repo/data');
  });

  it('ends with chdir and command', () => {
    const argv = buildBwrapArgv(baseInput({ cmd: 'claude', args: ['-p', 'hi'] }));
    expect(argv.slice(-6)).toEqual(['--chdir', CWD, '--', 'claude', '-p', 'hi']);
  });

  it('argv symlink outside home whose realpath is a denied home file is not bound', () => {
    const lex = '/var/outside-aws-link';
    const real = `${HOME}/.aws/credentials`;
    const argv = buildBwrapArgv(baseInput({
      args: [lex],
      realpath: (p) => (p === lex ? real : p),
      isFile: () => true,
      exists: (p) => p === lex || p === real,
    }));
    const bindSources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') bindSources.push(argv[i + 1]);
    }
    expect(bindSources).not.toContain(real);
    expect(bindSources).not.toContain(lex);
  });

  it('argv symlink whose realpath is under .ssh is not bound', () => {
    const lex = '/tmp/link.json';
    const real = `${HOME}/.ssh/id_rsa`;
    const argv = buildBwrapArgv(baseInput({
      args: [lex],
      realpath: (p) => (p === lex ? real : p),
      isFile: () => true,
      exists: (p) => p === lex || p === real,
    }));
    const bindSources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind') bindSources.push(argv[i + 1]);
    }
    expect(bindSources).not.toContain(real);
  });

  it('argv allowed path binds real source to lexical destination', () => {
    const lex = '/tmp/mcp.json';
    const real = '/abs/existing.json';
    const argv = buildBwrapArgv(baseInput({
      args: [lex],
      realpath: (p) => (p === lex ? real : p),
      isFile: () => true,
      exists: (p) => p === lex || p === real,
    }));
    const idx = argv.indexOf('--ro-bind');
    expect(argv[idx + 1]).toBe(real);
    expect(argv[idx + 2]).toBe(lex);
  });

  it('drops gitCommonDir when under home, root, or deny', () => {
    const denyTierwyn = `${HOME}/.config/tierwyn`;
    for (const gcd of [HOME, '/', `${denyTierwyn}/node`]) {
      const argv = buildBwrapArgv(baseInput({
        gitCommonDir: gcd,
        exists: (p) => fixturePaths().has(p) || p === gcd,
        realpath: (p) => p,
      }));
      expect(argv.filter((v, i) => argv[i - 1] === '--bind' && v === gcd)).toHaveLength(0);
    }
  });

  it('ro-binds custom paths before deny masks', () => {
    const extra = '/srv/models';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: extra, mode: 'ro' }],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === extra,
    }));
    const customIdx = roBindTripleIndex(argv, extra);
    expect(customIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeLessThan(maskIndex(argv, DATA));
    expect(customIdx).toBeLessThan(maskIndex(argv, '/etc/tierwyn'));
    expect(customIdx).toBeLessThan(maskIndex(argv, `${K_ROOT}/.env`));
  });

  it('rw-binds custom paths before deny masks', () => {
    const extra = '/srv/models';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: extra, mode: 'rw' }],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === extra,
    }));
    const idx = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === extra && argv[i + 2] === extra);
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(maskIndex(argv, DATA));
  });

  it('skips missing optional custom paths and throws sandbox_path_missing when required', () => {
    const missing = '/srv/missing-models';
    const skipped = buildBwrapArgv(baseInput({
      customPaths: [{ path: missing, mode: 'ro' }],
      agentType: 'claude-code',
    }));
    expect(skipped).not.toContain(missing);

    try {
      buildBwrapArgv(baseInput({
        customPaths: [{ path: missing, mode: 'ro', optional: false }],
        agentType: 'claude-code',
      }));
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).code).toBe('sandbox_path_missing');
    }
  });

  it('does not bind a hard-denied custom path', () => {
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: `${HOME}/.ssh`, mode: 'ro' }],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === `${HOME}/.ssh`,
    }));
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') sources.push(argv[i + 1]);
    }
    expect(sources).not.toContain(`${HOME}/.ssh`);
  });

  it('throws sandbox_path_denied when a required custom path is hard-denied (L1)', () => {
    try {
      buildBwrapArgv(baseInput({
        customPaths: [{ path: `${HOME}/.ssh`, mode: 'ro', optional: false }],
        agentType: 'claude-code',
        exists: (p) => fixturePaths().has(p) || p === `${HOME}/.ssh`,
      }));
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).code).toBe('sandbox_path_denied');
    }
  });

  it('does not bind a symlink custom path whose realpath is the repo root (H1)', () => {
    const link = '/tmp/repo-link';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: link, mode: 'ro' }],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === link || p === K_ROOT,
      realpath: (p) => (p === link ? K_ROOT : p),
    }));
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') sources.push(argv[i + 1]);
    }
    expect(sources).not.toContain(link);
  });

  it('throws sandbox_path_denied for a required H1 symlink alias of the repo', () => {
    const link = '/tmp/repo-link';
    try {
      buildBwrapArgv(baseInput({
        customPaths: [{ path: link, mode: 'ro', optional: false }],
        agentType: 'claude-code',
        exists: (p) => fixturePaths().has(p) || p === link || p === K_ROOT,
        realpath: (p) => (p === link ? K_ROOT : p),
      }));
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).code).toBe('sandbox_path_denied');
    }
  });

  it('does not bind /tmp or /var/tmp as custom paths (M2)', () => {
    const argv = buildBwrapArgv(baseInput({
      customPaths: [
        { path: '/tmp', mode: 'ro' },
        { path: '/var/tmp', mode: 'rw' },
        { path: '/tmp/tmux-1000', mode: 'ro' },
      ],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === '/tmp' || p === '/var/tmp' || p === '/tmp/tmux-1000',
    }));
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') sources.push(argv[i + 1]);
    }
    expect(sources).not.toContain('/tmp');
    expect(sources).not.toContain('/var/tmp');
    expect(sources).not.toContain('/tmp/tmux-1000');
  });

  it('binds nested custom paths parent-before-child so child mode wins (L3)', () => {
    const parent = '/srv/data';
    const child = '/srv/data/readonly';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [
        { path: child, mode: 'ro' },
        { path: parent, mode: 'rw' },
      ],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === parent || p === child,
    }));
    const parentIdx = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === parent && argv[i + 2] === parent);
    const childIdx = roBindTripleIndex(argv, child);
    expect(parentIdx).toBeGreaterThan(-1);
    expect(childIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeLessThan(childIdx);
  });

  it('does not rw-bind a custom path outside node roots at spawn time (F1)', () => {
    const extra = '/srv/outside-cache';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: extra, mode: 'rw' }],
      roots: ['/work'],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === extra,
    }));
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') sources.push(argv[i + 1]);
    }
    expect(sources).not.toContain(extra);
  });

  it('does not rw-bind a custom path whose realpath is outside node roots (F1 symlink swap)', () => {
    const extra = '/work/cache';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: extra, mode: 'rw' }],
      roots: ['/work'],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === extra || p === '/srv/outside',
      realpath: (p) => (p === extra ? '/srv/outside' : p),
    }));
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') sources.push(argv[i + 1]);
    }
    expect(sources).not.toContain(extra);
    expect(sources).not.toContain('/srv/outside');
  });

  it('does not rw-bind a node root itself (F1 strictly inside)', () => {
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: '/work', mode: 'rw' }],
      roots: ['/work'],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === '/work',
    }));
    const sources: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') sources.push(argv[i + 1]);
    }
    expect(sources).not.toContain('/work');
  });

  it('rw-binds a custom path strictly inside node roots', () => {
    const extra = '/work/cache';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [{ path: extra, mode: 'rw' }],
      roots: ['/work'],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === extra,
    }));
    const idx = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === extra && argv[i + 2] === extra);
    expect(idx).toBeGreaterThan(-1);
  });

  it('tmpfs-masks extraDeny node secret paths under a bound ancestor (F2)', () => {
    const secret = '/opt/tierwyn-node';
    const argv = buildBwrapArgv(baseInput({
      extraDeny: [secret],
      extraRo: ['/opt'],
      exists: (p) => fixturePaths().has(p) || p === '/opt' || p === secret,
    }));
    expect(maskIndex(argv, secret)).toBeGreaterThan(-1);
  });

  it('de-duplicates custom paths with ro winning', () => {
    const extra = '/srv/models';
    const argv = buildBwrapArgv(baseInput({
      customPaths: [
        { path: extra, mode: 'rw' },
        { path: extra, mode: 'ro' },
      ],
      agentType: 'claude-code',
      exists: (p) => fixturePaths().has(p) || p === extra,
    }));
    const ro = roBindTripleIndex(argv, extra);
    const rw = argv.findIndex((v, i) => v === '--bind' && argv[i + 1] === extra && argv[i + 2] === extra);
    expect(ro).toBeGreaterThan(-1);
    expect(rw).toBe(-1);
  });
});

describe('sandboxSpawnFor', () => {
  beforeEach(() => {
    _resetBwrapProbeForTests();
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no git');
    });
  });

  it('throws sandbox_no_cwd without cwd', () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    expect(() => sandboxSpawnFor('claude-code')('cmd', [], {})).toThrow(SandboxError);
    try {
      sandboxSpawnFor('claude-code')('cmd', [], {});
    } catch (e) {
      expect((e as SandboxError).code).toBe('sandbox_no_cwd');
    }
  });

  it('throws sandbox_unsupported_agent for an agent without a profile', () => {
    expect(() => sandboxSpawnFor('no-such-agent')('cmd', [], { cwd: '/tmp' })).toThrow(SandboxError);
    try {
      sandboxSpawnFor('no-such-agent')('cmd', [], { cwd: '/tmp' });
    } catch (e) {
      expect((e as SandboxError).code).toBe('sandbox_unsupported_agent');
    }
  });

  it('probe failure → unavailable, spawn never called', () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined });
    expect(bwrapAvailable()).toBe(false);
    try {
      sandboxSpawnFor('claude-code')('cmd', [], { cwd: '/tmp' });
    } catch (e) {
      expect((e as SandboxError).code).toBe('sandbox_unavailable');
    }
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('caches successful probe', () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    expect(bwrapAvailable()).toBe(true);
    expect(bwrapAvailable()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockSpawnSync.mock.calls[0][1]).toEqual(['--ro-bind', '/', '/', '--unshare-pid', 'true']);
  });

  it('happy path spawns bwrap with opts passthrough and PWD=cwd', () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    const opts = { cwd: '/tmp/w', env: { X: '1' } };
    mockSpawn.mockReturnValue({ pid: 1, kill: vi.fn() });
    sandboxSpawnFor('claude-code')('agent', ['a'], opts);
    expect(mockSpawn).toHaveBeenCalledWith('bwrap', expect.any(Array), expect.objectContaining({
      cwd: '/tmp/w',
      env: expect.objectContaining({ X: '1', PWD: '/tmp/w' }),
    }));
  });

  it('undefined agent returns module spawn', () => {
    expect(sandboxSpawnFor(undefined)).toBe(spawn);
  });

  it('tierwynRoot resolves to the monorepo root', () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    mockSpawn.mockReturnValue({ pid: 1, kill: vi.fn() });
    sandboxSpawnFor('claude-code')('agent', [], { cwd: '/tmp/w' });
    const bwrapArgs = mockSpawn.mock.calls[0][1] as string[];
    const roots = bwrapArgs.filter((_, i) => bwrapArgs[i - 1] === '--ro-bind');
    expect(roots.some((r) =>
      existsSync(join(r, 'packages/shared')) ||
      existsSync(join(r, 'apps/server')) ||
      r.includes('Tierwyn-agent-sandbox')
    )).toBe(true);
  });

  it('binds customPaths from sandboxSpawnFor extras', () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    mockSpawn.mockReturnValue({ pid: 1, kill: vi.fn() });
    const dir = mkdtempSync(join(tmpdir(), 'sb-custom-'));
    try {
      sandboxSpawnFor('claude-code', { customPaths: [{ path: dir, mode: 'ro' }] })('agent', [], { cwd: '/tmp/w' });
      const argv = mockSpawn.mock.calls[0][1] as string[];
      const idx = argv.findIndex((v, i) => v === '--ro-bind' && argv[i + 1] === dir && argv[i + 2] === dir);
      expect(idx).toBeGreaterThan(-1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('withPwdSpawn sets PWD from cwd on the unsandboxed path', () => {
    const inner = vi.fn().mockReturnValue({ pid: 9 });
    withPwdSpawn(inner as typeof spawn)('cmd', [], { cwd: '/work/p', env: { A: '1' } });
    expect(inner).toHaveBeenCalledWith('cmd', [], expect.objectContaining({
      cwd: '/work/p',
      env: expect.objectContaining({ A: '1', PWD: '/work/p' }),
    }));
  });
});

describe('signalSandboxTree', () => {
  it('signals non-bwrap descendants before the root (CLI flush before die-with-parent)', () => {
    const killed: Array<[number, string]> = [];
    // tree: 10(bwrap) → 11(bwrap) → 12(kimi)
    signalSandboxTree(10, 'SIGTERM', {
      childrenOf: (pid) => (pid === 10 ? [11] : pid === 11 ? [12] : []),
      isBwrap: (pid) => pid === 10 || pid === 11,
      kill: (pid, sig) => { killed.push([pid, sig]); },
    });
    expect(killed).toEqual([[12, 'SIGTERM']]);
  });

  it('falls back to process-group kill when no non-bwrap descendant exists', () => {
    const killed: Array<[number, string]> = [];
    signalSandboxTree(10, 'SIGTERM', {
      childrenOf: () => [],
      isBwrap: () => true,
      kill: (pid, sig) => { killed.push([pid, sig]); },
    });
    expect(killed).toEqual([[-10, 'SIGTERM']]);
  });
});

describe('termSandboxChild', () => {
  it('uses signalSandboxTree for a live pid and arms group escalate', () => {
    vi.useFakeTimers();
    const signaled: Array<[number, string]> = [];
    const child = {
      pid: 50,
      kill: vi.fn(),
      once: vi.fn(),
      exitCode: null,
      signalCode: null,
    };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    termSandboxChild(child as unknown as import('child_process').ChildProcess, {
      childrenOf: (pid) => (pid === 50 ? [51] : []),
      isBwrap: (pid) => pid === 50,
      kill: (pid, sig) => { signaled.push([pid, sig]); },
    });
    expect(signaled).toEqual([[51, 'SIGTERM']]);
    // escalateKill arms a group SIGKILL; advance so it fires without leaking timers
    vi.advanceTimersByTime(5_000);
    expect(killSpy).toHaveBeenCalledWith(-50, 'SIGKILL');
    killSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('binaryExtraRo', () => {
  it('binds the symlink target dir for an absolute command (packaged node passes /home/u/.local/bin/claude)', async () => {
    const { mkdirSync, writeFileSync, symlinkSync, realpathSync } = await import('fs');
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'bxr-')));
    try {
      mkdirSync(join(home, '.local/bin'), { recursive: true });
      mkdirSync(join(home, '.local/share/claude/versions'), { recursive: true });
      writeFileSync(join(home, '.local/share/claude/versions/2.1.0'), '');
      symlinkSync(join(home, '.local/share/claude/versions/2.1.0'), join(home, '.local/bin/claude'));
      expect(binaryExtraRo(join(home, '.local/bin/claude'), home).sort()).toEqual(
        [join(home, '.local/bin'), join(home, '.local/share/claude/versions')].sort(),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
