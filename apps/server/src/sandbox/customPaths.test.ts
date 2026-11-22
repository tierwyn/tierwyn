import { describe, it, expect } from 'vitest';
import { unionSandboxPaths, type SandboxPath } from '@tierwyn/shared';
import { checkCustomPath, type CustomPathCtx } from './customPaths.js';

const HOME = '/home/u';
const CWD = '/home/u/Projects/app';
const REPO = '/home/u/Projects/Tierwyn';
const DATA = '/home/u/Projects/Tierwyn/data';

function ctx(overrides: Partial<CustomPathCtx> = {}): CustomPathCtx {
  return {
    home: HOME,
    cwd: CWD,
    repoRoot: REPO,
    agentType: 'opencode',
    uid: 1000,
    dataDir: DATA,
    pathEnv: '/usr/bin:/home/u/.local/bin:/opt/custom/bin:/home/u/tools/bin',
    realpath: (p) => p,
    ...overrides,
  };
}

function path(p: string, mode: 'ro' | 'rw' = 'ro'): SandboxPath {
  return { path: p, mode };
}

function denied(p: string, mode: 'ro' | 'rw' = 'ro', extra?: Partial<CustomPathCtx>) {
  const r = checkCustomPath(path(p, mode), ctx(extra));
  expect(r.ok, `${mode} ${p} should be denied`).toBe(false);
  if (!r.ok) expect(r.reason).toBeTruthy();
}

function allowed(p: string, mode: 'ro' | 'rw' = 'ro', extra?: Partial<CustomPathCtx>) {
  const r = checkCustomPath(path(p, mode), ctx(extra));
  expect(r.ok, `${mode} ${p} should be allowed (${!r.ok ? r.reason : ''})`).toBe(true);
}

describe('checkCustomPath hard-deny', () => {
  it('denies /, $HOME, and ancestors of $HOME', () => {
    denied('/');
    denied(HOME);
    denied('/home');
    denied('/home/u');
  });

  it('denies cwd ancestors up to $HOME but not cwd itself', () => {
    denied('/home/u/Projects');
    allowed(CWD);
  });

  it('denies secret home dirs and hub secrets', () => {
    denied(`${HOME}/.ssh`);
    denied(`${HOME}/.ssh/id_rsa`);
    denied(`${HOME}/.gnupg`);
    denied(`${HOME}/.git-credentials`);
    denied(`${HOME}/.config/tierwyn`);
    denied('/etc/tierwyn');
    denied(DATA);
    denied('/etc/shadow');
    denied('/etc/gshadow');
    denied('/etc/sudoers');
    denied('/etc/sudoers.d');
  });

  it('denies proc/sys/dev/run and container sockets', () => {
    denied('/proc');
    denied('/proc/1');
    denied('/sys');
    denied('/dev');
    denied('/run');
    denied('/var/run');
    denied('/run/user/1000');
    denied('/tmp/docker.sock');
    denied('/run/podman.sock');
    denied('/var/lib/docker');
  });

  it("denies other agents' SANDBOX_PROFILES dirs, not the current agent's", () => {
    denied(`${HOME}/.claude`);
    denied(`${HOME}/.codex`);
    allowed(`${HOME}/.config/opencode`);
    allowed(`${HOME}/.local/share/opencode`);
  });

  it('denies the Tierwyn repo root as rw and allows it as ro', () => {
    denied(REPO, 'rw');
    denied(`${REPO}/apps`, 'rw');
    allowed(REPO, 'ro');
    allowed(`${REPO}/apps`, 'ro');
  });

  it('allows a non-sensitive extra dir', () => {
    allowed('/srv/models');
    allowed('/srv/models', 'rw');
  });

  it('denies shared temp roots and well-known socket dirs (M2)', () => {
    denied('/tmp');
    denied('/var/tmp');
    denied('/dev/shm');
    denied('/tmp/tmux-1000');
    denied('/tmp/tmux-1000/default');
    denied('/tmp/.X11-unix');
    denied('/tmp/ssh-ABC123');
    denied('/var/snap/lxd/common/lxd/unix.socket');
    denied('/var/snap/lxd/common/lxd');
    denied('/var/lib/lxd');
    denied('/run/containerd/containerd.sock');
    denied('/srv/unix.socket');
    allowed('/tmp/my-models');
    allowed('/tmp/my-models', 'rw');
  });
});

