import { describe, expect, it } from 'vitest';
import type { AgentProfile, Conversation, GrokBotLifecycleStatus, Project } from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import {
  applyGrokBotStatus, filterGrokBotProject, grokBotEnabledFromProfiles, isGrokBotChat,
  namesEnabledNonGrok, statusBanner,
} from './grokBotStatus.js';

const CID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: CID,
    projectId: 'proj-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'claude-code:sonnet',
    agentType: 'claude-code',
    model: 'sonnet',
    label: 'Sonnet',
    description: '',
    vision: false,
    steer: true,
    enabled: true,
    ...over,
  };
}

function status(state: GrokBotLifecycleStatus['state'], over: Partial<GrokBotLifecycleStatus> = {}): GrokBotLifecycleStatus {
  return {
    state,
    enabled: true,
    autoStart: 'keep-running',
    envLocks: { autostart: false, watch: false },
    launcher: null,
    attribution: null,
    layout: 'native',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    lastErrorAt: null,
    since: 1,
    ...over,
  };
}

describe('isGrokBotChat', () => {
  it('is true for a Remote Agents container conversation', () => {
    expect(isGrokBotChat(conv({ projectId: REMOTE_AGENTS_PROJECT_ID }), profile())).toBe(true);
  });

  it('is true for a grok-bot profile in a normal project', () => {
    expect(isGrokBotChat(conv(), profile({ agentType: 'grok-bot', id: 'grok-bot:default', model: 'default' }))).toBe(true);
  });

  it('is true for an ad-hoc grok chat even when the picker fell back to another agent', () => {
    expect(isGrokBotChat(conv(), profile(), { lastSessionProfileId: 'grok-bot:default' })).toBe(true);
    expect(isGrokBotChat(conv(), profile(), { selectedProfileId: 'grok-bot:default' })).toBe(true);
  });

  it('is false when an explicit enabled non-grok profile is selected', () => {
    const claude = profile();
    expect(isGrokBotChat(
      conv(),
      claude,
      { lastSessionProfileId: 'grok-bot:default', selectedProfileId: 'claude-code:sonnet' },
      [claude],
    )).toBe(false);
  });

  it('S2: resolved profiles[0] unlocks even when identity still holds a grok seed', () => {
    const claude = profile();
    expect(isGrokBotChat(
      conv(),
      claude,
      { lastSessionProfileId: 'grok-bot:default', selectedProfileId: 'grok-bot:default' },
      [claude],
    )).toBe(false);
  });

  it('S2: unloaded / empty profiles stay locked', () => {
    expect(isGrokBotChat(
      conv(),
      undefined,
      { lastSessionProfileId: 'grok-bot:default' },
    )).toBe(true);
    expect(isGrokBotChat(
      conv(),
      undefined,
      { lastSessionProfileId: 'grok-bot:default', selectedProfileId: 'grok-bot:default' },
      [],
    )).toBe(true);
  });

  it('S2: disabled/unknown resolved id stays locked', () => {
    expect(isGrokBotChat(
      conv(),
      undefined,
      { lastSessionProfileId: 'grok-bot:default', selectedProfileId: 'cursor:opus' },
      [profile()],
    )).toBe(true);
  });

  it('stays true when the named non-grok agent is not in the enabled profile list', () => {
    expect(isGrokBotChat(
      conv(),
      undefined,
      { lastSessionProfileId: 'grok-bot:default', selectedProfileId: 'cursor:opus' },
      [profile()],
    )).toBe(true);
  });

  it('Remote Agents stays a grok chat even with an explicit non-grok selection', () => {
    expect(isGrokBotChat(
      conv({ projectId: REMOTE_AGENTS_PROJECT_ID }),
      profile(),
      { lastSessionProfileId: 'grok-bot:default', selectedProfileId: 'claude-code:sonnet' },
      [profile()],
    )).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isGrokBotChat(conv(), profile())).toBe(false);
    expect(isGrokBotChat(null, profile({ agentType: 'grok-bot' }))).toBe(false);
  });
});

describe('namesEnabledNonGrok', () => {
  it('mirrors the server: grok ids are never a switch, unknown agents are not enabled', () => {
    const claude = profile();
    expect(namesEnabledNonGrok([claude], 'grok-bot:default', 'grok-bot')).toBe(false);
    expect(namesEnabledNonGrok([claude], 'claude-code:sonnet', 'claude-code')).toBe(true);
    expect(namesEnabledNonGrok([claude], 'cursor:opus', 'cursor')).toBe(false);
    expect(namesEnabledNonGrok([claude], undefined, undefined)).toBe(false);
    expect(namesEnabledNonGrok([claude], 'claude-code:sonnet')).toBe(true);
  });
});

