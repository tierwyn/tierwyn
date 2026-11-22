import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/install.sh');

// Just the channel helpers (sourcing the whole installer would dispatch a command).
function channelFns(): string {
  const src = readFileSync(INSTALL_SH, 'utf8');
  const a = src.indexOf('# ── release channels');
  const b = src.indexOf('# ── bootstrap');
  if (a < 0 || b < a) throw new Error('channel block markers missing from install.sh');
  return src.slice(a, b);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** Commit on main; `channelAware` = this commit's install.sh knows git_sync. */
function commit(d: string, n: string, channelAware = true, tag?: string) {
  mkdirSync(join(d, 'scripts'), { recursive: true });
  writeFileSync(join(d, 'scripts/install.sh'), channelAware ? 'git_sync() { :; }\n' : '# old\n');
  writeFileSync(join(d, 'f'), n);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', `c${n}`);
  if (tag) git(d, 'tag', tag);
}

/** origin: c1 (v0.1.0) → c2 (v0.2.0) → c3 (v0.3.0-rc1) = main. */
function origin(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-chan-origin-'));
  dirs.push(d);
  git(d, 'init', '-q', '-b', 'main');
  commit(d, '1', true, 'v0.1.0');
  commit(d, '2', true, 'v0.2.0');
  commit(d, '3', true, 'v0.3.0-rc1');
  return d;
}

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'tw-chan-home-'));
  dirs.push(h);
  return h;
}

function sync(repo: string, home: string, channel?: string, fresh = '') {
  const script = `set -euo pipefail\nok(){ echo "OK $*"; }\nwarn(){ echo "WARN $*"; }\nCFG="$HOME/.config/tierwyn"\n${channelFns()}\ngit_sync "$1" $2\n`;
  return spawnSync('bash', ['-c', script, 'bash', repo, fresh], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, ...(channel ? { TIERWYN_CHANNEL: channel } : {}) },
  });
}

describe('installer release channels', () => {
  it('stable lands on the newest final tag, edge on main, and stable never downgrades', () => {
    const o = origin();
    const home = mkdtempSync(join(tmpdir(), 'tw-chan-home-'));
    dirs.push(home);
    const clone = join(home, 'tierwyn');
    // pre-channel installs were shallow clones of main
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${o}`, clone]);
    git(clone, 'reset', '-q', '--hard', 'HEAD'); // shallow at c3

    // default channel (no env, no file) = stable; HEAD c3 is ahead of v0.2.0 → stays put
    let r = sync(clone, home);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ahead of v0.2.0');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(o, 'rev-parse', 'main'));

    // a stable install sitting on an older tag moves forward to v0.2.0 (rc ignored)
    git(clone, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'v0.1.0');
    r = sync(clone, home);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('stable: v0.2.0');
    expect(git(clone, 'describe', '--tags', '--exact-match')).toBe('v0.2.0');

    // edge: detached tag → back onto main tip
    r = sync(clone, home, 'edge');
    expect(r.status, r.stderr).toBe(0);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(o, 'rev-parse', 'main'));

    // a newer release that includes HEAD → stable follows it
    commit(o, '4', true, 'v0.3.0');
    r = sync(clone, home);
    expect(r.status, r.stderr).toBe(0);
    expect(git(clone, 'describe', '--tags', '--exact-match')).toBe('v0.3.0');
  });

  it('stable skips a newest tag whose install.sh predates channels', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-chan-origin-'));
    dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    commit(d, '1', false, 'v0.1.1');
    commit(d, '2', true);
    const h = home(), clone = join(h, 'tierwyn');
    execFileSync('git', ['clone', '-q', `file://${d}`, clone]);
    const r = sync(clone, h);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('no channel-aware release');
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('stable with no tags at all does not abort under set -e', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-chan-origin-'));
    dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    commit(d, '1');
    const h = home(), clone = join(h, 'tierwyn');
    execFileSync('git', ['clone', '-q', `file://${d}`, clone]);
    const r = sync(clone, h);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('staying on');
  });

  it('stable on main exactly at the newest tag keeps the branch', () => {
    const o = origin();
    commit(o, '4', true, 'v0.3.0');
    const h = home(), clone = join(h, 'tierwyn');
    execFileSync('git', ['clone', '-q', `file://${o}`, clone]);
    const r = sync(clone, h);
    expect(r.status, r.stderr).toBe(0);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('edge from a tag never falls back to a stale local main when origin is unreachable', () => {
    const o = origin();
    const h = home(), clone = join(h, 'tierwyn');
    execFileSync('git', ['clone', '-q', `file://${o}`, clone]);
    git(clone, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'v0.2.0');
    git(clone, 'branch', '-q', '-f', 'main', 'v0.1.0'); // stale local main
    git(clone, 'remote', 'set-url', 'origin', join(h, 'gone'));
    const before = git(clone, 'rev-parse', 'HEAD');
    const r = sync(clone, h, 'edge');
    expect(r.status).not.toBe(0);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('edge from a tag with a stale local main lands on origin/main', () => {
    const o = origin();
    const h = home(), clone = join(h, 'tierwyn');
    execFileSync('git', ['clone', '-q', `file://${o}`, clone]);
    git(clone, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'v0.2.0');
    git(clone, 'branch', '-q', '-f', 'main', 'v0.1.0');
    const r = sync(clone, h, 'edge');
    expect(r.status, r.stderr).toBe(0);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(o, 'rev-parse', 'main'));
  });

  it('a fresh stable clone of a main that is ahead lands on the newest tag', () => {
    const o = origin(); // main = c3, ahead of v0.2.0
    const h = home(), clone = join(h, 'tierwyn');
    execFileSync('git', ['clone', '-q', `file://${o}`, clone]);
    const r = sync(clone, h, undefined, 'fresh');
    expect(r.status, r.stderr).toBe(0);
    expect(git(clone, 'describe', '--tags', '--exact-match')).toBe('v0.2.0');
  });
});