describe('checkCustomPath rw-only rules', () => {
  it('rejects toolchains, shell configs, systemd/git, and system prefixes', () => {
    denied(`${HOME}/.local/bin`, 'rw');
    denied(`${HOME}/.nvm`, 'rw');
    denied(`${HOME}/.bashrc`, 'rw');
    denied(`${HOME}/.profile`, 'rw');
    denied(`${HOME}/.zshrc`, 'rw');
    denied(`${HOME}/.bash_profile`, 'rw');
    denied(`${HOME}/.config/systemd`, 'rw');
    denied(`${HOME}/.config/autostart`, 'rw');
    denied(`${HOME}/.config/git`, 'rw');
    denied(`${HOME}/.gitconfig`, 'rw');
    denied('/etc', 'rw');
    denied('/etc/hosts', 'rw');
    denied('/usr', 'rw');
    denied('/opt', 'rw');
    denied('/opt/models', 'rw');
    denied('/var/spool/cron', 'rw');
    denied('/opt/custom/bin', 'rw');
  });

  it('rejects $HOME dot-dirs as rw', () => {
    denied(`${HOME}/.cache/models`, 'rw');
    allowed(`${HOME}/Projects/models`, 'rw');
  });

  it('rejects remote rw outside node.json roots and allows inside', () => {
    denied('/srv/outside', 'rw', { roots: ['/work'] });
    allowed('/work/models', 'rw', { roots: ['/work'] });
  });

  it('rejects rw of a node root itself (must sit strictly inside)', () => {
    denied('/work', 'rw', { roots: ['/work'] });
  });

  it('rejects rw whose realpath is outside node.json roots', () => {
    denied('/work/models', 'rw', {
      roots: ['/work'],
      realpath: (p) => (p === '/work/models' ? '/srv/outside' : p),
    });
  });

  it('denies extraDeny node secret paths (config dir, key, storage)', () => {
    denied('/opt/tierwyn-node', 'ro', { extraDeny: ['/opt/tierwyn-node', '/opt/tierwyn-node/key'] });
    denied('/opt/tierwyn-node/key', 'ro', { extraDeny: ['/opt/tierwyn-node', '/opt/tierwyn-node/key'] });
    denied('/var/lib/tierwyn-node/artifacts', 'ro', { extraDeny: ['/var/lib/tierwyn-node/artifacts'] });
    allowed('/opt/other', 'ro', { extraDeny: ['/opt/tierwyn-node'] });
  });

  it('rejects rw ancestors of PATH, toolchains, and spool (M1 bidirectional)', () => {
    denied(`${HOME}/tools`, 'rw');
    denied(`${HOME}/go`, 'rw');
    denied('/var/spool', 'rw');
    denied('/var', 'rw');
    allowed('/var/log', 'rw');
    allowed(`${HOME}/Projects/models`, 'rw');
  });
});

describe('checkCustomPath realpath', () => {
  it('denies a symlink whose realpath lands in ~/.ssh', () => {
    const r = checkCustomPath(path('/tmp/link'), ctx({
      realpath: (p) => (p === '/tmp/link' ? `${HOME}/.ssh` : p),
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ssh|secret|denied|masked|alias/i);
  });

  it('denies a symlink whose realpath is the repo root (H1 unmask .env/data)', () => {
    const r = checkCustomPath(path('/tmp/repo-link'), ctx({
      realpath: (p) => (p === '/tmp/repo-link' ? REPO : p),
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTruthy();
  });

  it('denies an outside-repo path whose realpath is an ancestor of the repo (H1)', () => {
    denied('/tmp/projects-link', 'ro', {
      cwd: '/work/app',
      realpath: (p) => (p === '/tmp/projects-link' ? '/home/u/Projects' : p),
    });
    denied('/home/u/Projects', 'ro', { cwd: '/work/app' });
  });

  it('denies an outside-repo symlink whose realpath is <repo>/.env (H1 alias of repo tree)', () => {
    const r = checkCustomPath(path('/srv/env'), ctx({
      realpath: (p) => (p === '/srv/env' ? `${REPO}/.env` : p),
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('alias of repo tree');
  });

  it('still allows the canonical repo root as ro (masks apply at the same path)', () => {
    allowed(REPO, 'ro');
  });
});

describe('unionSandboxPaths (host ∪ project, ro wins)', () => {
  it('de-duplicates and lets ro win', () => {
    const out = unionSandboxPaths(
      [{ path: '/srv/models', mode: 'rw' }],
      [{ path: '/srv/models', mode: 'ro' }, { path: '/data/cache', mode: 'ro' }],
    );
    expect(out).toEqual([
      { path: '/srv/models', mode: 'ro', from: 'project', status: 'ok' },
      { path: '/data/cache', mode: 'ro', from: 'project', status: 'ok' },
    ]);
  });
});