describe('applyGrokBotStatus', () => {
  it('U2: ignores a GET snapshot whose since is older than the last applied frame', () => {
    const starting = status('starting', { since: 2_000 });
    const staleStopped = status('stopped', { since: 1_000 });
    expect(applyGrokBotStatus(starting, staleStopped)).toEqual(starting);
    expect(applyGrokBotStatus(null, staleStopped)).toEqual(staleStopped);
    expect(applyGrokBotStatus(staleStopped, starting)).toEqual(starting);
  });

  it('U2: a GET stopped with the same since as starting does not clobber the frame', () => {
    const starting = status('starting', { since: 1_000 });
    const inflightStopped = status('stopped', { since: 1_000 });
    expect(applyGrokBotStatus(starting, inflightStopped)).toEqual(starting);
    expect(applyGrokBotStatus(starting, status('starting', { since: 1_000, lastError: 'x' })).lastError).toBe('x');
  });

  it('N1: an older frame after a newer GET does not regress', () => {
    const fromGet = status('failed', { since: 2_000, lastError: 'give-up' });
    const olderFrame = status('stopped', { since: 1_000, lastError: 'stale' });
    expect(applyGrokBotStatus(fromGet, olderFrame, 'frame')).toEqual(fromGet);
  });

  it('N1: a genuine transition frame with equal since still applies', () => {
    const fromGet = status('stopped', { since: 1_000, lastError: null });
    const frame = status('starting', { since: 1_000, lastError: null });
    expect(applyGrokBotStatus(fromGet, frame, 'frame')).toEqual(frame);
    expect(applyGrokBotStatus(fromGet, frame)).toEqual(fromGet);
  });
});

describe('filterGrokBotProject', () => {
  it('hides only the system container when disabled', () => {
    const projects: Project[] = [
      { id: 'a', name: 'Work', rootPath: '/tmp', createdAt: 0 },
      { id: REMOTE_AGENTS_PROJECT_ID, name: 'Grok Bots', rootPath: '/tmp', createdAt: 0, system: true },
    ];
    expect(filterGrokBotProject(projects, true)).toEqual(projects);
    expect(filterGrokBotProject(projects, false).map((p) => p.id)).toEqual(['a']);
  });
});

describe('grokBotEnabledFromProfiles', () => {
  it('is true when any grok-bot profile is present', () => {
    expect(grokBotEnabledFromProfiles([profile({ agentType: 'grok-bot' })])).toBe(true);
    expect(grokBotEnabledFromProfiles([profile()])).toBe(false);
  });

  it('treats unloaded profiles as not-disabled', () => {
    expect(grokBotEnabledFromProfiles([], false)).toBe(true);
    expect(grokBotEnabledFromProfiles([], true)).toBe(false);
  });
});

describe('statusBanner', () => {
  const grok = { enabled: true, isGrokChat: true };

  it('running → null', () => {
    expect(statusBanner(status('running'), grok)).toBeNull();
  });

  it('disabled → Settings copy', () => {
    const b = statusBanner(status('disabled'), { enabled: false, isGrokChat: true });
    expect(b?.text).toBe('Grok Bot is disabled — enable in Settings → Grok Bot');
    expect(b?.action).toBeNull();
  });

  it('null status while enabled is checking, not disabled', () => {
    const b = statusBanner(null, { enabled: true, isGrokChat: true });
    expect(b?.text).toBe('Checking Grok Bot…');
    expect(b?.spinner).toBe(true);
    expect(statusBanner(null, { enabled: false, isGrokChat: true })?.text)
      .toBe('Grok Bot is disabled — enable in Settings → Grok Bot');
  });

  it('starting → spinner, no action', () => {
    const b = statusBanner(status('starting'), grok);
    expect(b).toEqual({ text: 'Starting Grok Bot…', severity: 'info', action: null, spinner: true });
  });

  it('backoff soon → spinner', () => {
    const b = statusBanner(status('backoff', { nextAttemptAt: Date.now() + 5_000 }), grok);
    expect(b?.spinner).toBe(true);
    expect(b?.action).toBeNull();
  });

  it('failed → error + retry', () => {
    const b = statusBanner(status('failed', { lastError: 'unit failed' }), grok);
    expect(b?.severity).toBe('error');
    expect(b?.action).toBe('retry');
    expect(b?.text).toContain('unit failed');
  });

  it('running-no-cdp → error + retry', () => {
    expect(statusBanner(status('running-no-cdp'), grok)?.action).toBe('retry');
  });

  it('port-conflict → error + retry', () => {
    expect(statusBanner(status('port-conflict'), grok)?.action).toBe('retry');
  });

  it('no-display → muted, no action', () => {
    const b = statusBanner(status('no-display'), grok);
    expect(b).toEqual({
      text: 'No graphical session — log in to the desktop',
      severity: 'muted', action: null, spinner: false,
    });
  });

  it('stopped + off → Start', () => {
    const b = statusBanner(status('stopped', { autoStart: 'off' }), grok);
    expect(b?.action).toBe('start');
    expect(b?.text).toBe("Grok Bot isn't running");
  });

  it('not-installed → error, no action', () => {
    expect(statusBanner(status('not-installed'), grok)?.action).toBeNull();
  });

  it('unsupported → muted', () => {
    expect(statusBanner(status('unsupported'), grok)?.severity).toBe('muted');
  });

  it('non-grok chat → null', () => {
    expect(statusBanner(status('failed'), { enabled: true, isGrokChat: false })).toBeNull();
  });
});
