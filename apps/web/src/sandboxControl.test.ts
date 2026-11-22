import { describe, it, expect } from 'vitest';
import {
  sandboxControlState,
  sandboxOriginLabel,
  sandboxEffectiveLabel,
  projectSandboxInheritLabel,
  cellSetting,
  setCell,
  sandboxCellDisableReason,
  sandboxPathFromDraft,
  isFleetWideCell,
  SANDBOX_ALWAYS_BLOCKED,
  SANDBOX_FLEET_WIDE_CELL_LABEL,
  type SandboxControlInput,
} from './sandboxControl.js';
import type { SandboxDefaultRow } from '@tierwyn/shared';

const base: SandboxControlInput = {
  agentType: 'claude-code',
  conv: null,
  project: null,
  settings: { global: false, defaults: [] },
  hostId: 'hub',
  supportedAgents: ['claude-code', 'codex', 'opencode'],
  hubAvailable: true,
  remote: false,
};

describe('sandboxOriginLabel', () => {
  it('maps every source to the operator-facing origin', () => {
    expect(sandboxOriginLabel('conversation')).toBe('this chat');
    expect(sandboxOriginLabel('project')).toBe('project');
    expect(sandboxOriginLabel('agent')).toBe('agent default');
    expect(sandboxOriginLabel('host')).toBe('host default');
    expect(sandboxOriginLabel('host-agent')).toBe('host · agent default');
    expect(sandboxOriginLabel('global')).toBe('global');
    expect(sandboxOriginLabel('node')).toBe('forced by host');
    expect(sandboxOriginLabel('unavailable')).toBe("host can't sandbox");
  });
});

describe('sandboxEffectiveLabel', () => {
  it('formats on/off with the origin in parentheses', () => {
    expect(sandboxEffectiveLabel(true, 'conversation')).toBe('Sandbox: on (this chat)');
    expect(sandboxEffectiveLabel(false, 'conversation')).toBe('Sandbox: off (this chat)');
    expect(sandboxEffectiveLabel(true, 'unavailable')).toBe("Sandbox: on (host can't sandbox)");
    expect(sandboxEffectiveLabel(false, 'unavailable')).toBe("Sandbox: off (host can't sandbox)");
    expect(sandboxEffectiveLabel(true, 'node')).toBe('Sandbox: on (forced by host)');
  });
});

describe('projectSandboxInheritLabel', () => {
  it('names the global default and counts agent/host overrides', () => {
    expect(projectSandboxInheritLabel(false, 0)).toBe('Inherit (global: off)');
    expect(projectSandboxInheritLabel(true, 0)).toBe('Inherit (global: on)');
    expect(projectSandboxInheritLabel(false, 2)).toBe('Inherit (global: off · 2 agent/host overrides)');
    expect(projectSandboxInheritLabel(true, 1)).toBe('Inherit (global: on · 1 agent/host override)');
  });
});

