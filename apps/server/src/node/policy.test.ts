import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { applyNodeSandboxPolicy, defaultNodeRoot, loadNodeConfig, nodeConfigDir, pathUnderRoots, writeNodeConfigFile } from './policy.js';
import { RpcError } from './rpc.js';

const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('pathUnderRoots', () => {
  it('accepts root and child', () => {
    const root = tmp('rh-root-');
    const child = join(root, 'child');
    mkdirSync(child);
    expect(pathUnderRoots(root, [root])).toBe(realpathSync(root));
    expect(pathUnderRoots(child, [root])).toBe(realpathSync(child));
  });

  it('rejects sibling prefix /tmp/rootX for root /tmp/root', () => {
    const parent = tmp('rh-parent-');
    const root = join(parent, 'root');
    const sibling = join(parent, 'rootX');
    mkdirSync(root);
    mkdirSync(sibling);
    expect(pathUnderRoots(sibling, [root])).toBeNull();
  });

  it('rejects symlink inside root pointing outside', () => {
    const root = tmp('rh-sym-root-');
    const outside = tmp('rh-sym-out-');
    const target = join(outside, 'secret');
    writeFileSync(target, 'x');
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(pathUnderRoots(link, [root])).toBeNull();
  });

  it('rejects nonexistent path', () => {
    const root = tmp('rh-miss-');
    expect(pathUnderRoots(join(root, 'nope'), [root])).toBeNull();
  });

  // P2-7 regression: `relative()` prefixes outside-root results with '..',
  // but a directory legitimately named '..foo' inside the root does too.
  // Only the '..' + separator form means escape.
  it('accepts a child named ..foo and still rejects a real traversal', () => {
    const root = tmp('rh-dotdot-');
    const outside = join(root, '..', 'rh-dotdot-esc');
    const dotdot = join(root, '..foo');
    const nested = join(dotdot, 'file.md');
    dirs.push(outside);
    mkdirSync(outside, { recursive: true });
    mkdirSync(dotdot);
    writeFileSync(nested, 'x');
    expect(pathUnderRoots(dotdot, [root])).toBe(realpathSync(dotdot));
    expect(pathUnderRoots(nested, [root])).toBe(realpathSync(nested));
    expect(pathUnderRoots(outside, [root])).toBeNull();
  });
});

describe('nodeConfigDir / defaultNodeRoot', () => {
  it('uses TIERWYN_NODE_DIR when set', () => {
    expect(nodeConfigDir({ TIERWYN_NODE_DIR: '/n/t' })).toBe('/n/t');
  });

  it('defaults to ~/.config/tierwyn/node', () => {
    expect(nodeConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/tierwyn/node');
  });

  it('defaultNodeRoot is ~/tierwyn', () => {
    expect(defaultNodeRoot('/h')).toBe('/h/tierwyn');
  });
});

describe('loadNodeConfig', () => {
  function writeCfg(dir: string, cfg: Record<string, unknown>): string {
    const d = tmp(dir);
    writeFileSync(join(d, 'node.json'), JSON.stringify(cfg));
    return d;
  }

  it('artifactsMaxAgeDays defaults to 90', () => {
    const d = writeCfg('rh-cfg-def-', {});
    expect(loadNodeConfig(d).artifactsMaxAgeDays).toBe(90);
  });

  it('artifactsMaxAgeDays 0 disables the sweep', () => {
    const d = writeCfg('rh-cfg-zero-', { artifactsMaxAgeDays: 0 });
    expect(loadNodeConfig(d).artifactsMaxAgeDays).toBe(0);
  });

  it('allowSelfUpdate defaults to true', () => {
    const d = writeCfg('rh-cfg-upd-', {});
    expect(loadNodeConfig(d).allowSelfUpdate).toBe(true);
  });

  it('allowSelfUpdate false is honoured', () => {
    const d = writeCfg('rh-cfg-upd-off-', { allowSelfUpdate: false });
    expect(loadNodeConfig(d).allowSelfUpdate).toBe(false);
  });

  it('sandbox defaults to allow', () => {
    const d = writeCfg('rh-cfg-sb-def-', {});
    expect(loadNodeConfig(d).sandbox).toBe('allow');
  });

  it('sandbox typo throws', () => {
    const d = writeCfg('rh-cfg-sb-bad-', { sandbox: 'requre' });
    expect(() => loadNodeConfig(d)).toThrow(/sandbox must be off\|allow\|require/);
  });

  it('sandboxPaths.allow defaults to ro', () => {
    const d = writeCfg('rh-cfg-sp-def-', {});
    expect(loadNodeConfig(d).sandboxPaths).toEqual({ allow: 'ro' });
  });

  it('sandboxPaths.allow parses none, ro, rw', () => {
    expect(loadNodeConfig(writeCfg('rh-cfg-sp-none-', { sandboxPaths: { allow: 'none' } })).sandboxPaths).toEqual({ allow: 'none' });
    expect(loadNodeConfig(writeCfg('rh-cfg-sp-ro-', { sandboxPaths: { allow: 'ro' } })).sandboxPaths).toEqual({ allow: 'ro' });
    expect(loadNodeConfig(writeCfg('rh-cfg-sp-rw-', { sandboxPaths: { allow: 'rw' } })).sandboxPaths).toEqual({ allow: 'rw' });
  });

  it('sandboxPaths.allow typo throws', () => {
    const d = writeCfg('rh-cfg-sp-bad-', { sandboxPaths: { allow: 'read' } });
    expect(() => loadNodeConfig(d)).toThrow(/sandboxPaths\.allow must be none\|ro\|rw/);
  });
});

describe('applyNodeSandboxPolicy', () => {
  it('honours want, policy, and availability', () => {
    expect(applyNodeSandboxPolicy(false, 'allow', true)).toBe(false);
    expect(applyNodeSandboxPolicy(false, 'allow', false)).toBe(false);
    expect(applyNodeSandboxPolicy(true, 'allow', true)).toBe(true);
    expect(applyNodeSandboxPolicy(true, 'require', true)).toBe(true);
    expect(applyNodeSandboxPolicy(false, 'require', true)).toBe(true);
    expect(() => applyNodeSandboxPolicy(true, 'off', true)).toThrow(RpcError);
    expect(() => applyNodeSandboxPolicy(true, 'allow', false)).toThrow(RpcError);
  });
});

describe('writeNodeConfigFile', () => {
  it('writes 0600 json with trailing newline, replacing a 0644 file, no tmp left', () => {
    const dir = tmp('rh-w-');
    const p = join(dir, 'node.json');
    writeFileSync(p, '{}', { mode: 0o644 });
    chmodSync(p, 0o644);
    writeNodeConfigFile(dir, { a: 1 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2) + '\n');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('throws for a missing dir and creates nothing', () => {
    const dir = join(tmp('rh-w-'), 'nope');
    expect(() => writeNodeConfigFile(dir, {})).toThrow();
    expect(existsSync(dir)).toBe(false);
  });
  it('rename failure throws, keeps target, leaves no tmp', () => {
    const dir = tmp('rh-w-');
    mkdirSync(join(dir, 'node.json'));
    expect(() => writeNodeConfigFile(dir, {})).toThrow();
    expect(statSync(join(dir, 'node.json')).isDirectory()).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
