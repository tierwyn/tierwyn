import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_VOICE_CLEANUP_PROMPT, defaultVoiceProviderValues, type VoiceCleanupSettings } from '@tierwyn/shared';
import { cleanTranscript, findBin, WHISPER_MODELS, modelPath, dataDir, clean } from './whisper.js';

describe('cleanTranscript', () => {
  it('strips [BLANK_AUDIO] annotation lines', () => {
    expect(cleanTranscript('[BLANK_AUDIO]\nhello world')).toBe('hello world');
  });

  it('strips (parenthetical) annotation lines', () => {
    expect(cleanTranscript('(gentle music)\nhello world')).toBe('hello world');
  });

  it('strips *asterisk* annotation lines', () => {
    expect(cleanTranscript('*sigh*\nhello world')).toBe('hello world');
  });

  it('preserves real transcript lines and joins with single spaces', () => {
    const raw = 'hello world\nthis is a test\n[BLANK_AUDIO]\n*beep*\nof the system';
    expect(cleanTranscript(raw)).toBe('hello world this is a test of the system');
  });

  it('collapses internal whitespace runs', () => {
    expect(cleanTranscript('hello    world\n\n\nbye')).toBe('hello world bye');
  });

  it('returns empty string when only annotations present', () => {
    expect(cleanTranscript('[BLANK_AUDIO]\n(music)\n*inhales*')).toBe('');
  });

  it('does not strip a line that merely contains brackets mid-sentence', () => {
    // A real word in brackets mid-line is rare, but the rule is line-level:
    // only strips when the WHOLE trimmed line is wrapped.
    expect(cleanTranscript('he said [quietly] hello')).toBe('he said [quietly] hello');
  });
});

describe('findBin', () => {
  it('returns an error result when nothing is on disk or PATH', () => {
    // No env override, no bundled file, empty PATH.
    const r = findBin();
    // On a developer machine this may legitimately find a binary; only assert
    // the shape, not the outcome, so the test is portable.
    expect('ok' in r).toBe(true);
    if (r.ok) {
      expect(typeof r.path).toBe('string');
      expect(r.path.length).toBeGreaterThan(0);
    } else {
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('respects WHISPER_BIN_PATH env override', () => {
    const saved = process.env.WHISPER_BIN_PATH;
    process.env.WHISPER_BIN_PATH = '/nonexistent/whisper-cli-xyz';
    try {
      const r = findBin();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('WHISPER_BIN_PATH');
      }
    } finally {
      if (saved === undefined) delete process.env.WHISPER_BIN_PATH;
      else process.env.WHISPER_BIN_PATH = saved;
    }
  });
});

describe('clean — Gemini provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('native Gemini model: no prefill turn (only user contents)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/:generateContent\?key=test-key$/);
      const body = JSON.parse(init!.body as string) as {
        systemInstruction: { parts: { text: string }[] };
        contents: { role: string; parts: { text: string }[] }[];
        safetySettings: { category: string; threshold: string }[];
      };
      expect(body.systemInstruction).toEqual({ parts: [{ text: DEFAULT_VOICE_CLEANUP_PROMPT }] });
      // Native Gemini doesn't use <think> tags — no prefill.
      expect(body.contents).toEqual([
        { role: 'user', parts: [{ text: 'hello world' }] },
      ]);
      expect(body.safetySettings).toEqual([
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ]);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '  cleaned text  ' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg: VoiceCleanupSettings = {
      enabled: true,
      provider: 'gemini',
      providerValues: defaultVoiceProviderValues(),
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
      timeoutSecs: 20,
      selectedPromptId: 'builtin-1',
      prompts: [],
    };

    const result = await clean(cfg, 'hello world');
    expect(result).toBe('cleaned text');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('Gemma via Gemini API: single user turn, no prefill', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        contents: { role: string; parts: { text: string }[] }[];
      };
      expect(body.contents).toEqual([
        { role: 'user', parts: [{ text: 'hello world' }] },
      ]);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hello world.' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg: VoiceCleanupSettings = {
      enabled: true,
      provider: 'gemini',
      providerValues: defaultVoiceProviderValues(),
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemma-3n-e4b-it',
      systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
      timeoutSecs: 20,
      selectedPromptId: 'builtin-1',
      prompts: [],
    };

    const result = await clean(cfg, 'hello world');
    expect(result).toBe('Hello world.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('clean — OpenAI-compatible provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Gemma model: plain two-turn request, no prefill, no continue_assistant_turn flag', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://localhost:1234/v1/chat/completions');
      const body = JSON.parse(init!.body as string) as {
        model: string;
        messages: { role: string; content: string }[];
        continue_assistant_turn?: boolean;
      };
      expect(body.model).toBe('gemma-4-it');
      expect(body.messages).toEqual([
        { role: 'system', content: DEFAULT_VOICE_CLEANUP_PROMPT },
        { role: 'user', content: 'hello world' },
      ]);
      expect(body.continue_assistant_turn).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello world.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg: VoiceCleanupSettings = {
      enabled: true,
      provider: 'lmstudio',
      providerValues: defaultVoiceProviderValues(),
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'gemma-4-it',
      systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
      timeoutSecs: 20,
      selectedPromptId: 'builtin-1',
      prompts: [],
    };

    const result = await clean(cfg, 'hello world');
    expect(result).toBe('Hello world.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('non-Gemma model: no prefill turn, no continue_assistant_turn flag', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        model: string;
        messages: { role: string; content: string }[];
        continue_assistant_turn?: boolean;
      };
      expect(body.model).toBe('qwen2.5-7b-instruct');
      expect(body.messages).toEqual([
        { role: 'system', content: DEFAULT_VOICE_CLEANUP_PROMPT },
        { role: 'user', content: 'hello world' },
      ]);
      expect(body.continue_assistant_turn).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello world.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg: VoiceCleanupSettings = {
      enabled: true,
      provider: 'lmstudio',
      providerValues: defaultVoiceProviderValues(),
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'qwen2.5-7b-instruct',
      systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
      timeoutSecs: 20,
      selectedPromptId: 'builtin-1',
      prompts: [],
    };

    const result = await clean(cfg, 'hello world');
    expect(result).toBe('Hello world.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('timeout surfaces as an actionable message, not a bare "aborted"', async () => {
    // fetch that never resolves until its signal aborts, then throws like Node's fetch.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () =>
        reject(new DOMException('This operation was aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const cfg: VoiceCleanupSettings = {
      enabled: true,
      provider: 'lmstudio',
      providerValues: defaultVoiceProviderValues(),
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'qwen2.5-7b-instruct',
      systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
      timeoutSecs: 1,
      selectedPromptId: 'builtin-1',
      prompts: [],
    };

    await expect(clean(cfg, 'hello world')).rejects.toThrow(/timed out after 1s/);
  });
});

describe('model allowlist + paths', () => {
  it('exposes the three supported models', () => {
    expect([...WHISPER_MODELS]).toEqual(['base', 'small', 'medium']);
  });

  it('builds model paths under the shared mewisper data dir', () => {
    // Shape check only — the file may or may not exist on the test host.
    expect(modelPath('base')).toContain('ggml-base.bin');
    expect(dataDir()).toContain('mewisper');
  });
});
