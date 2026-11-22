import { describe, it, expect } from 'vitest';
import {
  isSandboxSetting,
  isSandboxPath,
  lookupSandboxDefault,
  resolveSandbox,
  isAgentSandboxCapable,
  unionSandboxPaths,
  monotonicChildSandbox,
  type SandboxDefaultRow,
  type SandboxResolveInput,
} from './sandbox.js';

const rows = (...r: SandboxDefaultRow[]) => r;

function input(partial: Partial<SandboxResolveInput> & Pick<SandboxResolveInput, 'hostId' | 'agentType'>): SandboxResolveInput {
  return {
    ...partial,
    settings: partial.settings ?? { global: false, defaults: [] },
  };
}

describe('isSandboxSetting', () => {
  it('rejects bogus values', () => {
    expect(isSandboxSetting('bogus')).toBe(false);
    expect(isSandboxSetting('on')).toBe(true);
    expect(isSandboxSetting('off')).toBe(true);
  });
});

describe('isSandboxPath', () => {
  it('accepts an absolute path with ro or rw', () => {
    expect(isSandboxPath({ path: '/opt/models', mode: 'ro' })).toBe(true);
    expect(isSandboxPath({ path: '/data/cache', mode: 'rw' })).toBe(true);
  });

  it('rejects a relative path', () => {
    expect(isSandboxPath({ path: 'opt/models', mode: 'ro' })).toBe(false);
  });

  it('rejects .. segments', () => {
    expect(isSandboxPath({ path: '/opt/../etc', mode: 'ro' })).toBe(false);
    expect(isSandboxPath({ path: '/../etc', mode: 'rw' })).toBe(false);
  });

  it('rejects NUL and newline bytes', () => {
    expect(isSandboxPath({ path: '/opt/mod\0els', mode: 'ro' })).toBe(false);
    expect(isSandboxPath({ path: '/opt/mod\nels', mode: 'ro' })).toBe(false);
    expect(isSandboxPath({ path: '/opt/mod\rels', mode: 'rw' })).toBe(false);
  });

  it('rejects paths longer than 512 and invalid mode', () => {
    expect(isSandboxPath({ path: `/${'a'.repeat(512)}`, mode: 'ro' })).toBe(false);
    expect(isSandboxPath({ path: '/opt/models', mode: 'xx' })).toBe(false);
  });
});

describe('lookupSandboxDefault (Q1: exact → agent-wide → host-wide)', () => {
  const table: SandboxDefaultRow[] = rows(
    { hostId: 'h1', agentType: 'opencode', setting: 'on' },
    { hostId: '*', agentType: 'opencode', setting: 'off' },
    { hostId: 'h1', agentType: '*', setting: 'off' },
    { hostId: '*', agentType: '*', setting: 'on' },
  );

  it('exact (host, agent) wins over wildcards', () => {
    expect(lookupSandboxDefault(table, 'h1', 'opencode')).toEqual({ setting: 'on', source: 'host-agent' });
  });

  it('agent-wide (*, agent) beats host-wide (host, *)', () => {
    expect(lookupSandboxDefault(table, 'h2', 'opencode')).toEqual({ setting: 'off', source: 'agent' });
  });

  it('host-wide (host, *) when no agent-wide row', () => {
    expect(lookupSandboxDefault(table, 'h1', 'claude-code')).toEqual({ setting: 'off', source: 'host' });
  });

  it('ignores (*, *) — global is the catch-all', () => {
    expect(lookupSandboxDefault(table, 'h9', 'claude-code')).toBeNull();
  });

  it('returns null on empty rows', () => {
    expect(lookupSandboxDefault([], 'hub', 'claude-code')).toBeNull();
  });
});

describe('resolveSandbox tiers', () => {
  it('conversation overrides project, defaults, and global', () => {
    expect(resolveSandbox(input({
      conv: 'off',
      project: 'on',
      hostId: 'hub',
      agentType: 'claude-code',
      settings: { global: true, defaults: [{ hostId: '*', agentType: 'claude-code', setting: 'on' }] },
    }))).toMatchObject({ on: false, source: 'conversation', wanted: false });
  });

  it('project when conversation unset', () => {
    expect(resolveSandbox(input({
      conv: null,
      project: 'on',
      hostId: 'hub',
      agentType: 'claude-code',
      settings: { global: false, defaults: [] },
    }))).toMatchObject({ on: true, source: 'project', wanted: true });
  });

  it('host-agent default when conv and project unset', () => {
    expect(resolveSandbox(input({
      hostId: 'h1',
      agentType: 'opencode',
      settings: {
        global: false,
        defaults: [{ hostId: 'h1', agentType: 'opencode', setting: 'on' }],
      },
    }))).toMatchObject({ on: true, source: 'host-agent', wanted: true });
  });

  it('agent-wide default when no exact pair', () => {
    expect(resolveSandbox(input({
      hostId: 'h1',
      agentType: 'opencode',
      settings: {
        global: false,
        defaults: [{ hostId: '*', agentType: 'opencode', setting: 'on' }],
      },
    }))).toMatchObject({ on: true, source: 'agent', wanted: true });
  });

  it('host-wide default when no agent-wide row', () => {
    expect(resolveSandbox(input({
      hostId: 'h1',
      agentType: 'claude-code',
      settings: {
        global: true,
        defaults: [{ hostId: 'h1', agentType: '*', setting: 'off' }],
      },
    }))).toMatchObject({ on: false, source: 'host', wanted: false });
  });

  it('global when both unset and no default rows', () => {
    expect(resolveSandbox(input({
      conv: undefined,
      project: null,
      hostId: 'hub',
      agentType: 'claude-code',
      settings: { global: true, defaults: [] },
    }))).toMatchObject({ on: true, source: 'global', wanted: true });
  });
});

