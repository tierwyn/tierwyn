import { describe, it, expect } from 'vitest';
import type { Project, TranscriptEvent, CompactionSettings, RoleWhenPreset, GrokBotLifecycleStatus } from './index.js';
import {
  matchWhenPreset,
  grokBotUsable,
  clampSidecarMaxInputChars,
  DEFAULT_SIDECAR_MAX_INPUT_CHARS,
  DEFAULT_SIDECAR_TIMEOUTS,
  SIDECAR_SITES,
  SIDECAR_SITES_WITH_CWD,
  SIDECAR_MAX_INPUT_CHARS_MIN,
  SIDECAR_MAX_INPUT_CHARS_MAX,
  SIDECAR_BUILTIN_PROMPTS,
  SIDECAR_LLM_DEFAULTS,
  SIDECAR_SITE_DEFAULT_PROFILE,
  DEFAULT_DESCRIBE_PROMPT,
  COMMIT_MESSAGE_SYSTEM_PROMPT,
  BTW_DIRECTIVE,
  pickSidecarPrompt,
  USAGE_AUTO_RESUME_OPTIONS,
} from './index.js';
import type { SidecarPrompt } from './index.js';

describe('shared domain types', () => {
  it('shapes compile and round-trip as expected', () => {
    const p: Project = { id: 'a', name: 'n', rootPath: '/p', createdAt: 1 };
    const e: TranscriptEvent = {
      id: 'e', sessionId: 's', type: 'prompt', payload: { text: 'hi' },
      sender: 'user', seq: 0, ts: 1,
    };
    const c: CompactionSettings = {
      preferredProfileId: 'x', fallbackProfileId: 'y',
      maxCompactorContextTokens: 100, summaryVerbosity: 'medium', outputTokenCap: 4000,
      compactionEnabled: true, handoffMode: 'summary',
      maxTranscriptHandoffTokens: 150_000, transcriptContextSafetyFactor: 0.5,
      interactionMode: 'bypass', spawnApprovalRequired: false,
      meshAwareness: 'off', meshMessaging: 'off',
      meshMaxPeersPerConversation: 4, meshMessagesPerMinute: 6,
      meshMessagesPerMinuteGlobal: 20, meshMaxHops: 1, meshAutoEdges: true,
      usageAutoResume: 'delegates', usageAutoResumeMaxDeferMs: 8 * 60 * 60 * 1000,
      usageAutoResumeMaxAttempts: 3,
      spawnTokenIdleTtlMinutes: 30,
      scheduleRunTokenIdleTtlMinutes: 30,
      spawnStallTimeoutMinutes: 15,
    };
    expect([p.id, e.type, c.outputTokenCap]).toEqual(['a', 'prompt', 4000]);
  });
});

describe('matchWhenPreset', () => {
  const presets: RoleWhenPreset[] = [
    { id: '1', name: 'Implementer', when: 'implement features' },
    { id: '2', name: 'Reviewer', when: 'review PRs' },
    { id: '3', name: 'Dup body', when: 'implement features' },
  ];

  it('matches exact body after trim', () => {
    expect(matchWhenPreset(presets, 'implement features')?.id).toBe('1');
    expect(matchWhenPreset(presets, '  implement features  ')?.id).toBe('1');
    expect(matchWhenPreset(presets, 'review PRs')?.name).toBe('Reviewer');
  });

  it('returns undefined when no body matches', () => {
    expect(matchWhenPreset(presets, 'something else')).toBeUndefined();
    expect(matchWhenPreset(presets, '')).toBeUndefined();
  });

  it('returns first preset when bodies are duplicated', () => {
    expect(matchWhenPreset(presets, 'implement features')?.id).toBe('1');
  });

  it('returns undefined for empty preset list', () => {
    expect(matchWhenPreset([], 'implement features')).toBeUndefined();
  });
});

