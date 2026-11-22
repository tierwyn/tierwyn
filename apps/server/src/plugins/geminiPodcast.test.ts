// Tests for the gemini-podcast plugin (plain JS at plugin-src/gemini-podcast).
// Mirrors geminiAudiobook.test.ts: real modules, fake fetch, temp TIERWYN_DB shard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { validateManifest } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '../../../../plugin-src/gemini-podcast');
const audiobookDir = join(here, '../../../../plugin-src/gemini-audiobook');
const audio: any = await import(join(pluginDir, 'audio.js'));
const gemini: any = await import(join(pluginDir, 'gemini.js'));
const script: any = await import(join(pluginDir, 'script.js'));
const plugin: any = await import(join(pluginDir, 'index.js'));

const SAMPLE_PCM = new Int16Array([100, -100, 200, -200, 300]);
const SAMPLE_B64 = Buffer.from(SAMPLE_PCM.buffer, SAMPLE_PCM.byteOffset, SAMPLE_PCM.byteLength).toString(
  'base64',
);

function ttsBody(parts: any[], extra: any = {}) {
  return { candidates: [{ content: { parts } }], ...extra };
}

function textBody(parts: any[], extra: any = {}) {
  return { candidates: [{ content: { parts } }], ...extra };
}

function geminiTtsOk(pcm: Int16Array = SAMPLE_PCM, rate = 24000) {
  const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  return new Response(
    JSON.stringify(ttsBody([{ inlineData: { mimeType: `audio/L16;codec=pcm;rate=${rate}`, data: b64 } }])),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function geminiTextOk(text: string) {
  return new Response(JSON.stringify(textBody([{ text }])), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pcmFilled(value: number, n = 8) {
  return new Int16Array(n).fill(value);
}

const TWO = [
  { name: 'Ada', voice: 'Zephyr' },
  { name: 'Ben', voice: 'Puck' },
];
const SCRIPT_TWO = 'Title: Hello World\nSpeaker 1: Hi there friend.\nSpeaker 2: Hello back again.';

const AGENT = { kind: 'agent', conversationId: 'conv-pod-1' } as any;
const OPERATOR = { kind: 'operator' } as any;

function fakeCtx(opts: { key?: string; fetchImpl?: (...a: any[]) => Promise<any> } = {}) {
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => new Response('{}', { status: 500 })));
  const ctx = {
    manifest: {
      id: 'gemini-podcast',
      capabilities: [
        { name: 'podcast.script.generate', agentCallable: true, rateLimitPerMin: 6 },
        { name: 'podcast.audio.generate', agentCallable: true, rateLimitPerMin: 2 },
      ],
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { get: () => ({}) },
    credentials: { get: vi.fn(() => opts.key) },
    http: { fetch: fetchMock },
    capability: vi.fn(),
    onDeactivate: vi.fn(),
  };
  plugin.default.activate(ctx as any);
  const scriptGen = ctx.capability.mock.calls.find((c: any[]) => c[0] === 'podcast.script.generate')?.[1];
  const audioGen = ctx.capability.mock.calls.find((c: any[]) => c[0] === 'podcast.audio.generate')?.[1];
  if (!scriptGen || !audioGen) throw new Error('plugin did not register both capabilities');
  return { ctx, fetchMock, scriptGen, audioGen };
}

function fakeGeminiCtx(fetchImpl: (...a: any[]) => Promise<any>) {
  const fetchMock = vi.fn(fetchImpl);
  return {
    ctx: {
      http: { fetch: fetchMock },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    fetchMock,
  };
}

let tmp = '';
const oldDb = process.env.TIERWYN_DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gemini-podcast-test-'));
  process.env.TIERWYN_DB = join(tmp, 'test.db');
  plugin.resetFfmpegProbe?.();
});

afterEach(() => {
  if (oldDb === undefined) delete process.env.TIERWYN_DB;
  else process.env.TIERWYN_DB = oldDb;
  rmSync(tmp, { recursive: true, force: true });
  plugin.resetFfmpegProbe?.();
  gemini.config.retryBackoffMs = 2_000;
  if (plugin.config) plugin.config.budgetMs = 280_000;
});

describe('scaffold', () => {
  it('plugin.json.example validates', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    expect(validateManifest(json)).toEqual({
      ok: true,
      manifest: expect.objectContaining({ id: 'gemini-podcast' }),
    });
    const names = json.capabilities.map((c: any) => c.name).sort();
    expect(names).toEqual(['podcast.audio.generate', 'podcast.script.generate']);
    const scriptCap = json.capabilities.find((c: any) => c.name === 'podcast.script.generate');
    const audioCap = json.capabilities.find((c: any) => c.name === 'podcast.audio.generate');
    expect(scriptCap.rateLimitPerMin).toBe(6);
    expect(audioCap.rateLimitPerMin).toBe(2);
    expect(scriptCap.timeoutMs).toBe(300000);
    expect(audioCap.timeoutMs).toBe(300000);
    expect(json.permissions).toEqual(['outbound:https://generativelanguage.googleapis.com']);
  });

  it('audio.js is a verbatim copy of gemini-audiobook/audio.js', () => {
    const a = readFileSync(join(pluginDir, 'audio.js'));
    const b = readFileSync(join(audiobookDir, 'audio.js'));
    expect(a.equals(b)).toBe(true);
  });
});

describe('script.parseScript / estimateSeconds', () => {
  it('extracts the title from the first Title: line', () => {
    const p = script.parseScript('Title:  Deep Dive  \nSpeaker 1: hello');
    expect(p.title).toBe('Deep Dive');
  });

  it('parses Speaker 10', () => {
    const p = script.parseScript('Speaker 10: last one');
    expect(p.turns).toEqual([{ speaker: 10, text: 'last one' }]);
    expect([...p.speakersUsed]).toEqual([10]);
  });

  it('accepts case and whitespace variants', () => {
    const p = script.parseScript('speaker  2 :  hello there');
    expect(p.turns).toEqual([{ speaker: 2, text: 'hello there' }]);
  });

  it('appends continuation lines to the previous turn', () => {
    const p = script.parseScript('Speaker 1: Hello\nand also this\nSpeaker 2: Bye');
    expect(p.turns[0].text).toBe('Hello and also this');
    expect(p.turns[1].text).toBe('Bye');
  });

  it('ignores orphan leading lines', () => {
    const p = script.parseScript('not a turn\nSpeaker 1: hi');
    expect(p.turns).toEqual([{ speaker: 1, text: 'hi' }]);
    expect(p.title).toBe('');
  });

  it('drops empty turns', () => {
    const p = script.parseScript('Speaker 1:   \nSpeaker 2: real');
    expect(p.turns).toEqual([{ speaker: 2, text: 'real' }]);
  });

  it('word count excludes tags and title, at 150 WPM', () => {
    const src = 'Title: Hello World\nSpeaker 1: One two [laughing] three four five.';
    const { wordCount, estSeconds } = script.estimateSeconds(src);
    expect(wordCount).toBe(5);
    expect(estSeconds).toBe(Math.floor((5 / 150) * 60));
  });
});

describe('script.buildPrompt', () => {
  const base = { speakers: TWO, language: 'Italian', voiceTraits: gemini.VOICE_TRAITS };

  it('write includes language clause, profiles, and topic', () => {
    const p = script.buildPrompt({ ...base, action: 'write', topic: 'mars', targetMinutes: 5 });
    expect(p).toContain('MUST be written in **Italian**');
    expect(p).toContain('- Speaker 1 has the name **Ada**. Their voice is described as "Zephyr (Bright, Female)" for context.');
    expect(p).toContain('That\'s a great point, Ben');
    expect(p).toContain('The topic for the podcast is: "mars"');
    expect(p).toContain('approximately **5 minutes**');
  });

  it('podcastify includes TRANSFORM, DON\'T COPY', () => {
    const p = script.buildPrompt({ ...base, action: 'podcastify', sourceText: 'an article' });
    expect(p).toContain("TRANSFORM, DON'T COPY");
    expect(p).toContain('an article');
  });

  it('improve forbids a name after the colon', () => {
    const p = script.buildPrompt({ ...base, action: 'improve', script: SCRIPT_TWO });
    expect(p).toContain("You MUST NOT include the speaker's name after the colon");
    expect(p).toContain(SCRIPT_TWO);
  });

  it('lengthen with deltaSeconds uses floor((cur+Δ)/60*150)', () => {
    const { estSeconds } = script.estimateSeconds(SCRIPT_TWO);
    const delta = 60;
    const expected = Math.floor(((estSeconds + delta) / 60) * 150);
    const p = script.buildPrompt({
      ...base,
      action: 'lengthen',
      script: SCRIPT_TWO,
      deltaSeconds: delta,
    });
    expect(p).toContain(`approximately ${expected} words`);
    expect(p).toContain('ACHIEVE LENGTH');
  });

  it('lengthen without deltaSeconds uses ADD EXCHANGES', () => {
    const p = script.buildPrompt({ ...base, action: 'lengthen', script: SCRIPT_TWO });
    expect(p).toContain('ADD EXCHANGES');
    expect(p).not.toContain('approximately');
  });

  it('shorten aims at a reduced word count', () => {
    const p = script.buildPrompt({ ...base, action: 'shorten', script: SCRIPT_TWO, deltaSeconds: 30 });
    expect(p).toContain('make it SHORTER');
  });

  it('expressions uses square-bracket tags including [short pause]', () => {
    const p = script.buildPrompt({
      ...base,
      action: 'expressions',
      script: SCRIPT_TWO,
      intensity: 'dramatic',
    });
    expect(p).toContain('[short pause]');
    expect(p).toContain('**Dramatic**');
    expect(p).toContain('square brackets');
  });

  it("translate does not translate the word 'Speaker'", () => {
    const p = script.buildPrompt({
      ...base,
      action: 'translate',
      script: SCRIPT_TWO,
      targetLanguage: 'Italian',
    });
    expect(p).toContain("Do not translate the word 'Speaker'");
    expect(p).not.toContain('NAME LOCALIZATION');
  });
});

describe('script.cleanModelOutput', () => {
  it('joins non-thought text parts', () => {
    expect(
      script.cleanModelOutput([
        { thought: true, text: 'thinking' },
        { text: 'Title: A\n' },
        { text: 'Speaker 1: hi' },
      ]),
    ).toBe('Title: A\nSpeaker 1: hi');
  });

  it('strips one wrapping fence', () => {
    expect(script.cleanModelOutput('```markdown\nTitle: A\nSpeaker 1: hi\n```')).toBe(
      'Title: A\nSpeaker 1: hi',
    );
  });

  it('zero Speaker lines parse to no turns (handler maps this to upstream_error)', () => {
    const cleaned = script.cleanModelOutput('just a paragraph');
    expect(script.parseScript(cleaned).turns).toHaveLength(0);
  });
});

describe('gemini.extractAudio concatenates all audio parts', () => {
  it('joins two inline audio parts', () => {
    const a = new Int16Array([1, 2]);
    const b = new Int16Array([3, 4]);
    const out = gemini.extractAudio(
      ttsBody([
        {
          inlineData: {
            mimeType: 'audio/L16;codec=pcm;rate=24000',
            data: Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'),
          },
        },
        {
          inlineData: {
            mimeType: 'audio/L16;codec=pcm;rate=24000',
            data: Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64'),
          },
        },
      ]),
    );
    expect([...out.pcm]).toEqual([1, 2, 3, 4]);
  });
});

describe('gemini.generateText / synthesize / synthesizeMulti', () => {
  it('posts x-goog-api-key header, never puts the key in the URL', async () => {
    const { ctx, fetchMock } = fakeGeminiCtx(async () => geminiTextOk('Title: A\nSpeaker 1: hi'));
    await gemini.generateText(ctx, 'secret-key', { prompt: 'p', model: 'gemini-3.8-flash' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('secret-key');
    expect(url).not.toContain('?key=');
    expect(init.headers['x-goog-api-key']).toBe('secret-key');
  });

  it('HTTP 400 → upstream_error with no upstream body text', async () => {
    const { ctx } = fakeGeminiCtx(
      async () => new Response(JSON.stringify({ error: { message: 'leaked-secret' } }), { status: 400 }),
    );
    const err: any = await gemini
      .generateText(ctx, 'k', { prompt: 'p', model: 'gemini-3.8-flash' })
      .catch((e: any) => e);
    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('gemini (gemini-3.8-flash): HTTP 400');
    expect(err.message).not.toContain('leaked-secret');
  });

  it('retries once on 503 then succeeds', async () => {
    const prev = gemini.config.retryBackoffMs;
    gemini.config.retryBackoffMs = 0;
    try {
      let n = 0;
      const { ctx, fetchMock } = fakeGeminiCtx(async () => {
        n += 1;
        if (n === 1) return new Response('{}', { status: 503 });
        return geminiTextOk('Title: A\nSpeaker 1: hi');
      });
      await gemini.generateText(ctx, 'k', { prompt: 'p', model: 'gemini-3.8-flash' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      gemini.config.retryBackoffMs = prev;
    }
  });

  it('TimeoutError → timeout', async () => {
    const { ctx } = fakeGeminiCtx(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(
      gemini.synthesize(ctx, 'k', { text: 'hi', voice: 'Kore', model: 'gemini-3.8-flash-tts' }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('multi-speaker request body has exactly 2 speakerVoiceConfigs and alias mapping', () => {
    const body = gemini.buildMultiSpeakerRequest({
      turns: [
        { alias: 'Speaker1', text: 'Hi' },
        { alias: 'Speaker2', text: 'Hello' },
      ],
      speakerVoiceConfigs: [
        { speaker: 'Speaker1', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
        { speaker: 'Speaker2', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      ],
    });
    expect(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toHaveLength(2);
    expect(body.contents[0].parts[0]).toMatchObject({
      text: 'Hi',
      speech_metadata: { speaker: 'Speaker1' },
      speechMetadata: { speaker: 'Speaker1' },
    });
    expect(body.contents[0].parts[1].speechMetadata.speaker).toBe('Speaker2');
  });
});

describe('gemini-podcast input validation (no fetch)', () => {
  it('rejects speakers 0/11/dupe/long name without fetch', async () => {
    const { fetchMock, scriptGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTextOk(SCRIPT_TWO) });
    await expect(scriptGen({ action: 'write', topic: 'x', speakers: [] }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `S${i}` }));
    await expect(scriptGen({ action: 'write', topic: 'x', speakers: eleven }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(
      scriptGen(
        { action: 'write', topic: 'x', speakers: [{ name: 'Ada' }, { name: 'ada' }] },
        AGENT,
      ),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      scriptGen({ action: 'write', topic: 'x', speakers: [{ name: 'x'.repeat(41) }] }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown voice/model/action/mode/format/intensity without fetch', async () => {
    const { fetchMock, scriptGen, audioGen } = fakeCtx({
      key: 'k',
      fetchImpl: async () => geminiTtsOk(),
    });
    await expect(
      scriptGen({ action: 'write', topic: 'x', speakers: [{ name: 'Ada', voice: 'NotAVoice' }] }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      scriptGen({ action: 'write', topic: 'x', speakers: TWO, model: 'dall-e' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(scriptGen({ action: 'nope', speakers: TWO, topic: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(
      scriptGen({ action: 'expressions', speakers: TWO, script: SCRIPT_TWO, intensity: 'loud' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      audioGen({ script: SCRIPT_TWO, speakers: TWO, mode: 'stereo' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      audioGen({ script: SCRIPT_TWO, speakers: TWO, format: 'ogg' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing per-action fields and oversize text without fetch', async () => {
    const { fetchMock, scriptGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTextOk(SCRIPT_TWO) });
    await expect(scriptGen({ action: 'write', speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(scriptGen({ action: 'podcastify', speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(scriptGen({ action: 'improve', speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(scriptGen({ action: 'shorten', speakers: TWO, script: SCRIPT_TWO }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(scriptGen({ action: 'translate', speakers: TWO, script: SCRIPT_TWO }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    await expect(
      scriptGen({ action: 'write', speakers: TWO, topic: 'x'.repeat(2001) }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    await expect(
      scriptGen({ action: 'improve', speakers: TWO, script: 'x'.repeat(30_001) }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects Speaker K > N, explicit multi-speaker with 3 used, >48 requests, path-like filename', async () => {
    const { fetchMock, audioGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    await expect(
      audioGen({ script: 'Speaker 3: hi', speakers: TWO }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    const three = 'Speaker 1: a\nSpeaker 2: b\nSpeaker 3: c';
    const threeSpeakers = [...TWO, { name: 'Cara', voice: 'Kore' }];
    await expect(
      audioGen({ script: three, speakers: threeSpeakers, mode: 'multi-speaker' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    const lines = Array.from({ length: 49 }, (_, i) => `Speaker 1: line ${i}.`).join('\n');
    await expect(audioGen({ script: lines, speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
      message: expect.stringMatching(/48/),
    });
    for (const filename of ['../../etc/passwd', 'a/b', 'a\\b', '..', '.hidden', 'a b']) {
      await expect(
        audioGen({ script: SCRIPT_TWO, speakers: TWO, filename }, AGENT),
      ).rejects.toMatchObject({ code: 'bad_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('podcast.script.generate handler', () => {
  it('missing key → credential_missing; fetch not called', async () => {
    const a = fakeCtx({ key: undefined });
    await expect(a.scriptGen({ action: 'write', topic: 'x', speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'credential_missing',
    });
    expect(a.fetchMock).not.toHaveBeenCalled();
  });

  it('happy path returns script/turns/estSeconds', async () => {
    const { fetchMock, scriptGen } = fakeCtx({
      key: 'test-key',
      fetchImpl: async () => geminiTextOk(SCRIPT_TWO),
    });
    const out = await scriptGen({ action: 'write', topic: 'hello', speakers: TWO }, AGENT);
    expect(out.script).toContain('Speaker 1:');
    expect(out.turns).toBe(2);
    expect(out.title).toBe('Hello World');
    expect(out.speakersUsed).toEqual([1, 2]);
    expect(out.wordCount).toBeGreaterThan(0);
    expect(out.estSeconds).toBeGreaterThanOrEqual(0);
    expect(out.model).toBe('gemini-3.8-flash');
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain('/models/gemini-3.8-flash:generateContent');
    expect(url).not.toContain('test-key');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
  });

  it('model reply using Speaker 3 with 2 speakers → upstream_error', async () => {
    const { scriptGen } = fakeCtx({
      key: 'k',
      fetchImpl: async () => geminiTextOk('Title: X\nSpeaker 1: a\nSpeaker 3: nope'),
    });
    await expect(scriptGen({ action: 'write', topic: 'x', speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/Speaker 3/),
    });
  });

  it('model reply with zero Speaker lines → upstream_error', async () => {
    const { scriptGen } = fakeCtx({
      key: 'k',
      fetchImpl: async () => geminiTextOk('sorry I cannot'),
    });
    await expect(scriptGen({ action: 'write', topic: 'x', speakers: TWO }, AGENT)).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/no Speaker lines/),
    });
  });
});

describe('podcast.audio.generate handler', () => {
  it('auto → multi-speaker for 2 speakers, block count matches chunking', async () => {
    const longA = 'A'.repeat(2000);
    const longB = 'B'.repeat(2000);
    const src = `Title: Long\nSpeaker 1: ${longA}\nSpeaker 2: ${longB}`;
    const { fetchMock, audioGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk(pcmFilled(1, 8)) });
    const out = await audioGen({ script: src, speakers: TWO, filename: 'long2' }, AGENT);
    expect(out.mode).toBe('multi-speaker');
    expect(out.requests).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
    for (const b of bodies) {
      expect(b.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toHaveLength(2);
    }
  });

  it('auto → line-by-line for 3 speakers and for 1 speaker', async () => {
    const threeSpeakers = [...TWO, { name: 'Cara', voice: 'Kore' }];
    const three = 'Speaker 1: a\nSpeaker 2: b\nSpeaker 3: c';
    const a = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk(pcmFilled(1, 4)) });
    const out3 = await a.audioGen({ script: three, speakers: threeSpeakers, filename: 't3' }, AGENT);
    expect(out3.mode).toBe('line-by-line');
    expect(out3.requests).toBe(3);

    const one = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk(pcmFilled(1, 4)) });
    const out1 = await one.audioGen(
      { script: 'Speaker 1: only me', speakers: [{ name: 'Ada', voice: 'Zephyr' }], filename: 't1' },
      AGENT,
    );
    expect(out1.mode).toBe('line-by-line');
    expect(out1.requests).toBe(1);
    const body = JSON.parse((one.fetchMock.mock.calls[0] as [string, any])[1].body);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Zephyr');
  });

  it('writes WAV in the conversation shard with duration = segments + 250ms gaps', async () => {
    const { audioGen } = fakeCtx({
      key: 'k',
      fetchImpl: async () => geminiTtsOk(pcmFilled(50, 8)),
    });
    const out = await audioGen({ script: SCRIPT_TWO, speakers: TWO, filename: 'gap', mode: 'line-by-line' }, AGENT);
    expect(isAbsolute(out.path)).toBe(true);
    expect(out.path.startsWith(join(tmp, 'artifacts', 'conv-pod-1'))).toBe(true);
    expect(out.path.endsWith('/gap.wav')).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(out.mime).toBe('audio/wav');
    expect(out.sampleRate).toBe(24000);
    // 8 + 6000 (250ms @ 24k) + 8
    expect(out.durationSec).toBe((8 + 6000 + 8) / 24000);
    const wav = readFileSync(out.path);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('default filename matches podcast_<title>_<6hex>', async () => {
    const { audioGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    const out = await audioGen({ script: SCRIPT_TWO, speakers: TWO }, AGENT);
    expect(out.path.split('/').pop()).toMatch(/^podcast_hello_world_[0-9a-f]{6}\.wav$/);
  });

  it('existing filename → bad_input BEFORE the paid call', async () => {
    const { fetchMock, audioGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    const first = await audioGen({ script: SCRIPT_TWO, speakers: TWO, filename: 'fox' }, AGENT);
    await expect(
      audioGen({ script: SCRIPT_TWO, speakers: TWO, filename: 'fox' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(first.path)).toBe(true);
  });

  it('mixed sample rates → upstream_error', async () => {
    let n = 0;
    const { audioGen } = fakeCtx({
      key: 'k',
      fetchImpl: async () => {
        n += 1;
        return geminiTtsOk(pcmFilled(1, 4), n === 1 ? 24000 : 16000);
      },
    });
    await expect(
      audioGen({ script: SCRIPT_TWO, speakers: TWO, filename: 'mix', mode: 'line-by-line' }, AGENT),
    ).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringMatching(/mixed sample rates/) });
  });

  it('deadline → timeout with done/total message', async () => {
    const prev = plugin.config.budgetMs;
    plugin.config.budgetMs = 20;
    try {
      const { audioGen, fetchMock } = fakeCtx({
        key: 'k',
        fetchImpl: (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            const s: AbortSignal | undefined = init?.signal;
            const boom = () =>
              reject(s?.reason instanceof Error ? s.reason : new DOMException('aborted', 'AbortError'));
            if (s?.aborted) {
              boom();
              return;
            }
            s?.addEventListener('abort', boom, { once: true });
          }),
      });
      const err: any = await audioGen(
        { script: SCRIPT_TWO, speakers: TWO, filename: 'late', mode: 'line-by-line' },
        AGENT,
      ).catch((e: any) => e);
      expect(err.code).toBe('timeout');
      expect(err.message).toMatch(/\/\d+/);
      expect(existsSync(join(tmp, 'artifacts', 'conv-pod-1', 'late.wav'))).toBe(false);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    } finally {
      plugin.config.budgetMs = prev;
    }
  });

  it('mp3 without ffmpeg → bad_input before the paid call', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/tmp/no-ffmpeg-bin';
    plugin.resetFfmpegProbe();
    try {
      const { fetchMock, audioGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
      await expect(
        audioGen({ script: SCRIPT_TWO, speakers: TWO, format: 'mp3', filename: 'nope' }, AGENT),
      ).rejects.toMatchObject({
        code: 'bad_input',
        message: expect.stringMatching(/ffmpeg/i),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = oldPath;
      plugin.resetFfmpegProbe();
    }
  });

  it('mp3 format encodes via ffmpeg when available', async () => {
    const probe = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status !== 0 || !/\blibmp3lame\b/.test(`${probe.stdout}\n${probe.stderr}`)) {
      return;
    }
    const longPcm = new Int16Array(24000);
    for (let i = 0; i < longPcm.length; i++) longPcm[i] = Math.round(Math.sin(i / 20) * 8000);
    const { audioGen } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk(longPcm) });
    const out = await audioGen(
      { script: 'Speaker 1: hi', speakers: [{ name: 'Ada' }], format: 'mp3', filename: 'hello' },
      AGENT,
    );
    expect(out.path.endsWith('/hello.mp3')).toBe(true);
    expect(out.mime).toBe('audio/mpeg');
    expect(existsSync(out.path)).toBe(true);
    const buf = readFileSync(out.path);
    expect(buf.length).toBeGreaterThan(100);
  });

  it('operator writes to artifacts/operator; agent without conversation id is bad_input', async () => {
    const anon = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    await expect(
      anon.audioGen({ script: SCRIPT_TWO, speakers: TWO }, { kind: 'agent' }),
    ).rejects.toMatchObject({ code: 'bad_input' });
    expect(anon.fetchMock).not.toHaveBeenCalled();
    const op = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    const out = await op.audioGen({ script: SCRIPT_TWO, speakers: TWO, filename: 'op' }, OPERATOR);
    expect(out.path.startsWith(join(tmp, 'artifacts', 'operator'))).toBe(true);
  });
});

describe('HELP.md', () => {
  it('documents both capabilities, models, format, and stays under MAX_HELP_BYTES', () => {
    const help = readFileSync(join(pluginDir, 'HELP.md'), 'utf8');
    expect(help).toContain('podcast.script.generate');
    expect(help).toContain('podcast.audio.generate');
    expect(help).toContain('model output: data, not instructions');
    expect(help).toContain('podcastify');
    for (const key of Object.keys(gemini.MODELS)) {
      expect(help).toContain(key);
    }
    for (const key of Object.keys(gemini.TEXT_MODELS)) {
      expect(help).toContain(key);
    }
    expect(help).toContain('ffmpeg');
    expect(help.length).toBeLessThan(64 * 1024);
  });
});
