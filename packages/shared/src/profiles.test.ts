import { describe, it, expect } from 'vitest';
import {
  PERMISSION_CAPABLE_ADAPTERS,
  IMAGE_CAPABLE_ADAPTERS,
  LIVE_INJECT_ADAPTERS,
  SOFT_CANCEL_ADAPTERS,
  HARD_STOP_ADAPTERS,
  HOLD_OPEN_FOLLOWUP_ADAPTERS,
  forceMechanism,
  steerClass,
  profileAcceptsImages,
  agentSupportsPermissionMode,
  agentSupportsSlashCommands,
  interactionModeRequiresPermissionCapable,
  isTierwynNativeSlashInput,
  slashCommandUnsupportedMessage,
  effortLevelsFor,
  clampEffort,
  resolveEffort,
  modelNameBakesEffort,
  modelRejectsEffort,
  resolveEffortForModel,
  DEFAULT_EFFORT,
} from './profiles.js';

function visionProfile(agentType: string) {
  return {
    id: `${agentType}:test`,
    agentType,
    model: 'test',
    label: agentType,
    description: '',
    vision: true,
    steer: false,
    enabled: true,
  };
}

describe('IMAGE_CAPABLE_ADAPTERS / profileAcceptsImages', () => {
  it('includes adapters that deliver images inline or via local path reference', () => {
    for (const agent of [
      'claude-code', 'pi', 'opencode', 'kilocode',
      'antigravity', 'hermes', 'codex', 'grok-build', 'cursor', 'openclaw', 'kiro', 'kimi', 'copilot', 'deepseek', 'grok-bot',
    ]) {
      expect(IMAGE_CAPABLE_ADAPTERS.has(agent)).toBe(true);
      expect(profileAcceptsImages(visionProfile(agent))).toBe(true);
    }
  });

  it('rejects non-vision profiles even when the adapter can deliver images', () => {
    expect(profileAcceptsImages({ ...visionProfile('cursor'), vision: false })).toBe(false);
  });
});

describe('PERMISSION_CAPABLE_ADAPTERS', () => {
  it('includes claude-code, codex, hermes, grok-build, kiro', () => {
    expect(PERMISSION_CAPABLE_ADAPTERS.has('claude-code')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('codex')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('hermes')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('grok-build')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('kiro')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('qwen')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('kimi')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('grok-bot')).toBe(true);
  });

  it('excludes the bypass-only adapters', () => {
    // pi, opencode, kilocode, cursor, antigravity, openclaw — no permission
    // round-trip; they ignore interactionMode and run bypass-equivalent.
    for (const agent of ['pi', 'opencode', 'kilocode', 'cursor', 'antigravity', 'openclaw', 'copilot', 'deepseek']) {
      expect(PERMISSION_CAPABLE_ADAPTERS.has(agent)).toBe(false);
    }
  });
});

describe('agentSupportsPermissionMode', () => {
  it('returns true for permission-capable agentTypes', () => {
    expect(agentSupportsPermissionMode('claude-code')).toBe(true);
    expect(agentSupportsPermissionMode('codex')).toBe(true);
    expect(agentSupportsPermissionMode('hermes')).toBe(true);
    expect(agentSupportsPermissionMode('grok-build')).toBe(true);
    expect(agentSupportsPermissionMode('kiro')).toBe(true);
    expect(agentSupportsPermissionMode('qwen')).toBe(true);
    expect(agentSupportsPermissionMode('grok-bot')).toBe(true);
  });

  it('returns false for bypass-only agentTypes', () => {
    expect(agentSupportsPermissionMode('pi')).toBe(false);
    expect(agentSupportsPermissionMode('opencode')).toBe(false);
    expect(agentSupportsPermissionMode('cursor')).toBe(false);
    expect(agentSupportsPermissionMode('antigravity')).toBe(false);
    expect(agentSupportsPermissionMode('openclaw')).toBe(false);
    expect(agentSupportsPermissionMode('copilot')).toBe(false);
  });

  it('fails closed for undefined / null / empty / unknown', () => {
    expect(agentSupportsPermissionMode(undefined)).toBe(false);
    expect(agentSupportsPermissionMode(null)).toBe(false);
    expect(agentSupportsPermissionMode('')).toBe(false);
    expect(agentSupportsPermissionMode('totally-fake-agent')).toBe(false);
  });
});