describe('clampSidecarMaxInputChars', () => {
  it('returns undefined for absent, non-numeric, zero and negative input', () => {
    expect(clampSidecarMaxInputChars(undefined)).toBeUndefined();
    expect(clampSidecarMaxInputChars(null)).toBeUndefined();
    expect(clampSidecarMaxInputChars('')).toBeUndefined();
    expect(clampSidecarMaxInputChars('nope')).toBeUndefined();
    expect(clampSidecarMaxInputChars(NaN)).toBeUndefined();
    expect(clampSidecarMaxInputChars(0)).toBeUndefined();
    expect(clampSidecarMaxInputChars(-1)).toBeUndefined();
    expect(clampSidecarMaxInputChars(-500)).toBeUndefined();
  });

  it('clamps below SIDECAR_MAX_INPUT_CHARS_MIN up to 500', () => {
    expect(clampSidecarMaxInputChars(10)).toBe(500);
    expect(clampSidecarMaxInputChars(499)).toBe(SIDECAR_MAX_INPUT_CHARS_MIN);
  });

  it('clamps above SIDECAR_MAX_INPUT_CHARS_MAX down to 500000', () => {
    expect(clampSidecarMaxInputChars(9e9)).toBe(500_000);
    expect(clampSidecarMaxInputChars(500_001)).toBe(SIDECAR_MAX_INPUT_CHARS_MAX);
  });

  it('rounds fractional input', () => {
    expect(clampSidecarMaxInputChars(4000.6)).toBe(4001);
    expect(clampSidecarMaxInputChars(4000.4)).toBe(4000);
  });

  it('accepts numeric strings like the timeout clamp does', () => {
    expect(clampSidecarMaxInputChars('8000')).toBe(8000);
    expect(clampSidecarMaxInputChars('500')).toBe(500);
  });
});

describe('DEFAULT_SIDECAR_MAX_INPUT_CHARS', () => {
  it('has an entry for every SIDECAR_SITE', () => {
    for (const site of SIDECAR_SITES) {
      expect(DEFAULT_SIDECAR_MAX_INPUT_CHARS[site]).toEqual(expect.any(Number));
    }
  });

  it('pins the documented per-site defaults', () => {
    expect(DEFAULT_SIDECAR_MAX_INPUT_CHARS)
      .toEqual({ transcribe: 4_000, enhance: 8_000, tts: 8_000, describe: 4_000, commit: 20_000, btw: 100_000 });
  });

  it('includes btw as a sidecar site with observer defaults', () => {
    expect(SIDECAR_SITES).toContain('btw');
    expect(SIDECAR_SITES_WITH_CWD).toContain('btw');
    expect(SIDECAR_SITE_DEFAULT_PROFILE.btw).toBe('enhancer');
    expect(SIDECAR_LLM_DEFAULTS.btw).toEqual({
      backend: 'agent_readonly',
      adapter: 'claude-code',
      model: 'claude-haiku-4-5',
    });
    expect(DEFAULT_SIDECAR_TIMEOUTS.btw).toBe(240);
  });

  it('keeps enhance at 4x CONTEXT_TOKEN_CAP so the token budget is unchanged', () => {
    expect(Math.floor(DEFAULT_SIDECAR_MAX_INPUT_CHARS.enhance / 4)).toBe(2000);
  });
});

describe('SIDECAR_BUILTIN_PROMPTS', () => {
  it('has a non-empty array for every SIDECAR_SITE', () => {
    for (const site of SIDECAR_SITES) {
      expect(SIDECAR_BUILTIN_PROMPTS[site].length).toBeGreaterThan(0);
    }
  });

  it('pins builtin ids so saved selectedPromptIds never dangle', () => {
    expect(SIDECAR_BUILTIN_PROMPTS.transcribe.map(p => p.id)).toEqual(['builtin-1', 'builtin-2']);
    expect(SIDECAR_BUILTIN_PROMPTS.tts.map(p => p.id)).toEqual(['tts-builtin-1']);
    expect(SIDECAR_BUILTIN_PROMPTS.enhance.map(p => p.id)).toEqual(['enhance-quick-1']);
    expect(SIDECAR_BUILTIN_PROMPTS.describe.map(p => p.id)).toEqual(['describe-builtin-1']);
    expect(SIDECAR_BUILTIN_PROMPTS.commit.map(p => p.id)).toEqual(['commit-builtin-1']);
    expect(SIDECAR_BUILTIN_PROMPTS.btw.map(p => p.id)).toEqual(['btw-builtin-1']);
  });

  it('reuses the exact builtin text, not a copy', () => {
    expect(SIDECAR_BUILTIN_PROMPTS.describe[0]!.text).toBe(DEFAULT_DESCRIBE_PROMPT);
    expect(SIDECAR_BUILTIN_PROMPTS.commit[0]!.text).toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
    expect(SIDECAR_BUILTIN_PROMPTS.btw[0]!.text).toBe(BTW_DIRECTIVE);
  });
});

