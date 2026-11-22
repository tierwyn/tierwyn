import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  codeSpeakNotice,
  collectMessageChunksFromIndex,
  countLines,
  explainDiffAvailable,
  joinSpeakChunks,
  languageLabel,
  spawnResultSpeakText,
  speakable,
  type SpeakScopeItem,
} from './speak.js';

describe('codeSpeakNotice', () => {
  it('formats TypeScript with plural lines', () => {
    expect(codeSpeakNotice('ts', 240)).toBe('TypeScript file, 240 lines');
  });

  it('uses singular for one line', () => {
    expect(codeSpeakNotice('py', 1)).toBe('Python file, 1 line');
  });

  it('uppercases unknown extensions', () => {
    expect(codeSpeakNotice('xyz', 3)).toBe('XYZ file, 3 lines');
  });

  it('countLines ignores a trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });

  it('languageLabel maps common aliases', () => {
    expect(languageLabel('tsx')).toBe('TypeScript');
    expect(languageLabel('yml')).toBe('YAML');
  });
});

describe('collectMessageChunksFromIndex', () => {
  // Spec: A(tool) B(msg) C(tool) D(msg) E(msg) → from B = B+D+E; from D = D+E
  const items: SpeakScopeItem[] = [
    { type: 'tool_call', chunk: '' },
    { type: 'message', chunk: 'B' },
    { type: 'tool_result', chunk: '' },
    { type: 'message', chunk: 'D' },
    { type: 'message', chunk: 'E' },
  ];

  it('from B collects B, D, E (skips tools)', () => {
    expect(collectMessageChunksFromIndex(items, 1)).toEqual(['B', 'D', 'E']);
  });

  it('from D collects D, E', () => {
    expect(collectMessageChunksFromIndex(items, 3)).toEqual(['D', 'E']);
  });

  it('from a tool index still starts there and skips non-messages', () => {
    expect(collectMessageChunksFromIndex(items, 0)).toEqual(['B', 'D', 'E']);
    expect(collectMessageChunksFromIndex(items, 2)).toEqual(['D', 'E']);
  });

  it('excludes non-result spawn marker messages', () => {
    const withSpawn: SpeakScopeItem[] = [
      { type: 'message', chunk: 'hello' },
      { type: 'message', chunk: 'spawn text', isSpawnMarker: true, spawnKind: 'spawned' },
      { type: 'message', chunk: 'world' },
    ];
    expect(collectMessageChunksFromIndex(withSpawn, 0)).toEqual(['hello', 'world']);
  });

  it('excludes spawn markers without spawnKind (legacy)', () => {
    const withSpawn: SpeakScopeItem[] = [
      { type: 'message', chunk: 'hello' },
      { type: 'message', chunk: 'spawn text', isSpawnMarker: true },
      { type: 'message', chunk: 'world' },
    ];
    expect(collectMessageChunksFromIndex(withSpawn, 0)).toEqual(['hello', 'world']);
  });

  it('includes spawn result markers', () => {
    const withResult: SpeakScopeItem[] = [
      { type: 'message', chunk: 'hello' },
      {
        type: 'message',
        chunk: 'child finished',
        isSpawnMarker: true,
        spawnKind: 'result',
      },
      { type: 'message', chunk: 'world' },
    ];
    expect(collectMessageChunksFromIndex(withResult, 0)).toEqual([
      'hello',
      'child finished',
      'world',
    ]);
  });

  it('includes prompts and results; skips tools; no subagent_notify duplicate', () => {
    // Flat index as built by OutputPane: prompt → tool → message → result → message.
    // subagent_notify prompts are omitted from the index (Result card is SoT).
    const mixed: SpeakScopeItem[] = [
      { type: 'prompt', chunk: 'user asks', role: 'user' },
      { type: 'tool_call', chunk: '' },
      { type: 'message', chunk: 'agent replies', role: 'agent' },
      {
        type: 'message',
        chunk: 'subagent did the work',
        isSpawnMarker: true,
        spawnKind: 'result',
        role: 'subagent',
      },
      { type: 'message', chunk: 'agent continues', role: 'agent' },
    ];
    expect(collectMessageChunksFromIndex(mixed, 0)).toEqual([
      'User: user asks',
      'Agent: agent replies',
      'Subagent: subagent did the work',
      'Agent: agent continues',
    ]);
    // From first agent message through end
    expect(collectMessageChunksFromIndex(mixed, 2)).toEqual([
      'Agent: agent replies',
      'Subagent: subagent did the work',
      'Agent: agent continues',
    ]);
  });

  it('prefixes roles when present; leaves unprefixed without role', () => {
    const mixed: SpeakScopeItem[] = [
      { type: 'prompt', chunk: 'q', role: 'user' },
      { type: 'message', chunk: 'a' },
    ];
    expect(collectMessageChunksFromIndex(mixed, 0)).toEqual(['User: q', 'a']);
  });

  it('skips empty message chunks', () => {
    const empty: SpeakScopeItem[] = [
      { type: 'message', chunk: 'a' },
      { type: 'message', chunk: '' },
      { type: 'message', chunk: 'c' },
    ];
    expect(collectMessageChunksFromIndex(empty, 0)).toEqual(['a', 'c']);
  });

  it('returns [] for out-of-range index', () => {
    expect(collectMessageChunksFromIndex(items, -1)).toEqual([]);
    expect(collectMessageChunksFromIndex(items, 99)).toEqual([]);
  });

  it('joinSpeakChunks uses double newlines', () => {
    expect(joinSpeakChunks(['B', 'D', 'E'])).toBe('B\n\nD\n\nE');
    expect(joinSpeakChunks(['', 'x', ''])).toBe('x');
  });

  it('spawnResultSpeakText strips ◀ result: prefix', () => {
    expect(spawnResultSpeakText('◀ result: done\nnext')).toBe('done\nnext');
    expect(spawnResultSpeakText('plain result')).toBe('plain result');
  });

  it('spawnResultSpeakText strips variant prefixes (manual push / follow-up / degenerate / failed)', () => {
    // 2026-11-01: manual-push markers leaked the raw prefix into the result
    // card body, which also broke the leading '## Result' heading parse.
    expect(spawnResultSpeakText('◀ result (manual push): ## Result\nbody')).toBe('## Result\nbody');
    expect(spawnResultSpeakText('◀ result (follow-up): text')).toBe('text');
    expect(spawnResultSpeakText('⚠ ◀ result (degenerate): ok')).toBe('ok');
    expect(spawnResultSpeakText('⚠ ◀ result (follow-up, failed): text')).toBe('text');
  });
});

describe('speakable deep-strip', () => {
  it('strips tool_call blocks', () => {
    expect(speakable('<tool_call>{"name":"x"}</tool_call>').trim()).toBe('');
  });

  it('strips antml:tool_call blocks', () => {
    expect(speakable('<antml:tool_call>data</antml:tool_call>').trim()).toBe('');
  });

  it('announces mermaid fence type as skipped', () => {
    const out = speakable('See flow.\n```mermaid\ngraph TD\nA-->B\n```\nDone.');
    expect(out).toContain('mermaid code block skipped');
    expect(out).not.toMatch(/graph|A-->B|```/);
    expect(out).toMatch(/See flow/);
    expect(out).toMatch(/Done/);
  });

  it('announces json fence type as skipped', () => {
    const out = speakable('Before.\n```json\n{"x":1}\n```\nAfter.');
    expect(out).toContain('json code block skipped');
    expect(out).not.toContain('{"x"');
    expect(out).toMatch(/Before/);
    expect(out).toMatch(/After/);
  });

  it('announces untyped fence as code block skipped', () => {
    const out = speakable('Before.\n```\nplain\n```\nAfter.');
    expect(out).toContain('code block skipped');
    expect(out).not.toContain('plain');
  });

  it('keeps math expression text (only code/tables are skipped)', () => {
    const out = speakable('Area is $$x^2$$ squared.');
    expect(out).toContain('x^2');
    expect(out).not.toContain('(math)');
    expect(out).toMatch(/Area is/);
    expect(out).toMatch(/squared/);
  });

  it('announces GFM tables as skipped', () => {
    const out = speakable(
      'Summary follows.\n\n| Name | Role |\n|------|------|\n| Ada | Lead |\n\nThat is all.',
    );
    expect(out).toContain('table skipped');
    expect(out).not.toMatch(/Name|Role|Ada|Lead/);
    expect(out).toMatch(/Summary follows/);
    expect(out).toMatch(/That is all/);
  });

  it('keeps markdown list item text', () => {
    const out = speakable('Todo:\n- buy milk\n- walk dog\n\n1. first\n2. second');
    expect(out).toContain('buy milk');
    expect(out).toContain('walk dog');
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).not.toContain('skipped');
  });

  it('strips callout markers but keeps body', () => {
    const out = speakable('> [!WARNING]\n> Be careful');
    expect(out).not.toMatch(/WARNING/);
    expect(out).toContain('Be careful');
  });

  it('strips HTML comments', () => {
    expect(speakable('hello <!-- secret --> world')).not.toContain('secret');
  });

  it('replaces bare URLs with (link)', () => {
    const out = speakable('see https://example.com here');
    expect(out).toContain('(link)');
    expect(out).not.toContain('example.com');
    expect(out).toMatch(/see/);
    expect(out).toMatch(/here/);
  });

  it('keeps markdown link labels, drops the URL', () => {
    const out = speakable('Read the [docs](https://example.com/path) please');
    expect(out).toContain('docs');
    expect(out).not.toContain('example.com');
    expect(out).toContain('please');
  });
});

describe('speakChunks and speakSelection', () => {
  let spoken: string[];

  beforeEach(async () => {
    spoken = [];
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      lang = '';
      onend?: () => void;
      onerror?: () => void;
      constructor(text: string) { this.text = text; }
    });
    vi.stubGlobal('navigator', { language: 'en-US' });
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: vi.fn((u: { text: string }) => { spoken.push(u.text); }),
    });
    vi.resetModules();
  });

  it('speakChunks joins chunks with double newlines', async () => {
    const { speakChunks, setTtsConfig } = await import('./speak.js');
    setTtsConfig({ enabled: true, provider: 'browser', piperUrl: '', piperVoice: '', kokoroUrl: '', kokoroVoice: '', selectedPromptId: 'tts-builtin-1', prompts: [], saveRecordings: true });
    await speakChunks(['Hello', 'World']);
    expect(spoken.some((t) => t.includes('Hello') && t.includes('World'))).toBe(true);
  });

  it('speakChunks with empty array is a no-op', async () => {
    const { speakChunks } = await import('./speak.js');
    await speakChunks([]);
    expect(spoken).toHaveLength(0);
  });

  it('speakSelection returns false for whitespace-only selection', async () => {
    const { speakSelection } = await import('./speak.js');
    const ok = await speakSelection({ toString: () => '  ' } as Selection);
    expect(ok).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it('speakSelection returns true and speaks trimmed text', async () => {
    const { speakSelection, setTtsConfig } = await import('./speak.js');
    setTtsConfig({ enabled: true, provider: 'browser', piperUrl: '', piperVoice: '', kokoroUrl: '', kokoroVoice: '', selectedPromptId: 'tts-builtin-1', prompts: [], saveRecordings: true });
    const ok = await speakSelection({ toString: () => 'selected text' } as Selection);
    expect(ok).toBe(true);
    expect(spoken.some((t) => t.includes('selected text'))).toBe(true);
  });

  it('explicit provider override wins over module config (honors B/P/K letter)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['wav'], { type: 'audio/wav' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('Audio', class {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
    });

    const { speak, setTtsConfig } = await import('./speak.js');
    // Module config says browser — UI letter would show K when override is kokoro.
    setTtsConfig({
      enabled: true,
      provider: 'browser',
      piperUrl: '',
      piperVoice: '',
      kokoroUrl: 'http://127.0.0.1:8880',
      kokoroVoice: 'af_heart',
      selectedPromptId: 'tts-builtin-1',
      prompts: [],
      saveRecordings: true,
    });
    await speak('Hello Kokoro', undefined, 'kokoro');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'kokoro', text: 'Hello Kokoro' });
    // Must not have fallen back to browser speechSynthesis.
    expect(spoken).toHaveLength(0);
  });

  it('sidecar failure does not fall back to browser when letter is K', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'sidecar down',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { speak, setTtsConfig } = await import('./speak.js');
    setTtsConfig({
      enabled: true,
      provider: 'kokoro',
      piperUrl: '',
      piperVoice: '',
      kokoroUrl: 'http://127.0.0.1:8880',
      kokoroVoice: 'af_heart',
      selectedPromptId: 'tts-builtin-1',
      prompts: [],
      saveRecordings: true,
    });
    await speak('should not browser', undefined, 'kokoro');
    expect(spoken).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('speakChunks summarize forwards guidance and targetMinutes to /tts/summarize', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Spoken rewrite' }),
    }));
    const { speakChunks, setTtsConfig } = await import('./speak.js');
    setTtsConfig({
      enabled: true,
      provider: 'browser',
      piperUrl: '',
      piperVoice: '',
      kokoroUrl: '',
      kokoroVoice: '',
      selectedPromptId: 'tts-builtin-1',
      prompts: [],
      saveRecordings: true,
    });
    await speakChunks(
      ['Hello', 'World'],
      undefined,
      'browser',
      'summarize',
      undefined,
      { guidance: 'only the API changes', targetMinutes: 5 },
    );
    expect(fetch).toHaveBeenCalledWith(
      '/tts/summarize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'Hello\n\nWorld',
          guidance: 'only the API changes',
          targetMinutes: 5,
        }),
      }),
    );
  });

  it('speakChunks explain-diff forwards opts through the same join path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'The change adds a hello constant.' }),
    }));
    const { speakChunks, setTtsConfig } = await import('./speak.js');
    setTtsConfig({
      enabled: true,
      provider: 'browser',
      piperUrl: '',
      piperVoice: '',
      kokoroUrl: '',
      kokoroVoice: '',
      selectedPromptId: 'tts-builtin-1',
      prompts: [],
      saveRecordings: true,
    });
    const diff = '@@ -1 +1 @@\n+const hello = 1;';
    await speakChunks(
      [diff],
      undefined,
      'browser',
      'explain-diff',
      undefined,
      {
        guidance: 'only the API changes',
        targetMinutes: 5,
        diff,
        filename: 'a.ts',
        diffSource: 'working-tree',
      },
    );
    const [, sumInit] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    const posted = JSON.parse(String(sumInit.body)) as Record<string, unknown>;
    expect(posted.guidance).toBe('only the API changes');
    expect(posted.targetMinutes).toBe(5);
    expect(posted.mode).toBe('explain-diff');
    expect(posted.diff).toBe(diff);
  });
});

const browserTts = {
  enabled: true,
  provider: 'browser' as const,
  piperUrl: '',
  piperVoice: '',
  kokoroUrl: '',
  kokoroVoice: '',
  selectedPromptId: 'tts-builtin-1',
  prompts: [] as { id: string; name: string; text: string }[],
  saveRecordings: true,
};

describe('playWithMode', () => {
  let spoken: string[];

  beforeEach(async () => {
    spoken = [];
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      lang = '';
      onend?: () => void;
      onerror?: () => void;
      constructor(text: string) { this.text = text; }
    });
    vi.stubGlobal('navigator', { language: 'en-US' });
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: vi.fn((u: { text: string }) => { spoken.push(u.text); }),
    });
    vi.resetModules();
  });

  it('as-is stops then speaks speakable text', async () => {
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    await playWithMode('Hello **world**', 'as-is');
    expect(speechSynthesis.cancel).toHaveBeenCalled();
    expect(spoken.some((t) => t.includes('Hello') && t.includes('world'))).toBe(true);
  });

  it('summarize uses LLM text then speakable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Spoken rewrite of the message' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    await playWithMode('# Title\n\nBody', 'summarize');
    expect(fetch).toHaveBeenCalledWith('/tts/summarize', expect.objectContaining({ method: 'POST' }));
    expect(spoken.some((t) => t.includes('Spoken rewrite'))).toBe(true);
  });

  it('summarize failure fails closed — rejects, nothing spoken', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'upstream down' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    await expect(playWithMode('Fallback prose here', 'summarize'))
      .rejects.toThrow(/summarize failed/i);
    expect(spoken).toHaveLength(0);
  });

  it('code summarize failure fails closed — posts kind, rejects, source never spoken', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'upstream down' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    const source = 'export const secret = 42;\nconst x = 1;\n';
    await expect(playWithMode(source, 'summarize', undefined, undefined, {
      kind: 'code',
      filename: 'secret.ts',
      lang: 'ts',
    })).rejects.toThrow(/summarize failed/i);
    expect(fetch).toHaveBeenCalledWith(
      '/tts/summarize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: source,
          kind: 'code',
          filename: 'secret.ts',
          lang: 'ts',
        }),
      }),
    );
    expect(spoken).toHaveLength(0);
  });

  it('piper + conversationId uses /tts/speak-record (202 jobId, not summarize→synthesize)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-1', status: 'running' }),
        };
      }
      // Park poll — keep running so we don't need full audio path for this test.
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            recording: {
              id: 'job-1',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'message',
              mode: 'as-is',
              provider: 'piper',
              voice: '',
              title: 'Hello',
              spoken_text: 'Hello meta',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {},
    });
    vi.stubGlobal('Audio', class {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener = () => {};
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { playWithMode, setTtsConfig } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({
      ...browserTts,
      provider: 'piper',
    });
    await playWithMode('Hello meta', 'as-is', undefined, 'piper', undefined, {
      conversationId: 'conv-1',
      source: 'message',
      title: 'Hello',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/tts/speak-record',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'Hello meta',
          provider: 'piper',
          mode: 'as-is',
          conversationId: 'conv-1',
          source: 'message',
          title: 'Hello',
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/tts/synthesize',
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/tts/summarize',
      expect.anything(),
    );
    const snap = park.getTtsParkState();
    expect(snap.status).toBe('loading');
    expect(snap.jobId).toBe('job-1');
    park.ttsParkStop();
  });

  it('piper + projectId only (no conversationId) still posts speak-record', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-proj', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-proj',
              project_id: 'proj-1',
              conversation_id: null,
              created_at: Date.now(),
              source: 'file',
              mode: 'as-is',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: 'file text',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { playWithMode, setTtsConfig } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });
    await playWithMode('file text', 'as-is', undefined, 'piper', undefined, {
      projectId: 'proj-1',
      source: 'file',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/tts/speak-record',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'file text',
          provider: 'piper',
          mode: 'as-is',
          projectId: 'proj-1',
          source: 'file',
        }),
      }),
    );
    park.ttsParkStop();
  });

  it('piper without conversationId keeps /tts/synthesize path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['wav'], { type: 'audio/wav' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {},
    });
    vi.stubGlobal('Audio', class {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
    });

    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig({
      ...browserTts,
      provider: 'piper',
    });
    await playWithMode('No conv', 'as-is', undefined, 'piper');
    expect(fetchMock).toHaveBeenCalledWith(
      '/tts/synthesize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'No conv',
          provider: 'piper',
        }),
      }),
    );
  });

  it('piper + conversationId + summarize posts mode/kind to speak-record only (no client /tts/summarize)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-2', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-2',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'message',
              mode: 'summarize',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: '# Title',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { playWithMode, setTtsConfig } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });
    await playWithMode('# Title\n\nBody', 'summarize', undefined, 'piper', {
      kind: 'prose',
    }, {
      conversationId: 'conv-1',
      source: 'message',
    });
    const speakRecordCalls = fetchMock.mock.calls.filter((c) => c[0] === '/tts/speak-record');
    expect(speakRecordCalls).toHaveLength(1);
    expect(speakRecordCalls[0]).toEqual([
      '/tts/speak-record',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: '# Title\n\nBody',
          provider: 'piper',
          mode: 'summarize',
          conversationId: 'conv-1',
          source: 'message',
          kind: 'prose',
        }),
      }),
    ]);
    expect(fetchMock.mock.calls.some((c) => c[0] === '/tts/summarize')).toBe(false);
    park.ttsParkStop();
  });

  it('explainDiffAvailable truth table', () => {
    expect(explainDiffAvailable({
      diff: '',
      summarizeConfigured: true,
    })).toBe(false);
    expect(explainDiffAvailable({
      diff: '   \n',
      summarizeConfigured: true,
    })).toBe(false);
    expect(explainDiffAvailable({
      diff: '+x',
      isTracked: false,
      summarizeConfigured: true,
    })).toBe(false);
    expect(explainDiffAvailable({
      diff: '+x',
      summarizeConfigured: false,
    })).toBe(false);
    expect(explainDiffAvailable({
      diff: '@@ -1 +1 @@\n+hello',
      isTracked: true,
      summarizeConfigured: true,
    })).toBe(true);
  });

  it('piper + explain-diff posts speak-record with raw diff (not speakable)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-ed', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-ed',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'file',
              mode: 'explain-diff',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: '',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const diff = '@@ -1 +1 @@\n+hello **bold**\n';
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });
    await playWithMode(diff, 'explain-diff', undefined, 'piper', {
      diff,
      filename: 'a.ts',
      fileContext: 'const x = 1;',
      diffSource: 'working-tree',
      truncated: true,
    }, {
      conversationId: 'conv-1',
      source: 'file',
      title: 'Diff: a.ts',
    });
    const speakRecordCalls = fetchMock.mock.calls.filter((c) => c[0] === '/tts/speak-record');
    expect(speakRecordCalls).toHaveLength(1);
    const [, init] = speakRecordCalls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.mode).toBe('explain-diff');
    expect(body.diff).toBe(diff);
    expect(body.fileContext).toBe('const x = 1;');
    expect(body.diffSource).toBe('working-tree');
    expect(body.truncated).toBe(true);
    // Raw diff survives — speakable() would strip/mangle **bold** markdown-ish content.
    expect(body.text).toBe(diff);
    expect(String(body.text)).toContain('+hello **bold**');
    park.ttsParkStop();
  });

  it('retryLastSpeakRecord re-POSTs explain-diff body including diff', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-retry', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-retry',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'file',
              mode: 'explain-diff',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: '',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const diff = '@@ -1 +1 @@\n+retry me';
    const { playWithMode, setTtsConfig, retryLastSpeakRecord } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });
    await playWithMode(diff, 'explain-diff', undefined, 'piper', {
      diff,
      filename: 'b.ts',
      diffSource: 'commit',
      sha: 'abcdef01',
    }, { conversationId: 'conv-1', source: 'file' });
    fetchMock.mockClear();
    await retryLastSpeakRecord();
    const retryCalls = fetchMock.mock.calls.filter((c) => c[0] === '/tts/speak-record');
    expect(retryCalls).toHaveLength(1);
    const [, retryInit] = retryCalls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(retryInit.body)) as Record<string, unknown>;
    expect(body.mode).toBe('explain-diff');
    expect(body.diff).toBe(diff);
    expect(body.diffSource).toBe('commit');
    expect(body.sha).toBe('abcdef01');
    park.ttsParkStop();
  });

  it('browser + explain-diff posts /tts/summarize with mode and diff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'The change adds a hello constant.' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    const diff = '@@ -1 +1 @@\n+const hello = 1;';
    await playWithMode(diff, 'explain-diff', undefined, 'browser', {
      diff,
      filename: 'a.ts',
      diffSource: 'working-tree',
    });
    expect(fetch).toHaveBeenCalledWith(
      '/tts/summarize',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"mode":"explain-diff"'),
      }),
    );
    const [, sumInit] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    const posted = JSON.parse(String(sumInit.body)) as Record<string, unknown>;
    expect(posted.mode).toBe('explain-diff');
    expect(posted.diff).toBe(diff);
    expect(spoken.some((t) => t.includes('hello constant'))).toBe(true);
  });

  it('browser + explain-diff summarize 500 → fails closed, nothing spoken', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    await expect(playWithMode('+x', 'explain-diff', undefined, 'browser', {
      diff: '+x',
      filename: 'a.ts',
      diffSource: 'working-tree',
    })).rejects.toThrow(/explain-diff failed/i);
    expect(spoken).toHaveLength(0);
    expect(speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it('as-is and summarize bodies do not leak explain-diff keys', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-leak', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-leak',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'message',
              mode: 'as-is',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: '',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { playWithMode, setTtsConfig } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });

    await playWithMode('Hello **world**', 'as-is', undefined, 'piper', {
      diff: 'SHOULD_NOT_APPEAR',
      filename: 'a.ts',
      diffSource: 'working-tree',
    }, { conversationId: 'conv-1', source: 'message' });
    const asIsCall = fetchMock.mock.calls.find((c) => c[0] === '/tts/speak-record') as unknown as [string, RequestInit];
    const asIsBody = JSON.parse(String(asIsCall[1].body)) as Record<string, unknown>;
    expect(asIsBody.mode).toBe('as-is');
    expect(asIsBody.diff).toBeUndefined();
    expect(asIsBody.diffSource).toBeUndefined();

    fetchMock.mockClear();
    await playWithMode('# Title', 'summarize', undefined, 'piper', {
      kind: 'prose',
      diff: 'SHOULD_NOT_APPEAR',
      filename: 'a.ts',
      diffSource: 'working-tree',
    }, { conversationId: 'conv-1', source: 'message' });
    const sumCall = fetchMock.mock.calls.find((c) => c[0] === '/tts/speak-record') as unknown as [string, RequestInit];
    const sumBody = JSON.parse(String(sumCall[1].body)) as Record<string, unknown>;
    expect(sumBody.mode).toBe('summarize');
    expect(sumBody.diff).toBeUndefined();
    expect(sumBody.diffSource).toBeUndefined();
    park.ttsParkStop();
  });

  it('summarize with guidance and targetMinutes posts exact /tts/summarize body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Spoken rewrite' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    const text = '# Title\n\nBody';
    await playWithMode(text, 'summarize', undefined, undefined, {
      guidance: 'only the API changes',
      targetMinutes: 5,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/tts/summarize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text,
          guidance: 'only the API changes',
          targetMinutes: 5,
        }),
      }),
    );
  });

  it('summarize with no opts posts exactly { text }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Spoken rewrite' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    const text = '# Title\n\nBody';
    await playWithMode(text, 'summarize');
    expect(fetch).toHaveBeenCalledWith(
      '/tts/summarize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    );
  });

  it('kind: code + guidance posts keys in text, kind, filename, lang, guidance, targetMinutes order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Spoken rewrite' }),
    }));
    const { playWithMode, setTtsConfig } = await import('./speak.js');
    setTtsConfig(browserTts);
    const source = 'export const x = 1;';
    await playWithMode(source, 'summarize', undefined, undefined, {
      kind: 'code',
      filename: 'a.ts',
      lang: 'ts',
      guidance: 'only the types',
      targetMinutes: 2,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/tts/summarize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: source,
          kind: 'code',
          filename: 'a.ts',
          lang: 'ts',
          guidance: 'only the types',
          targetMinutes: 2,
        }),
      }),
    );
  });

  it('piper + conversationId speak-record body carries guidance and targetMinutes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-focus', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-focus',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'message',
              mode: 'summarize',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: '# Title',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { playWithMode, setTtsConfig } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });
    await playWithMode('# Title\n\nBody', 'summarize', undefined, 'piper', {
      guidance: 'only the API changes',
      targetMinutes: 5,
    }, {
      conversationId: 'conv-1',
      source: 'message',
    });
    const speakRecordCalls = fetchMock.mock.calls.filter((c) => c[0] === '/tts/speak-record');
    expect(speakRecordCalls).toHaveLength(1);
    const [, init] = speakRecordCalls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.guidance).toBe('only the API changes');
    expect(body.targetMinutes).toBe(5);
    park.ttsParkStop();
  });

  it('retryLastSpeakRecord re-posts the same speak-record body including guidance', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/tts/speak-record') {
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: 'job-retry-focus', status: 'running' }),
        };
      }
      if (url.startsWith('/tts/recordings/')) {
        return {
          ok: true,
          json: async () => ({
            recording: {
              id: 'job-retry-focus',
              project_id: 'p',
              conversation_id: 'conv-1',
              created_at: Date.now(),
              source: 'message',
              mode: 'summarize',
              provider: 'piper',
              voice: '',
              title: '',
              spoken_text: '',
              path: '',
              bytes: 0,
              status: 'running',
              error: null,
              updated_at: Date.now(),
              ephemeral: 0,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { playWithMode, setTtsConfig, retryLastSpeakRecord } = await import('./speak.js');
    const park = await import('./ttsParkPlayer.js');
    setTtsConfig({ ...browserTts, provider: 'piper' });
    await playWithMode('# Title', 'summarize', undefined, 'piper', {
      guidance: 'only the API changes',
      targetMinutes: 5,
    }, { conversationId: 'conv-1', source: 'message' });
    const firstCall = fetchMock.mock.calls.find((c) => c[0] === '/tts/speak-record') as unknown as [string, RequestInit];
    const firstBody = String(firstCall[1].body);
    expect(firstBody).toContain('"guidance":"only the API changes"');
    expect(firstBody).toContain('"targetMinutes":5');
    fetchMock.mockClear();
    await retryLastSpeakRecord();
    const retryCalls = fetchMock.mock.calls.filter((c) => c[0] === '/tts/speak-record');
    expect(retryCalls).toHaveLength(1);
    const [, retryInit] = retryCalls[0] as unknown as [string, RequestInit];
    expect(String(retryInit.body)).toBe(firstBody);
    park.ttsParkStop();
  });
});