describe('isTierwynNativeSlashInput / slashCommandUnsupportedMessage', () => {
  it('recognises /btw and /btw with args as Tierwyn-native', () => {
    expect(isTierwynNativeSlashInput('/btw')).toBe(true);
    expect(isTierwynNativeSlashInput('/btw what is the plan?')).toBe(true);
    expect(isTierwynNativeSlashInput('  /btw  ')).toBe(true);
  });

  it('rejects partial prefixes and non-btw verbs', () => {
    expect(isTierwynNativeSlashInput('/')).toBe(false);
    expect(isTierwynNativeSlashInput('/bt')).toBe(false);
    expect(isTierwynNativeSlashInput('/btwextra')).toBe(false);
    expect(isTierwynNativeSlashInput('/help')).toBe(false);
    expect(isTierwynNativeSlashInput('btw')).toBe(false);
  });

  it('suppresses the unsupported warning for /btw on non-capable agents', () => {
    expect(agentSupportsSlashCommands('openclaw')).toBe(false);
    expect(slashCommandUnsupportedMessage('openclaw', '/btw')).toBeNull();
    expect(slashCommandUnsupportedMessage('openclaw', '/btw why?')).toBeNull();
    // Without text (or with a real agent slash), still warn.
    expect(slashCommandUnsupportedMessage('openclaw')).toMatch(/does not support slash commands/);
    expect(slashCommandUnsupportedMessage('openclaw', '/help')).toMatch(/does not support slash commands/);
    expect(slashCommandUnsupportedMessage('openclaw', '/')).toMatch(/does not support slash commands/);
  });

  it('returns null for slash-capable agents regardless of text', () => {
    expect(slashCommandUnsupportedMessage('claude-code')).toBeNull();
    expect(slashCommandUnsupportedMessage('claude-code', '/help')).toBeNull();
    expect(agentSupportsSlashCommands('antigravity')).toBe(true);
    expect(slashCommandUnsupportedMessage('antigravity')).toBeNull();
    expect(slashCommandUnsupportedMessage('antigravity', '/help')).toBeNull();
    expect(agentSupportsSlashCommands('grok-build')).toBe(true);
    expect(slashCommandUnsupportedMessage('grok-build')).toBeNull();
    expect(slashCommandUnsupportedMessage('grok-build', '/compact')).toBeNull();
    expect(agentSupportsSlashCommands('kiro')).toBe(true);
    expect(slashCommandUnsupportedMessage('kiro')).toBeNull();
    expect(agentSupportsSlashCommands('qwen')).toBe(true);
    expect(slashCommandUnsupportedMessage('qwen')).toBeNull();
  });
});

describe('interactionModeRequiresPermissionCapable', () => {
  it('requires capable agents only in prompt mode', () => {
    expect(interactionModeRequiresPermissionCapable('prompt')).toBe(true);
    expect(interactionModeRequiresPermissionCapable('questions')).toBe(false);
    expect(interactionModeRequiresPermissionCapable('bypass')).toBe(false);
  });

  it('returns false for undefined / null', () => {
    expect(interactionModeRequiresPermissionCapable(undefined)).toBe(false);
    expect(interactionModeRequiresPermissionCapable(null)).toBe(false);
  });
});