describe('pickSidecarPrompt', () => {
  const builtins: SidecarPrompt[] = [
    { id: 'builtin-1', name: 'Default', text: 'DEFAULT TEXT' },
    { id: 'builtin-2', name: 'Alt', text: 'ALT TEXT' },
  ];
  const customs: SidecarPrompt[] = [
    { id: 'c1', name: 'Mine', text: 'CUSTOM TEXT' },
  ];

  it('matches a builtin id', () => {
    expect(pickSidecarPrompt(builtins, undefined, 'builtin-2')).toBe('ALT TEXT');
  });

  it('matches a custom id and prefers it over the builtin default', () => {
    expect(pickSidecarPrompt(builtins, customs, 'c1')).toBe('CUSTOM TEXT');
  });

  it('falls back to the first builtin for an unknown id', () => {
    expect(pickSidecarPrompt(builtins, customs, 'nope')).toBe('DEFAULT TEXT');
  });

  it('falls back to the first builtin for an undefined id', () => {
    expect(pickSidecarPrompt(builtins, customs, undefined)).toBe('DEFAULT TEXT');
  });

  it('returns empty string when there are no builtins and no match', () => {
    expect(pickSidecarPrompt([], undefined, 'x')).toBe('');
    expect(pickSidecarPrompt([], [], undefined)).toBe('');
  });
});

import type { UsageProfileRef, AgentUsageAgentView, UsageProviderCard, SpawnEdgeOutcome } from './index.js';

it('UsageProfileRef stamps onto usage cards', () => {
  const ref: UsageProfileRef = {
    profileId: 'hermes:glm-4.6',
    label: 'GLM 4.6 (Hermes)',
    agentType: 'hermes',
    model: 'GLM-4.6',
    enabled: true,
  };
  const builtin: AgentUsageAgentView = {
    agentType: 'claude-code', label: 'Claude Code', installed: true, groups: [], profiles: [ref],
  };
  const provider: UsageProviderCard = {
    id: 'zai-usage', label: 'Z.AI', configured: true, ok: true, profiles: [ref],
  };
  const outcomes: SpawnEdgeOutcome[] = ['success', 'degenerate', 'failed', 'stalled', 'interrupted', 'stopped'];
  expect(builtin.profiles![0].profileId).toBe('hermes:glm-4.6');
  expect(provider.profiles![0].agentType).toBe('hermes');
  expect(outcomes).toHaveLength(6);
});

it('usage auto-resume options are the closed OD-1 set', () => {
  expect(USAGE_AUTO_RESUME_OPTIONS.map((o) => o.value)).toEqual(['off', 'delegates', 'all']);
});

function grokStatus(over: Partial<GrokBotLifecycleStatus> = {}): GrokBotLifecycleStatus {
  return {
    state: 'stopped',
    enabled: true,
    autoStart: 'on-demand',
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

describe('grokBotUsable', () => {
  it('treats unknown status as usable so the picker does not flicker', () => {
    expect(grokBotUsable(null)).toBe(true);
    expect(grokBotUsable(undefined)).toBe(true);
  });

  it('is usable when running or starting', () => {
    expect(grokBotUsable(grokStatus({ state: 'running' }))).toBe(true);
    expect(grokBotUsable(grokStatus({ state: 'starting' }))).toBe(true);
  });

  it('is unusable when stopped or backoff even if autostart could launch', () => {
    expect(grokBotUsable(grokStatus({ state: 'stopped', autoStart: 'on-demand' }))).toBe(false);
    expect(grokBotUsable(grokStatus({ state: 'stopped', autoStart: 'keep-running' }))).toBe(false);
    expect(grokBotUsable(grokStatus({ state: 'backoff', autoStart: 'on-demand' }))).toBe(false);
    expect(grokBotUsable(grokStatus({ state: 'stopped', autoStart: 'off' }))).toBe(false);
  });

  it('is unusable when the agent is disabled', () => {
    expect(grokBotUsable(grokStatus({ state: 'running', enabled: false }))).toBe(false);
  });
});