describe('sandboxControlState', () => {
  it('resolves project override and inherit label', () => {
    const s = sandboxControlState({ ...base, conv: null, project: 'on' });
    expect(s).not.toBeNull();
    expect(s!.label).toBe('Sandbox: on (project)');
    expect(s!.on).toBe(true);
    expect(s!.inheritLabel).toBe('Inherit (project: on)');
    expect(s!.warning).toBe(false);
  });

  it('resolves conversation override as this chat', () => {
    const s = sandboxControlState({
      ...base,
      conv: 'off',
      project: 'on',
      settings: { global: true, defaults: [] },
    });
    expect(s!.label).toBe('Sandbox: off (this chat)');
  });

  it('resolves global when conv and project inherit', () => {
    const s = sandboxControlState({
      ...base,
      conv: null,
      project: null,
      settings: { global: true, defaults: [] },
    });
    expect(s!.label).toBe('Sandbox: on (global)');
  });

  it('resolves agent-wide default', () => {
    const s = sandboxControlState({
      ...base,
      settings: {
        global: false,
        defaults: [{ hostId: '*', agentType: 'claude-code', setting: 'on' }],
      },
    });
    expect(s!.label).toBe('Sandbox: on (agent default)');
    expect(s!.inheritLabel).toBe('Inherit (agent default: on)');
  });

  it('resolves host-wide default', () => {
    const s = sandboxControlState({
      ...base,
      hostId: 'hub',
      settings: {
        global: false,
        defaults: [{ hostId: 'hub', agentType: '*', setting: 'off' }],
      },
    });
    expect(s!.label).toBe('Sandbox: off (host default)');
  });

  it('resolves exact host × agent default over wildcards', () => {
    const s = sandboxControlState({
      ...base,
      hostId: 'vm-909',
      remote: true,
      hostHello: { features: ['sandbox'], sandbox: { policy: 'allow', available: true } },
      settings: {
        global: false,
        defaults: [
          { hostId: '*', agentType: 'claude-code', setting: 'off' },
          { hostId: 'vm-909', agentType: '*', setting: 'off' },
          { hostId: 'vm-909', agentType: 'claude-code', setting: 'on' },
        ],
      },
    });
    expect(s!.label).toBe('Sandbox: on (host · agent default)');
  });

  it('locks on when remote host policy is require', () => {
    const s = sandboxControlState({
      ...base,
      remote: true,
      hostId: 'vm-909',
      conv: 'off',
      hostHello: { features: ['sandbox'], sandbox: { policy: 'require', available: true } },
    });
    expect(s!.label).toBe('Sandbox: on (forced by host)');
    expect(s!.locked).toBe(true);
    expect(s!.warning).toBe(false);
  });

  it('soft-falls back with a warning when inherited on and hub cannot sandbox', () => {
    const s = sandboxControlState({
      ...base,
      hubAvailable: false,
      settings: { global: true, defaults: [] },
    });
    expect(s!.label).toBe("Sandbox: off (host can't sandbox)");
    expect(s!.on).toBe(false);
    expect(s!.warning).toBe(true);
    expect(s!.locked).toBe(false);
  });

  it('disables On when hub bwrap is unavailable', () => {
    const s = sandboxControlState({ ...base, hubAvailable: false });
    expect(s!.onDisabledReason).toMatch(/unavailable on the hub/);
    expect(s!.locked).toBe(false);
  });

  it('disables On when remote host reports bwrap unavailable', () => {
    const s = sandboxControlState({
      ...base,
      remote: true,
      hostId: 'vm-909',
      hostHello: { features: ['sandbox'], sandbox: { policy: 'allow', available: false } },
    });
    expect(s!.onDisabledReason).toMatch(/unavailable on this host/);
  });

  it('disables On when remote hello lacks sandbox feature', () => {
    const s = sandboxControlState({
      ...base,
      remote: true,
      hostId: 'vm-909',
      hostHello: { features: [] },
    });
    expect(s!.onDisabledReason).toMatch(/tierwyn node update/);
  });

  it('disables On when remote policy is off', () => {
    const s = sandboxControlState({
      ...base,
      remote: true,
      hostId: 'vm-909',
      hostHello: { features: ['sandbox'], sandbox: { policy: 'off', available: true } },
    });
    expect(s!.onDisabledReason).toMatch(/disabled on this host/);
  });

  it('disables On when agent has no sandbox profile', () => {
    const s = sandboxControlState({ ...base, agentType: 'copilot' });
    expect(s!.onDisabledReason).toBe('This agent has no sandbox profile');
  });

  it('does not disable On while hub availability is unknown', () => {
    const s = sandboxControlState({ ...base, hubAvailable: undefined });
    expect(s!.onDisabledReason).toBeNull();
    expect(s!.warning).toBe(false);
  });

  it('returns null for grok-bot and missing agent', () => {
    expect(sandboxControlState({ ...base, agentType: 'grok-bot' })).toBeNull();
    expect(sandboxControlState({ ...base, agentType: undefined })).toBeNull();
  });
});