describe('resolveSandbox node floor (Q2)', () => {
  it('forced require → source node, on true, wanted preserves 4-tier', () => {
    expect(resolveSandbox(input({
      conv: 'off',
      hostId: 'h1',
      agentType: 'claude-code',
      settings: { global: false, defaults: [] },
      capable: { ok: true, forced: true },
    }))).toEqual({ on: true, source: 'node', wanted: false });
  });

  it('inherited on + incapable → soft off (unavailable)', () => {
    expect(resolveSandbox(input({
      hostId: 'h1',
      agentType: 'opencode',
      settings: { global: true, defaults: [] },
      capable: { ok: false, reason: 'bubblewrap unavailable on host' },
    }))).toEqual({
      on: false,
      source: 'unavailable',
      reason: 'bubblewrap unavailable on host',
      wanted: true,
    });
  });

  it('explicit conversation on + incapable → still on (hard fail downstream)', () => {
    expect(resolveSandbox(input({
      conv: 'on',
      hostId: 'hub',
      agentType: 'claude-code',
      settings: { global: false, defaults: [] },
      capable: { ok: false, reason: 'bubblewrap unavailable on hub' },
    }))).toMatchObject({ on: true, source: 'conversation', wanted: true });
  });

  it('explicit project on + incapable → still on', () => {
    expect(resolveSandbox(input({
      project: 'on',
      hostId: 'hub',
      agentType: 'claude-code',
      settings: { global: false, defaults: [] },
      capable: { ok: false, reason: 'no sandbox profile' },
    }))).toMatchObject({ on: true, source: 'project', wanted: true });
  });

  it('unknown capable (null) does not soft-fallback', () => {
    expect(resolveSandbox(input({
      hostId: 'h1',
      agentType: 'claude-code',
      settings: { global: true, defaults: [] },
      capable: null,
    }))).toMatchObject({ on: true, source: 'global', wanted: true });
  });

  it('grok-bot is never sandboxed', () => {
    expect(resolveSandbox(input({
      conv: 'on',
      hostId: 'hub',
      agentType: 'grok-bot',
      settings: { global: true, defaults: [] },
    }))).toEqual({
      on: false,
      source: 'unavailable',
      reason: 'never sandboxed',
      wanted: false,
    });
  });
});

describe('isAgentSandboxCapable', () => {
  it('hub: profile + bwrap → ok', () => {
    expect(isAgentSandboxCapable('claude-code', { hasProfile: true, available: true, remote: false }))
      .toEqual({ ok: true });
  });

  it('hub: no bwrap → not ok', () => {
    expect(isAgentSandboxCapable('claude-code', { hasProfile: true, available: false, remote: false }))
      .toMatchObject({ ok: false });
  });

  it('hub: unknown availability → null', () => {
    expect(isAgentSandboxCapable('claude-code', { hasProfile: true, remote: false })).toBeNull();
  });

  it('no profile → not ok', () => {
    expect(isAgentSandboxCapable('copilot', { hasProfile: false, available: true, remote: false }))
      .toMatchObject({ ok: false });
  });

  it('remote require → forced', () => {
    expect(isAgentSandboxCapable('claude-code', {
      hasProfile: true,
      available: true,
      remote: true,
      features: ['sandbox'],
      policy: 'require',
    })).toEqual({ ok: true, forced: true });
  });

  it('remote policy off → not ok', () => {
    expect(isAgentSandboxCapable('claude-code', {
      hasProfile: true,
      available: true,
      remote: true,
      features: ['sandbox'],
      policy: 'off',
    })).toMatchObject({ ok: false });
  });

  it('remote missing sandbox feature → not ok', () => {
    expect(isAgentSandboxCapable('claude-code', {
      hasProfile: true,
      available: true,
      remote: true,
      features: [],
      policy: 'allow',
    })).toMatchObject({ ok: false });
  });

  it('remote unknown hello (no features) → null', () => {
    expect(isAgentSandboxCapable('claude-code', {
      hasProfile: true,
      remote: true,
    })).toBeNull();
  });
});

describe('monotonicChildSandbox (Q3)', () => {
  it('parent effectively on → child written on', () => {
    expect(monotonicChildSandbox({ on: true })).toBe('on');
  });

  it('parent effectively off → child null (inherits)', () => {
    expect(monotonicChildSandbox({ on: false })).toBeNull();
  });
});

describe('unionSandboxPaths (host ∪ project, ro wins)', () => {
  it('unions and de-duplicates, ro beating rw', () => {
    const out = unionSandboxPaths(
      [{ path: '/opt/models', mode: 'rw' }],
      [{ path: '/opt/models', mode: 'ro' }, { path: '/data/cache', mode: 'ro' }],
    );
    expect(out).toEqual([
      { path: '/opt/models', mode: 'ro', from: 'project', status: 'ok' },
      { path: '/data/cache', mode: 'ro', from: 'project', status: 'ok' },
    ]);
  });

  it('keeps rw when both say rw', () => {
    const out = unionSandboxPaths(
      [{ path: '/opt/models', mode: 'rw' }],
      [{ path: '/opt/models', mode: 'rw' }],
    );
    expect(out).toEqual([{ path: '/opt/models', mode: 'rw', from: 'project', status: 'ok' }]);
  });
});