describe('effortLevelsFor / clampEffort / resolveEffort', () => {
  it('DEFAULT_EFFORT is medium', () => {
    expect(DEFAULT_EFFORT).toBe('medium');
  });

  it('returns 5 levels for claude-code', () => {
    expect(effortLevelsFor('claude-code')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevelsFor('kiro')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('returns no levels for copilot (effort unreachable: auto-only routing rejects it)', () => {
    expect(effortLevelsFor('copilot')).toEqual([]);
  });

  it('returns 3 levels for codex', () => {
    expect(effortLevelsFor('codex')).toEqual(['low', 'medium', 'high']);
  });

  it('returns 3 levels for antigravity (agy 1.1.27 --effort)', () => {
    expect(effortLevelsFor('antigravity')).toEqual(['low', 'medium', 'high']);
  });

  it('modelRejectsEffort flags antigravity Claude Thinking rows only', () => {
    expect(modelRejectsEffort('antigravity', 'claude-opus-4-6-thinking')).toBe(true);
    expect(modelRejectsEffort('antigravity', 'Claude Opus 4.6 (Thinking)')).toBe(true);
    expect(modelRejectsEffort('antigravity', 'gemini-3.7-flash')).toBe(false);
    expect(modelRejectsEffort('claude-code', 'claude-opus-4-6-thinking')).toBe(false);
    expect(modelRejectsEffort('antigravity', undefined)).toBe(false);
    expect(modelRejectsEffort(undefined, 'claude-opus-4-6-thinking')).toBe(false);
  });

  it('resolveEffortForModel omits effort for Thinking rows, baked rows, and off', () => {
    expect(resolveEffortForModel('antigravity', 'claude-opus-4-6-thinking', 'high')).toBeUndefined();
    expect(resolveEffortForModel('antigravity', 'gemini-3.7-flash-low', 'high')).toBeUndefined();
    expect(resolveEffortForModel('antigravity', 'gemini-3.7-flash', 'off')).toBeUndefined();
    expect(resolveEffortForModel('antigravity', 'gemini-3.7-flash', 'high')).toBe('high');
    expect(resolveEffortForModel('antigravity', 'gemini-3.7-flash', 'max')).toBe('high');
  });

  it('returns 4 levels for grok-build (no max)', () => {
    expect(effortLevelsFor('grok-build')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('returns empty for no-effort adapters', () => {
    expect(effortLevelsFor('opencode')).toEqual([]);
    expect(effortLevelsFor('cursor')).toEqual([]);
    expect(effortLevelsFor('hermes')).toEqual([]);
    expect(effortLevelsFor('pi')).toEqual([]);
    expect(effortLevelsFor(undefined)).toEqual([]);
    expect(effortLevelsFor(null)).toEqual([]);
    expect(effortLevelsFor('qwen')).toEqual([]);
  });

  it('clampEffort omits unsupported levels', () => {
    expect(clampEffort('antigravity', 'max')).toBeUndefined();
    expect(clampEffort('antigravity', 'high')).toBe('high');
    expect(clampEffort('claude-code', 'xhigh')).toBe('xhigh');
    expect(clampEffort('claude-code', undefined)).toBeUndefined();
    expect(clampEffort('opencode', 'medium')).toBeUndefined();
  });

  it('resolveEffort clamps to ceiling for effort-capable adapters', () => {
    expect(resolveEffort('antigravity', 'max')).toBe('high');
    expect(resolveEffort('claude-code', 'max')).toBe('max');
    expect(resolveEffort('claude-code', 'medium')).toBe('medium');
    expect(resolveEffort('opencode', 'medium')).toBeUndefined();
  });

  it("resolveEffort 'off' omits effort regardless of adapter capability", () => {
    expect(resolveEffort('claude-code', 'off')).toBeUndefined();
    expect(resolveEffort('antigravity', 'off')).toBeUndefined();
    expect(resolveEffort('opencode', 'off')).toBeUndefined();
    expect(resolveEffort(undefined, 'off')).toBeUndefined();
  });

  it('modelNameBakesEffort detects slug and parenthetical encodings', () => {
    expect(modelNameBakesEffort('gemini-3.7-flash-low')).toBe(true);
    expect(modelNameBakesEffort('Gemini 3.7 Flash (Low)')).toBe(true);
    expect(modelNameBakesEffort('Antigravity · Gemini 3.7 Flash (Low)')).toBe(true);
    expect(modelNameBakesEffort('gpt-oss-120b-medium')).toBe(true);
    expect(modelNameBakesEffort('claude-sonnet-4-6')).toBe(false);
    expect(modelNameBakesEffort('claude-opus-4-6-thinking')).toBe(false);
    expect(modelNameBakesEffort('')).toBe(false);
    expect(modelNameBakesEffort(undefined)).toBe(false);
  });
});

describe('kiro capability-set membership', () => {
  it('is in SOFT_CANCEL ∪ HARD_STOP, permission/image/slash capable, not LIVE_INJECT', () => {
    expect(SOFT_CANCEL_ADAPTERS.has('kiro')).toBe(true);
    expect(HARD_STOP_ADAPTERS.has('kiro')).toBe(true);
    expect(LIVE_INJECT_ADAPTERS.has('kiro')).toBe(false);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('kiro')).toBe(true);
    expect(IMAGE_CAPABLE_ADAPTERS.has('kiro')).toBe(true);
    expect(steerClass('kiro', false)).toBe('force');
    expect(forceMechanism('kiro')).toBe('soft');
  });
});

describe('qwen capability-set membership', () => {
  it('is permission/slash/soft-cancel capable, not image or live-inject', () => {
    expect(SOFT_CANCEL_ADAPTERS.has('qwen')).toBe(true);
    expect(HARD_STOP_ADAPTERS.has('qwen')).toBe(false);
    expect(LIVE_INJECT_ADAPTERS.has('qwen')).toBe(false);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('qwen')).toBe(true);
    expect(IMAGE_CAPABLE_ADAPTERS.has('qwen')).toBe(true);
    expect(steerClass('qwen', true)).toBe('force');
    expect(forceMechanism('qwen')).toBe('soft');
  });
});

describe('kimi capability-set membership', () => {
  it('is permission/slash/image/soft-cancel capable, not hard-stop or live-inject', () => {
    expect(SOFT_CANCEL_ADAPTERS.has('kimi')).toBe(true);
    expect(HARD_STOP_ADAPTERS.has('kimi')).toBe(false);
    expect(LIVE_INJECT_ADAPTERS.has('kimi')).toBe(false);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('kimi')).toBe(true);
    expect(IMAGE_CAPABLE_ADAPTERS.has('kimi')).toBe(true);
    expect(agentSupportsSlashCommands('kimi')).toBe(true);
    expect(steerClass('kimi', true)).toBe('force');
    expect(forceMechanism('kimi')).toBe('soft');
    expect(effortLevelsFor('kimi')).toEqual([]);
  });
});

describe('copilot capability-set membership', () => {
  it('is image-capable hard-stop without effort; not permission, slash, or live-inject', () => {
    expect(IMAGE_CAPABLE_ADAPTERS.has('copilot')).toBe(true);
    expect(HARD_STOP_ADAPTERS.has('copilot')).toBe(true);
    expect(PERMISSION_CAPABLE_ADAPTERS.has('copilot')).toBe(false);
    expect(LIVE_INJECT_ADAPTERS.has('copilot')).toBe(false);
    expect(SOFT_CANCEL_ADAPTERS.has('copilot')).toBe(false);
    expect(agentSupportsSlashCommands('copilot')).toBe(false);
    expect(steerClass('copilot', false)).toBe('force');
    expect(forceMechanism('copilot')).toBe('hard');
    expect(effortLevelsFor('copilot')).toEqual([]);
  });
});

describe('deepseek hold-open follow-up', () => {
  it('is in HOLD_OPEN_FOLLOWUP_ADAPTERS so parked sessions are reused', () => {
    expect(HOLD_OPEN_FOLLOWUP_ADAPTERS.has('deepseek')).toBe(true);
  });

  it('supports slash commands', () => {
    expect(agentSupportsSlashCommands('deepseek')).toBe(true);
  });

  it('supports verified dsh effort levels (low, high, max)', () => {
    expect(effortLevelsFor('deepseek')).toEqual(['low', 'high', 'max']);
  });
});

describe('antigravity hold-open follow-up', () => {
  it('is in HOLD_OPEN_FOLLOWUP_ADAPTERS and stays hard-stop (not live-inject)', () => {
    expect(HOLD_OPEN_FOLLOWUP_ADAPTERS.has('antigravity')).toBe(true);
    expect(LIVE_INJECT_ADAPTERS.has('antigravity')).toBe(false);
    expect(HARD_STOP_ADAPTERS.has('antigravity')).toBe(true);
    expect(steerClass('antigravity', true)).toBe('force');
    expect(steerClass('antigravity', false)).toBe('force');
    expect(forceMechanism('antigravity')).toBe('hard');
  });
});

describe('grok-bot capability-set membership', () => {
  it('is permission-capable live-inject; not soft-cancel or hard-stop', () => {
    expect(PERMISSION_CAPABLE_ADAPTERS.has('grok-bot')).toBe(true);
    expect(LIVE_INJECT_ADAPTERS.has('grok-bot')).toBe(true);
    expect(SOFT_CANCEL_ADAPTERS.has('grok-bot')).toBe(false);
    expect(HARD_STOP_ADAPTERS.has('grok-bot')).toBe(false);
    expect(steerClass('grok-bot', true)).toBe('live');
    expect(forceMechanism('grok-bot')).toBeNull();
  });
});