describe('defaults matrix helpers', () => {
  const rows: SandboxDefaultRow[] = [
    { hostId: '*', agentType: 'opencode', setting: 'on' },
    { hostId: 'hub', agentType: '*', setting: 'off' },
  ];

  it('reads inherit when no exact cell exists', () => {
    expect(cellSetting(rows, 'hub', 'claude-code')).toBe('inherit');
    expect(cellSetting(rows, '*', 'opencode')).toBe('on');
    expect(cellSetting(rows, 'hub', '*')).toBe('off');
  });

  it('upserts On/Off and removes on Inherit', () => {
    const on = setCell(rows, 'hub', 'claude-code', 'on');
    expect(cellSetting(on, 'hub', 'claude-code')).toBe('on');
    expect(cellSetting(on, '*', 'opencode')).toBe('on');
    const cleared = setCell(on, '*', 'opencode', 'inherit');
    expect(cellSetting(cleared, '*', 'opencode')).toBe('inherit');
    expect(cleared).toHaveLength(2);
  });

  it('does not store Any host × Any agent; that cell is the global default', () => {
    expect(isFleetWideCell('*', '*')).toBe(true);
    expect(isFleetWideCell('*', 'opencode')).toBe(false);
    expect(isFleetWideCell('hub', '*')).toBe(false);
    expect(SANDBOX_FLEET_WIDE_CELL_LABEL).toBe('= Global default');
    const added = setCell(rows, '*', '*', 'on');
    expect(added).toEqual(rows);
    expect(cellSetting(added, '*', '*')).toBe('inherit');
    const leftover = setCell(
      [...rows, { hostId: '*', agentType: '*', setting: 'off' }],
      '*',
      '*',
      'off',
    );
    expect(leftover.find((r) => r.hostId === '*' && r.agentType === '*')).toBeUndefined();
  });

  it('greys a cell when the agent has no profile', () => {
    expect(sandboxCellDisableReason({
      hostId: '*',
      agentType: 'copilot',
      supportedAgents: ['claude-code'],
      hubAvailable: true,
      hosts: [],
    })).toBe('Agent lacks sandbox profile');
  });

  it('greys a hub cell when bwrap is missing', () => {
    expect(sandboxCellDisableReason({
      hostId: 'hub',
      agentType: 'claude-code',
      supportedAgents: ['claude-code'],
      hubAvailable: false,
      hosts: [],
    })).toBe('Host lacks bwrap');
  });

  it('greys a remote cell when the host cannot sandbox', () => {
    expect(sandboxCellDisableReason({
      hostId: 'vm-909',
      agentType: '*',
      supportedAgents: ['claude-code'],
      hubAvailable: true,
      hosts: [{ id: 'vm-909', hello: { features: [], sandbox: { policy: 'allow', available: false } } }],
    })).toBe('Host lacks bwrap');
  });

  it('leaves Any-host × capable-agent enabled', () => {
    expect(sandboxCellDisableReason({
      hostId: '*',
      agentType: 'claude-code',
      supportedAgents: ['claude-code'],
      hubAvailable: false,
      hosts: [],
    })).toBeNull();
  });
});

describe('sandboxPathFromDraft', () => {
  it('accepts an absolute path with ro/rw', () => {
    expect(sandboxPathFromDraft('/srv/models', 'ro')).toEqual({ path: '/srv/models', mode: 'ro' });
    expect(sandboxPathFromDraft(' /opt/tools ', 'rw')).toEqual({ path: '/opt/tools', mode: 'rw' });
  });

  it('rejects relative, empty, and traversal paths', () => {
    expect(sandboxPathFromDraft('srv/models', 'ro')).toBeNull();
    expect(sandboxPathFromDraft('', 'ro')).toBeNull();
    expect(sandboxPathFromDraft('/tmp/../etc', 'ro')).toBeNull();
  });
});

describe('SANDBOX_ALWAYS_BLOCKED', () => {
  it('lists the operator-facing never-mountable paths', () => {
    expect(SANDBOX_ALWAYS_BLOCKED).toEqual([
      '/',
      '$HOME and ancestors',
      'cwd ancestors up to $HOME',
      '~/.ssh',
      '~/.gnupg',
      '~/.git-credentials',
      '~/.config/tierwyn',
      '/etc/tierwyn',
      'hub data/',
      '/etc/shadow',
      '/etc/gshadow',
      '/etc/sudoers*',
      '/proc',
      '/sys',
      '/dev',
      '/run',
      '/var/run',
      '/run/user/<uid>',
      'docker.sock',
      'podman.sock',
      'unix.socket / containerd.sock',
      '/var/lib/docker',
      '/tmp, /var/tmp, /dev/shm',
      '/tmp/tmux-* /tmp/.X11-unix /tmp/ssh-*',
      'lxd unix.socket',
      "other agents' profile dirs",
      'Tierwyn repo root as rw',
      '.env*',
      '~/.local/bin and toolchains (rw)',
      '~/.bashrc / .profile / .zshrc / .bash_profile (rw)',
      '~/.config/systemd, autostart, git (rw)',
      '~/.gitconfig (rw)',
      '/etc /usr /opt /var/spool/cron (rw)',
      'any PATH entry (rw)',
      "$HOME's dot-dirs (rw)",
      'outside node.json roots (rw, remote)',
    ]);
  });
});
