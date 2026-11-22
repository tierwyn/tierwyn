import { describe, it, expect } from 'vitest';
import {
  promptOptionsFor,
  promptOptionsFootnote,
  promptOptionsEqual,
  sanitisePromptOptions,
  stripCommandIncompatibleOptions,
  PromptOptionError,
} from './promptOptions.js';

describe('promptOptionsFor', () => {
  it('returns descriptors for antigravity', () => {
    const descs = promptOptionsFor('antigravity');
    expect(descs.length).toBeGreaterThan(0);
    expect(descs.map((d) => d.key)).toEqual(['mode', 'sandbox', 'jsonSchema', 'disableSlashCommands']);
  });

  it('returns descriptors for cursor', () => {
    const descs = promptOptionsFor('cursor');
    expect(descs.map((d) => d.key)).toEqual(['mode', 'sandbox', 'autoReview']);
  });

  it('returns descriptors for copilot', () => {
    const descs = promptOptionsFor('copilot');
    expect(descs.map((d) => d.key)).toEqual(['mode', 'effort', 'toolsPolicy', 'assistedApproval']);
  });

  it('reuses antigravity jsonSchema presets on claude-code', () => {
    const agy = promptOptionsFor('antigravity').find((d) => d.key === 'jsonSchema');
    const cc = promptOptionsFor('claude-code').find((d) => d.key === 'jsonSchema');
    expect(agy?.kind).toBe('text');
    expect(cc?.kind).toBe('text');
    if (agy?.kind === 'text' && cc?.kind === 'text') {
      expect(cc.presets).toEqual(agy.presets);
      expect(cc.presets?.length).toBeGreaterThan(0);
    }
  });

  it('returns descriptors for openclaw', () => {
    const descs = promptOptionsFor('openclaw');
    expect(descs.map((d) => d.key)).toEqual(['thinking', 'timeout']);
    const thinking = descs.find((d) => d.key === 'thinking');
    expect(thinking?.kind).toBe('select');
    if (thinking?.kind === 'select') {
      expect(thinking.choices.map((c) => c.value)).toEqual([
        'default', 'off', 'minimal', 'low', 'medium', 'high', 'max',
      ]);
    }
    const timeout = descs.find((d) => d.key === 'timeout');
    expect(timeout?.kind).toBe('select');
    if (timeout?.kind === 'select') {
      expect(timeout.choices.map((c) => c.value)).toEqual(['default', '120', '300', '600', '1800']);
    }
  });

  it('returns descriptors for qwen permissionMode and sandbox', () => {
    const descs = promptOptionsFor('qwen');
    expect(descs.map((d) => d.key)).toEqual(['permissionMode', 'sandbox']);
    const permissionMode = descs.find((d) => d.key === 'permissionMode');
    expect(permissionMode?.kind).toBe('select');
    if (permissionMode?.kind === 'select') {
      expect(permissionMode.choices.map((c) => c.value)).toEqual([
        'default', 'default-strict', 'yolo',
      ]);
    }
    const sandbox = descs.find((d) => d.key === 'sandbox');
    expect(sandbox?.kind).toBe('toggle');
    expect(sandbox?.caveat).toMatch(/Docker|Podman/i);
    expect(descs.some((d) => d.key === 'safeMode')).toBe(false);
  });

  it('returns descriptors for grok-build', () => {
    const descs = promptOptionsFor('grok-build');
    expect(descs.map((d) => d.key)).toEqual(['sandbox', 'reasoningEffort', 'yoloMode']);
    const sandbox = descs.find((d) => d.key === 'sandbox');
    expect(sandbox?.kind).toBe('select');
    if (sandbox?.kind === 'select') {
      expect(sandbox.choices.map((c) => c.value)).toEqual(['default', 'workspace', 'read-only', 'strict']);
      expect(sandbox.choices.map((c) => c.value)).not.toContain('devbox');
    }
    const reasoningEffort = descs.find((d) => d.key === 'reasoningEffort');
    expect(reasoningEffort?.kind).toBe('select');
    if (reasoningEffort?.kind === 'select') {
      expect(reasoningEffort.choices.map((c) => c.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
    }
    const yoloMode = descs.find((d) => d.key === 'yoloMode');
    expect(yoloMode?.kind).toBe('select');
    if (yoloMode?.kind === 'select') {
      expect(yoloMode.choices.map((c) => c.value)).toEqual(['default', 'on', 'off']);
      expect(yoloMode.caveat).toMatch(/one turn/i);
    }
  });

  it('returns descriptors for codex sandbox only', () => {
    const descs = promptOptionsFor('codex');
    expect(descs.map((d) => d.key)).toEqual(['sandbox']);
    const sandbox = descs.find((d) => d.key === 'sandbox');
    expect(sandbox?.kind).toBe('select');
    if (sandbox?.kind === 'select') {
      expect(sandbox.choices.map((c) => c.value)).toEqual([
        'default', 'read-only', 'danger-full-access',
      ]);
    }
    expect(descs.some((d) => d.key === 'approvalPolicy' || d.key === 'outputSchema')).toBe(false);
  });

  it('returns identical descriptors for opencode and kilocode', () => {
    const opencode = promptOptionsFor('opencode');
    const kilocode = promptOptionsFor('kilocode');
    expect(opencode.map((d) => d.key)).toEqual(['variant', 'thinking', 'pure', 'agent']);
    expect(kilocode.map((d) => d.key)).toEqual(['variant', 'thinking', 'pure', 'agent']);
    expect(kilocode).toEqual(opencode);
    const variant = opencode.find((d) => d.key === 'variant');
    expect(variant?.kind).toBe('select');
    if (variant?.kind === 'select') {
      expect(variant.choices.map((c) => c.value)).toEqual(['default', 'minimal', 'low', 'high', 'max']);
    }
    const agent = opencode.find((d) => d.key === 'agent');
    expect(agent?.kind).toBe('text');
    if (agent?.kind === 'text') {
      expect(agent.maxLength).toBe(64);
    }
  });

  it('returns descriptors for kimi permissionMode including auto', () => {
    const descs = promptOptionsFor('kimi');
    expect(descs.map((d) => d.key)).toEqual(['permissionMode']);
    const permissionMode = descs.find((d) => d.key === 'permissionMode');
    expect(permissionMode?.kind).toBe('select');
    if (permissionMode?.kind === 'select') {
      expect(permissionMode.choices.map((c) => c.value)).toEqual([
        'default', 'default-strict', 'yolo', 'auto',
      ]);
    }
    expect(descs.some((d) => d.key === 'plan')).toBe(false);
  });

  it('returns descriptors for kiro effort and trustAllTools', () => {
    const descs = promptOptionsFor('kiro');
    expect(descs.map((d) => d.key)).toEqual(['effort', 'trustAllTools']);
    const effort = descs.find((d) => d.key === 'effort');
    expect(effort?.kind).toBe('select');
    if (effort?.kind === 'select') {
      expect(effort.choices.map((c) => c.value)).toEqual([
        'default', 'low', 'medium', 'high', 'xhigh', 'max',
      ]);
    }
    const trustAllTools = descs.find((d) => d.key === 'trustAllTools');
    expect(trustAllTools?.kind).toBe('toggle');
    expect(descs.some((d) => d.key === 'agentEngine')).toBe(false);
  });

  it('returns descriptors for hermes yolo toggle only', () => {
    const descs = promptOptionsFor('hermes');
    expect(descs.map((d) => d.key)).toEqual(['yolo']);
    const yolo = descs.find((d) => d.key === 'yolo');
    expect(yolo?.kind).toBe('toggle');
    expect(descs.some((d) => d.key === 'toolsets')).toBe(false);
  });

  it('returns descriptors for pi thinking and toolsProfile', () => {
    const descs = promptOptionsFor('pi');
    expect(descs.map((d) => d.key)).toEqual(['thinking', 'toolsProfile']);
    const thinking = descs.find((d) => d.key === 'thinking');
    expect(thinking?.kind).toBe('select');
    if (thinking?.kind === 'select') {
      expect(thinking.choices.map((c) => c.value)).toEqual([
        'default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
      ]);
    }
    const toolsProfile = descs.find((d) => d.key === 'toolsProfile');
    expect(toolsProfile?.kind).toBe('select');
    if (toolsProfile?.kind === 'select') {
      expect(toolsProfile.choices.map((c) => c.value)).toEqual(['default', 'readOnly', 'none']);
    }
  });

  it('returns claude-code descriptors for family base plus restricted and safeMode', () => {
    const descs = promptOptionsFor('claude-code');
    expect(descs.map((d) => d.key)).toEqual([
      'jsonSchema', 'disableSlashCommands', 'maxTurns', 'permissionMode', 'restricted', 'safeMode',
    ]);
    expect(descs.some((d) => d.key === 'sandbox')).toBe(false);
    const permissionMode = descs.find((d) => d.key === 'permissionMode');
    expect(permissionMode?.kind).toBe('select');
    if (permissionMode?.kind === 'select') {
      expect(permissionMode.choices.map((c) => c.value)).toEqual([
        'default', 'manual', 'acceptEdits', 'plan', 'dontAsk',
      ]);
    }
  });

  it('returns descriptors for deepseek reasoningEffort', () => {
    const descs = promptOptionsFor('deepseek');
    expect(descs.map((d) => d.key)).toEqual(['reasoningEffort']);
    const reasoningEffort = descs.find((d) => d.key === 'reasoningEffort');
    expect(reasoningEffort?.kind).toBe('select');
    if (reasoningEffort?.kind === 'select') {
      expect(reasoningEffort.choices.map((c) => c.value)).toEqual(['default', 'low', 'high', 'max']);
    }
  });

  it('returns empty array for unknown or null agent', () => {
    expect(promptOptionsFor('unknown')).toEqual([]);
    expect(promptOptionsFor(null)).toEqual([]);
    expect(promptOptionsFor(undefined)).toEqual([]);
  });
});

describe('promptOptionsFootnote', () => {
  it('returns adapter-specific footnotes', () => {
    expect(promptOptionsFootnote('antigravity')).toContain('agy');
    expect(promptOptionsFootnote('cursor')).toContain('fresh process');
    expect(promptOptionsFootnote('copilot')).toContain('fresh process');
    expect(promptOptionsFootnote('opencode')).toBe(promptOptionsFootnote('kilocode'));
    expect(promptOptionsFootnote('opencode')).toContain('fresh process');
    expect(promptOptionsFootnote('openclaw')).toContain('fresh process');
    expect(promptOptionsFootnote('qwen')).toContain('next prompt');
    expect(promptOptionsFootnote('qwen')).toContain('ACP session persists');
    expect(promptOptionsFootnote('grok-build')).toContain('set_model');
    expect(promptOptionsFootnote('grok-build')).toMatch(/sandbox/i);
    expect(promptOptionsFootnote('claude-code')).toMatch(/restricted|safe-mode/i);
    expect(promptOptionsFootnote('codex')).toContain('thread');
    expect(promptOptionsFootnote('codex')).toMatch(/sandbox/i);
    expect(promptOptionsFootnote('pi')).toMatch(/restart/i);
    expect(promptOptionsFootnote('pi')).toMatch(/native session/i);
    expect(promptOptionsFootnote('kimi')).toContain('next prompt');
    expect(promptOptionsFootnote('kimi')).toContain('ACP session persists');
    expect(promptOptionsFootnote('kiro')).toMatch(/effort/i);
    expect(promptOptionsFootnote('kiro')).toMatch(/restart/i);
    expect(promptOptionsFootnote('hermes')).toMatch(/yolo/i);
    expect(promptOptionsFootnote('hermes')).toMatch(/restart/i);
    expect(promptOptionsFootnote('claude-code')).toMatch(/query|resume/i);
    expect(promptOptionsFootnote('deepseek')).toMatch(/initialize/i);
    expect(promptOptionsFootnote('deepseek')).toMatch(/restart/i);
  });
});

describe('sanitisePromptOptions', () => {
  it('returns undefined for empty, undefined, or null input', () => {
    expect(sanitisePromptOptions('antigravity', undefined)).toBeUndefined();
    expect(sanitisePromptOptions('antigravity', null)).toBeUndefined();
    expect(sanitisePromptOptions('antigravity', {})).toBeUndefined();
  });

  it('returns undefined for unsupported agent type', () => {
    expect(sanitisePromptOptions('grok-bot', { mode: 'plan' })).toBeUndefined();
  });

  it('drops unknown keys silently', () => {
    const res = sanitisePromptOptions('antigravity', { bogusKey: 'hello', sandbox: true });
    expect(res).toEqual({ sandbox: true });
  });

  it('drops neutral default select choice', () => {
    const res = sanitisePromptOptions('antigravity', { mode: 'default' });
    expect(res).toBeUndefined();
  });

  it('keeps valid non-default select choice', () => {
    expect(sanitisePromptOptions('antigravity', { mode: 'plan' })).toEqual({ mode: 'plan' });
    expect(sanitisePromptOptions('antigravity', { mode: 'accept-edits' })).toEqual({ mode: 'accept-edits' });
  });

  it('drops invalid select choice', () => {
    expect(sanitisePromptOptions('antigravity', { mode: 'destroy-everything' })).toBeUndefined();
  });

  it('drops toggle: false and wrong toggle type', () => {
    expect(sanitisePromptOptions('antigravity', { sandbox: false })).toBeUndefined();
    expect(sanitisePromptOptions('antigravity', { sandbox: 'true' as any })).toBeUndefined();
  });

  it('keeps toggle: true', () => {
    expect(sanitisePromptOptions('antigravity', { sandbox: true })).toEqual({ sandbox: true });
  });

  it('drops empty or whitespace text', () => {
    expect(sanitisePromptOptions('antigravity', { jsonSchema: '' })).toBeUndefined();
    expect(sanitisePromptOptions('antigravity', { jsonSchema: '   \n  ' })).toBeUndefined();
  });

  it('throws PromptOptionError for known descriptor values starting with -', () => {
    expect(() => sanitisePromptOptions('antigravity', { jsonSchema: '--flag' })).toThrow(PromptOptionError);
    expect(() => sanitisePromptOptions('antigravity', { mode: '-p' })).toThrow(PromptOptionError);
    // Unknown keys are version-skew and must be silently dropped, not throw
    expect(sanitisePromptOptions('antigravity', { unknownKey: ' -malicious' })).toBeUndefined();
    // Non-supporting agents drop all options silently without throwing
    expect(sanitisePromptOptions('grok-bot', { jsonSchema: '-x' })).toBeUndefined();
  });

  it('validates jsonSchema as valid JSON object', () => {
    const valid = JSON.stringify({ type: 'object', properties: { foo: { type: 'string' } } });
    expect(sanitisePromptOptions('antigravity', { jsonSchema: valid })).toEqual({ jsonSchema: valid });

    // Invalid JSON
    expect(() => sanitisePromptOptions('antigravity', { jsonSchema: 'not json' })).toThrow(PromptOptionError);

    // JSON array is rejected (schema must be an object)
    expect(() => sanitisePromptOptions('antigravity', { jsonSchema: '[1, 2, 3]' })).toThrow(PromptOptionError);

    // JSON primitive is rejected
    expect(() => sanitisePromptOptions('antigravity', { jsonSchema: '"just a string"' })).toThrow(PromptOptionError);
  });

  it('throws on text exceeding maxLength', () => {
    const huge = 'a'.repeat(9000);
    expect(() => sanitisePromptOptions('antigravity', { jsonSchema: huge })).toThrow(PromptOptionError);
  });

  it('sanitises cursor mode and sandbox selects', () => {
    expect(sanitisePromptOptions('cursor', { mode: 'ask' })).toEqual({ mode: 'ask' });
    expect(sanitisePromptOptions('cursor', { sandbox: 'enabled' })).toEqual({ sandbox: 'enabled' });
    expect(sanitisePromptOptions('cursor', { mode: 'default', sandbox: 'default' })).toBeUndefined();
  });

  it('sanitises cursor autoReview toggle', () => {
    expect(sanitisePromptOptions('cursor', { autoReview: true })).toEqual({ autoReview: true });
    expect(sanitisePromptOptions('cursor', { autoReview: false })).toBeUndefined();
  });

  it('sanitises copilot mode, effort, toolsPolicy, and assistedApproval', () => {
    expect(sanitisePromptOptions('copilot', {
      mode: 'plan',
      effort: 'high',
      toolsPolicy: 'readOnly',
      assistedApproval: true,
    })).toEqual({
      mode: 'plan',
      effort: 'high',
      toolsPolicy: 'readOnly',
      assistedApproval: true,
    });
    expect(sanitisePromptOptions('copilot', { mode: 'autopilot' })).toEqual({ mode: 'autopilot' });
  });

  it('sanitises opencode and kilocode variant, thinking, pure, and agent', () => {
    const staged = {
      variant: 'high',
      thinking: true,
      pure: true,
      agent: 'build',
    };
    expect(sanitisePromptOptions('opencode', staged)).toEqual(staged);
    expect(sanitisePromptOptions('kilocode', staged)).toEqual(staged);
    expect(sanitisePromptOptions('opencode', { variant: 'minimal' })).toEqual({ variant: 'minimal' });
    expect(sanitisePromptOptions('kilocode', { variant: 'max' })).toEqual({ variant: 'max' });
  });

  it('drops opencode/kilocode neutral defaults and empty agent', () => {
    expect(sanitisePromptOptions('opencode', {
      variant: 'default',
      thinking: false,
      pure: false,
      agent: '   ',
    })).toBeUndefined();
    expect(sanitisePromptOptions('kilocode', { variant: 'default' })).toBeUndefined();
  });

  it('throws when opencode agent exceeds maxLength', () => {
    const huge = 'a'.repeat(65);
    expect(() => sanitisePromptOptions('opencode', { agent: huge })).toThrow(PromptOptionError);
    expect(() => sanitisePromptOptions('kilocode', { agent: huge })).toThrow(PromptOptionError);
  });

  it('sanitises openclaw thinking and timeout selects', () => {
    expect(sanitisePromptOptions('openclaw', { thinking: 'high', timeout: '300' })).toEqual({
      thinking: 'high',
      timeout: '300',
    });
    expect(sanitisePromptOptions('openclaw', { thinking: 'off' })).toEqual({ thinking: 'off' });
    expect(sanitisePromptOptions('openclaw', { timeout: '1800' })).toEqual({ timeout: '1800' });
    expect(sanitisePromptOptions('openclaw', { thinking: 'xhigh' })).toBeUndefined();
  });

  it('drops openclaw neutral defaults', () => {
    expect(sanitisePromptOptions('openclaw', { thinking: 'default', timeout: 'default' })).toBeUndefined();
  });

  it('validates claude-code jsonSchema as a JSON object', () => {
    expect(() => sanitisePromptOptions('claude-code', { jsonSchema: 'not json' })).toThrow(PromptOptionError);
    expect(() => sanitisePromptOptions('claude-code', { jsonSchema: '[1]' })).toThrow(PromptOptionError);
  });

  it('sanitises qwen permissionMode selects', () => {
    expect(sanitisePromptOptions('qwen', { permissionMode: 'yolo' })).toEqual({
      permissionMode: 'yolo',
    });
    expect(sanitisePromptOptions('qwen', { permissionMode: 'default-strict' })).toEqual({
      permissionMode: 'default-strict',
    });
    expect(sanitisePromptOptions('qwen', { permissionMode: 'ask' })).toBeUndefined();
  });

  it('drops qwen conversation-default permissionMode and keeps sandbox toggle', () => {
    expect(sanitisePromptOptions('qwen', { permissionMode: 'default' })).toBeUndefined();
    expect(sanitisePromptOptions('qwen', { safeMode: true })).toBeUndefined();
    expect(sanitisePromptOptions('qwen', { sandbox: true })).toEqual({ sandbox: true });
  });

  it('sanitises grok-build reasoningEffort and yoloMode selects', () => {
    expect(sanitisePromptOptions('grok-build', {
      reasoningEffort: 'high',
      yoloMode: 'off',
    })).toEqual({
      reasoningEffort: 'high',
      yoloMode: 'off',
    });
    expect(sanitisePromptOptions('grok-build', { reasoningEffort: 'low' })).toEqual({ reasoningEffort: 'low' });
    expect(sanitisePromptOptions('grok-build', { yoloMode: 'on' })).toEqual({ yoloMode: 'on' });
    expect(sanitisePromptOptions('grok-build', { reasoningEffort: 'xhigh' })).toEqual({ reasoningEffort: 'xhigh' });
    expect(sanitisePromptOptions('grok-build', { sandbox: 'workspace' })).toEqual({ sandbox: 'workspace' });
    expect(sanitisePromptOptions('grok-build', { sandbox: 'devbox' })).toBeUndefined();
  });

  it('drops grok-build neutral defaults', () => {
    expect(sanitisePromptOptions('grok-build', {
      sandbox: 'default',
      reasoningEffort: 'default',
      yoloMode: 'default',
    })).toBeUndefined();
  });

  it('sanitises codex sandbox selects', () => {
    expect(sanitisePromptOptions('codex', { sandbox: 'read-only' })).toEqual({ sandbox: 'read-only' });
    expect(sanitisePromptOptions('codex', { sandbox: 'danger-full-access' })).toEqual({
      sandbox: 'danger-full-access',
    });
    expect(sanitisePromptOptions('codex', { sandbox: 'workspace-write' })).toBeUndefined();
  });

  it('drops codex neutral default sandbox and unexposed knobs', () => {
    expect(sanitisePromptOptions('codex', { sandbox: 'default' })).toBeUndefined();
    expect(sanitisePromptOptions('codex', { approvalPolicy: 'never', outputSchema: '{}' })).toBeUndefined();
  });

  it('sanitises pi thinking and toolsProfile selects', () => {
    expect(sanitisePromptOptions('pi', { thinking: 'high', toolsProfile: 'readOnly' })).toEqual({
      thinking: 'high',
      toolsProfile: 'readOnly',
    });
    expect(sanitisePromptOptions('pi', { thinking: 'off' })).toEqual({ thinking: 'off' });
    expect(sanitisePromptOptions('pi', { thinking: 'minimal' })).toEqual({ thinking: 'minimal' });
    expect(sanitisePromptOptions('pi', { toolsProfile: 'none' })).toEqual({ toolsProfile: 'none' });
    expect(sanitisePromptOptions('pi', { thinking: 'xhigh' })).toEqual({ thinking: 'xhigh' });
  });

  it('drops pi neutral defaults', () => {
    expect(sanitisePromptOptions('pi', { thinking: 'default', toolsProfile: 'default' })).toBeUndefined();
  });

  it('sanitises kimi permissionMode selects including auto', () => {
    expect(sanitisePromptOptions('kimi', { permissionMode: 'yolo' })).toEqual({
      permissionMode: 'yolo',
    });
    expect(sanitisePromptOptions('kimi', { permissionMode: 'default-strict' })).toEqual({
      permissionMode: 'default-strict',
    });
    expect(sanitisePromptOptions('kimi', { permissionMode: 'auto' })).toEqual({
      permissionMode: 'auto',
    });
    expect(sanitisePromptOptions('kimi', { permissionMode: 'plan' })).toBeUndefined();
  });

  it('drops kimi conversation-default permissionMode and unexposed knobs', () => {
    expect(sanitisePromptOptions('kimi', { permissionMode: 'default' })).toBeUndefined();
    expect(sanitisePromptOptions('kimi', { plan: true })).toBeUndefined();
  });

  it('sanitises kiro effort selects', () => {
    expect(sanitisePromptOptions('kiro', { effort: 'high' })).toEqual({ effort: 'high' });
    expect(sanitisePromptOptions('kiro', { effort: 'xhigh' })).toEqual({ effort: 'xhigh' });
    expect(sanitisePromptOptions('kiro', { effort: 'max' })).toEqual({ effort: 'max' });
    expect(sanitisePromptOptions('kiro', { effort: 'ultra' })).toBeUndefined();
  });

  it('drops kiro neutral default effort and keeps trustAllTools', () => {
    expect(sanitisePromptOptions('kiro', { effort: 'default' })).toBeUndefined();
    expect(sanitisePromptOptions('kiro', { agentEngine: 'v3' })).toBeUndefined();
    expect(sanitisePromptOptions('kiro', { trustAllTools: true })).toEqual({ trustAllTools: true });
  });

  it('rejects escalating permissionMode values for claude-code', () => {
    expect(sanitisePromptOptions('claude-code', { permissionMode: 'bypassPermissions' })).toBeUndefined();
    expect(sanitisePromptOptions('claude-code', { permissionMode: 'fullAccess' })).toBeUndefined();
    expect(sanitisePromptOptions('claude-code', { permissionMode: 'manual' })).toEqual({ permissionMode: 'manual' });
  });

  it('sanitises hermes yolo toggle', () => {
    expect(sanitisePromptOptions('hermes', { yolo: true })).toEqual({ yolo: true });
    expect(sanitisePromptOptions('hermes', { yolo: false })).toBeUndefined();
    expect(sanitisePromptOptions('hermes', { toolsets: 'coding,web' })).toBeUndefined();
  });

  it('drops copilot neutral defaults', () => {
    expect(sanitisePromptOptions('copilot', {
      mode: 'default',
      effort: 'default',
      toolsPolicy: 'default',
      assistedApproval: false,
    })).toBeUndefined();
  });

  it('sanitises claude-code jsonSchema, disableSlashCommands, and maxTurns', () => {
    const schema = JSON.stringify({ type: 'object', properties: { foo: { type: 'string' } } });
    expect(sanitisePromptOptions('claude-code', {
      jsonSchema: schema,
      disableSlashCommands: true,
      maxTurns: '3',
    })).toEqual({
      jsonSchema: schema,
      disableSlashCommands: true,
      maxTurns: '3',
    });
    expect(sanitisePromptOptions('claude-code', { maxTurns: '10' })).toEqual({ maxTurns: '10' });
    expect(sanitisePromptOptions('claude-code', { maxTurns: '99' })).toBeUndefined();
  });

  it('drops claude-code neutral defaults', () => {
    expect(sanitisePromptOptions('claude-code', {
      jsonSchema: '   ',
      disableSlashCommands: false,
      maxTurns: 'default',
    })).toBeUndefined();
  });

  it('sanitises deepseek reasoningEffort selects', () => {
    expect(sanitisePromptOptions('deepseek', { reasoningEffort: 'high' })).toEqual({
      reasoningEffort: 'high',
    });
    expect(sanitisePromptOptions('deepseek', { reasoningEffort: 'low' })).toEqual({
      reasoningEffort: 'low',
    });
    expect(sanitisePromptOptions('deepseek', { reasoningEffort: 'max' })).toEqual({
      reasoningEffort: 'max',
    });
    expect(sanitisePromptOptions('deepseek', { reasoningEffort: 'medium' })).toBeUndefined();
    expect(sanitisePromptOptions('deepseek', { reasoningEffort: 'xhigh' })).toBeUndefined();
  });

  it('drops deepseek neutral default reasoningEffort', () => {
    expect(sanitisePromptOptions('deepseek', { reasoningEffort: 'default' })).toBeUndefined();
  });
});

describe('promptOptionsEqual', () => {
  it('treats undefined, null, and empty bags as equal', () => {
    expect(promptOptionsEqual(undefined, {})).toBe(true);
    expect(promptOptionsEqual({}, null)).toBe(true);
    expect(promptOptionsEqual(undefined, null)).toBe(true);
    expect(promptOptionsEqual({}, {})).toBe(true);
  });

  it('compares values with === and ignores key order', () => {
    expect(promptOptionsEqual({ a: '1' }, { a: '1' })).toBe(true);
    expect(promptOptionsEqual({ a: '1', b: true }, { b: true, a: '1' })).toBe(true);
    expect(promptOptionsEqual({ a: '1' }, { a: '2' })).toBe(false);
    expect(promptOptionsEqual({ a: '1' }, { a: '1', b: true })).toBe(false);
  });
});

describe('stripCommandIncompatibleOptions', () => {
  it('strips disableSlashCommands on slash commands', () => {
    const opts = { sandbox: true, disableSlashCommands: true };
    expect(stripCommandIncompatibleOptions(opts)).toEqual({ sandbox: true });
  });

  it('returns undefined if only disableSlashCommands was present', () => {
    expect(stripCommandIncompatibleOptions({ disableSlashCommands: true })).toBeUndefined();
  });

  it('handles null and undefined', () => {
    expect(stripCommandIncompatibleOptions(undefined)).toBeUndefined();
    expect(stripCommandIncompatibleOptions(null)).toBeUndefined();
  });
});
