import { describe, it, expect } from 'vitest';
import {
  resolveVoicePrompt,
  ttsSummarizeConfigured,
  BUILTIN_VOICE_PROMPTS,
  BUILTIN_TTS_PROMPTS,
  SIDECAR_BUILTIN_TTS_CODE_PROMPTS,
  DEFAULT_VOICE_CLEANUP_PROMPT,
  DEFAULT_TTS_SUMMARIZE_PROMPT,
  DEFAULT_TTS_CODE_SUMMARIZE_PROMPT,
  defaultVoiceProviderValues,
  type VoiceCleanupSettings,
} from '@tierwyn/shared';

const base: VoiceCleanupSettings = {
  enabled: true,
  provider: 'lmstudio',
  providerValues: defaultVoiceProviderValues(),
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  model: 'x',
  systemPrompt: 'LEGACY PROMPT',
  timeoutSecs: 20,
  selectedPromptId: 'builtin-1',
  prompts: [{ id: 'c1', name: 'Mine', text: 'CUSTOM PROMPT' }],
};

describe('resolveVoicePrompt', () => {
  it('resolves builtin-1 to the default prompt', () => {
    expect(resolveVoicePrompt({ ...base, selectedPromptId: 'builtin-1' }))
      .toBe(DEFAULT_VOICE_CLEANUP_PROMPT);
  });

  it('resolves a custom prompt id from the prompts array', () => {
    expect(resolveVoicePrompt({ ...base, selectedPromptId: 'c1' }))
      .toBe('CUSTOM PROMPT');
  });

  it('honours an explicit per-request promptId over the selected one', () => {
    expect(resolveVoicePrompt({ ...base, selectedPromptId: 'builtin-1' }, 'c1'))
      .toBe('CUSTOM PROMPT');
  });

  it('falls back to legacy systemPrompt when the id is unknown', () => {
    expect(resolveVoicePrompt({ ...base, selectedPromptId: 'ghost' }))
      .toBe('LEGACY PROMPT');
  });

  it('exposes exactly two builtins', () => {
    expect(BUILTIN_VOICE_PROMPTS.map((p) => p.id)).toEqual(['builtin-1', 'builtin-2']);
  });
});

describe('tts builtins', () => {
  it('default summarize prompt guides hyphenated identifiers to spoken forms', () => {
    expect(DEFAULT_TTS_SUMMARIZE_PROMPT).toMatch(/hyphen/i);
  });

  it('exposes the spoken-summarize builtin', () => {
    expect(BUILTIN_TTS_PROMPTS.map((p) => p.id)).toEqual(['tts-builtin-1']);
  });

  it('exposes the code-file summarize builtin', () => {
    expect(SIDECAR_BUILTIN_TTS_CODE_PROMPTS.map((p) => p.id)).toEqual(['tts-code-builtin-1']);
    expect(SIDECAR_BUILTIN_TTS_CODE_PROMPTS[0]!.text).toBe(DEFAULT_TTS_CODE_SUMMARIZE_PROMPT);
  });
});

describe('ttsSummarizeConfigured', () => {
  it('is false when model is empty', () => {
    expect(ttsSummarizeConfigured({ ...base, model: '' })).toBe(false);
  });

  it('is true for lmstudio with baseUrl + model (ignores enabled)', () => {
    expect(ttsSummarizeConfigured({ ...base, enabled: false, model: 'x', baseUrl: 'http://localhost:1234/v1' })).toBe(true);
  });

  it('is true for gemini with apiKey + model', () => {
    expect(ttsSummarizeConfigured({
      ...base,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'k',
      baseUrl: '',
    })).toBe(true);
  });
});
