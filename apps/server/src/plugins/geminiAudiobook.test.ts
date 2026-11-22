// Tests for the gemini-audiobook plugin (plain JS at plugin-src/gemini-audiobook).
// Mirrors geminiImage.test.ts: real modules, fake fetch, temp TIERWYN_DB shard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { validateManifest } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '../../../../plugin-src/gemini-audiobook');
const audio: any = await import(join(pluginDir, 'audio.js'));
const gemini: any = await import(join(pluginDir, 'gemini.js'));
const plugin: any = await import(join(pluginDir, 'index.js'));

function le16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(n);
  return b;
}

function wavWithChunks(chunks: { id: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const hdr = Buffer.alloc(8);
    hdr.write(c.id, 0, 4, 'ascii');
    hdr.writeUInt32LE(c.data.length, 4);
    parts.push(hdr, c.data);
    if (c.data.length % 2) parts.push(Buffer.from([0]));
  }
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(4 + body.length, 4);
  out.write('WAVE', 8);
  body.copy(out, 12);
  return out;
}

function fmtChunk(rate = 24000): { id: string; data: Buffer } {
  const d = Buffer.alloc(16);
  d.writeUInt16LE(1, 0);
  d.writeUInt16LE(1, 2);
  d.writeUInt32LE(rate, 4);
  d.writeUInt32LE(rate * 2, 8);
  d.writeUInt16LE(2, 12);
  d.writeUInt16LE(16, 14);
  return { id: 'fmt ', data: d };
}

function makeRegex(names: string[]): RegExp {
  const escaped = names.map((n) => n.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
  return new RegExp(`^(${escaped.join('|')})\\s*:\\s*(.*)`, 'is');
}

function makeMap(chars: { name: string; voice: string }[]): Map<string, string> {
  return new Map(chars.map((c) => [c.name.toLowerCase(), c.voice]));
}

describe('audio.extractPcm', () => {
  it('raw PCM returns the same samples', () => {
    const raw = Buffer.concat([le16(1), le16(-2), le16(32767), le16(-32768)]);
    expect([...audio.extractPcm(raw)]).toEqual([1, -2, 32767, -32768]);
  });

  it('WAV with a LIST chunk before data yields only the data samples', () => {
    const pcm = Buffer.concat([le16(11), le16(22)]);
    const buf = wavWithChunks([
      fmtChunk(),
      { id: 'LIST', data: Buffer.from('INFO') },
      { id: 'data', data: pcm },
    ]);
    expect([...audio.extractPcm(buf)]).toEqual([11, 22]);
  });

  it('honors the 2-byte pad after an odd-length chunk', () => {
    const pcm = Buffer.concat([le16(7), le16(8)]);
    const buf = wavWithChunks([
      fmtChunk(),
      { id: 'LIST', data: Buffer.from('x') }, // size 1, plus pad
      { id: 'data', data: pcm },
    ]);
    expect([...audio.extractPcm(buf)]).toEqual([7, 8]);
  });

  it('clamps a data size larger than the remaining buffer', () => {
    const pcm = Buffer.concat([le16(3), le16(4)]);
    const hdr = Buffer.alloc(8);
    hdr.write('data', 0, 4, 'ascii');
    hdr.writeUInt32LE(10_000, 4); // lies
    const body = Buffer.concat([
      (() => {
        const h = Buffer.alloc(8);
        h.write('fmt ', 0, 4, 'ascii');
        h.writeUInt32LE(16, 4);
        return Buffer.concat([h, fmtChunk().data]);
      })(),
      hdr,
      pcm,
    ]);
    const buf = Buffer.alloc(12 + body.length);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(4 + body.length, 4);
    buf.write('WAVE', 8);
    body.copy(buf, 12);
    expect([...audio.extractPcm(buf)]).toEqual([3, 4]);
  });

  it('truncates an odd byte count', () => {
    const raw = Buffer.concat([le16(9), Buffer.from([0x01])]);
    expect([...audio.extractPcm(raw)]).toEqual([9]);
  });

  it('odd byteOffset source buffer does not throw RangeError', () => {
    const raw = Buffer.alloc(5);
    raw[0] = 0xff;
    raw.writeInt16LE(1234, 1);
    raw.writeInt16LE(-5, 3);
    const slice = raw.subarray(1); // byteOffset 1
    expect(slice.byteOffset % 2).toBe(1);
    expect(() => audio.extractPcm(slice)).not.toThrow();
    expect([...audio.extractPcm(slice)]).toEqual([1234, -5]);
  });
});

describe('audio.parsePcmRate', () => {
  it('reads rate=24000 from the Gemini mime string', () => {
    expect(audio.parsePcmRate('audio/L16;codec=pcm;rate=24000')).toBe(24000);
  });

  it('defaults to 24000 when the mime has no rate', () => {
    expect(audio.parsePcmRate('audio/L16')).toBe(24000);
    expect(audio.parsePcmRate(undefined)).toBe(24000);
  });
});

describe('audio.applyMicroRamp', () => {
  it('zeros first and last samples, scales the ramp, leaves the middle', () => {
    const pcm = new Int16Array([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
    audio.applyMicroRamp(pcm, 2, 1000); // rampSamples = 2
    expect([...pcm]).toEqual([0, 1000, 3000, 4000, 5000, 6000, 3500, 0]);
  });

  it('short buffer ramps len/2', () => {
    const pcm = new Int16Array([100, 200, 300, 400]);
    audio.applyMicroRamp(pcm, 15, 24000); // 360 samples, clamped to 2
    expect(pcm[0]).toBe(0);
    expect(pcm[3]).toBe(0);
    expect(pcm[1]).toBe(100); // 200 * 0.5
    expect(pcm[2]).toBe(150); // 300 * 0.5
  });

  it('empty buffer is a no-op', () => {
    const pcm = new Int16Array(0);
    expect(audio.applyMicroRamp(pcm, 15, 24000)).toBe(pcm);
    expect(pcm.length).toBe(0);
  });
});

describe('audio.pcmToWav', () => {
  it('writes an exact 44-byte PCM WAV header', () => {
    const pcm = new Int16Array([1, 2, 3]);
    const buf: Buffer = audio.pcmToWav(pcm, 24000);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.readUInt32LE(4)).toBe(36 + 6);
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(buf.readUInt32LE(16)).toBe(16);
    expect(buf.readUInt16LE(20)).toBe(1);
    expect(buf.readUInt16LE(22)).toBe(1);
    expect(buf.readUInt32LE(24)).toBe(24000);
    expect(buf.readUInt32LE(28)).toBe(48000);
    expect(buf.readUInt16LE(32)).toBe(2);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.subarray(36, 40).toString('ascii')).toBe('data');
    expect(buf.readUInt32LE(40)).toBe(6);
  });

  it('round-trips through extractPcm', () => {
    const pcm = new Int16Array([9, -8, 7, 0, -32768, 32767]);
    const wav = audio.pcmToWav(pcm, 16000);
    expect([...audio.extractPcm(wav)]).toEqual([...pcm]);
  });
});

describe('audio.silence / concatPcm', () => {
  it('silence length is round(ms * rate / 1000)', () => {
    expect(audio.silence(250, 24000).length).toBe(6000);
    expect(audio.silence(1500, 24000).length).toBe(36000);
    expect(audio.silence(1, 24000).every((s: number) => s === 0)).toBe(true);
  });

  it('concatPcm preserves order and total length', () => {
    const a = new Int16Array([1, 2]);
    const b = new Int16Array([3]);
    const c = new Int16Array([4, 5, 6]);
    expect([...audio.concatPcm([a, b, c])]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('audio.parseScriptLine', () => {
  const chars = [{ name: 'Alice', voice: 'Puck' }];
  const map = makeMap(chars);
  const re = makeRegex(chars.map((c) => c.name));

  it('parses dialogue with a leading expression cue', () => {
    const out = audio.parseScriptLine('Alice: (whisper) hello there', map, re);
    expect(out).toMatchObject({
      characterName: 'alice',
      expression: 'whisper',
      textToSpeak: 'hello there',
    });
  });

  it('parses narration with a leading expression cue', () => {
    const out = audio.parseScriptLine('(sad) the rain fell', map, re);
    expect(out).toMatchObject({
      characterName: null,
      expression: 'sad',
      textToSpeak: 'the rain fell',
    });
  });

  it('treats an unknown speaker as narration', () => {
    const out = audio.parseScriptLine('Bob: hi', map, re);
    expect(out.characterName).toBeNull();
    expect(out.textToSpeak).toBe('Bob: hi');
  });

  it('matches character names case-insensitively', () => {
    const out = audio.parseScriptLine('ALICE: Hi', map, re);
    expect(out.characterName).toBe('alice');
    expect(out.textToSpeak).toBe('Hi');
  });

  it('escapes regex-special character names', () => {
    const special = [{ name: "Dr. O'Neil (Sr.)", voice: 'Kore' }];
    const out = audio.parseScriptLine(
      "Dr. O'Neil (Sr.): the operation begins",
      makeMap(special),
      makeRegex(special.map((c) => c.name)),
    );
    expect(out.characterName).toBe("dr. o'neil (sr.)");
    expect(out.textToSpeak).toBe('the operation begins');
  });
});

describe('audio.buildSegments', () => {
  const narrator = 'Kore';

  it('inserts 1500 ms pauses after title and chapter title', () => {
    const segs = audio.buildSegments({
      title: 'Book',
      chapterTitle: 'Chapter 1',
      text: 'Hello.',
      narratorVoice: narrator,
      characters: [],
    });
    expect(segs.filter((s: any) => s.kind === 'pause').map((s: any) => s.ms)).toEqual([1500, 1500]);
    expect(segs[0]).toMatchObject({ kind: 'speech', text: 'Book', voice: narrator });
    expect(segs[2]).toMatchObject({ kind: 'speech', text: 'Chapter 1', voice: narrator });
  });

  it('inserts 250 ms gaps between consecutive speech segments', () => {
    const segs = audio.buildSegments({
      text: 'Alice: Hi.\nBob: Hello.',
      narratorVoice: narrator,
      characters: [
        { name: 'Alice', voice: 'Puck' },
        { name: 'Bob', voice: 'Fenrir' },
      ],
    });
    const pauses = segs.filter((s: any) => s.kind === 'pause');
    expect(pauses).toEqual([{ kind: 'pause', ms: 250 }]);
    expect(segs.filter((s: any) => s.kind === 'speech').map((s: any) => s.text)).toEqual(['Hi.', 'Hello.']);
  });

  it('merges consecutive cue-less narration until 1800 chars', () => {
    const a = 'A'.repeat(1000);
    const b = 'B'.repeat(700);
    const c = 'C'.repeat(200);
    const segs = audio.buildSegments({
      text: `${a}\n\n${b}\n\n${c}`,
      narratorVoice: narrator,
      characters: [],
    });
    const speech = segs.filter((s: any) => s.kind === 'speech');
    expect(speech).toHaveLength(2);
    expect(speech[0].text).toBe(`${a}\n\n${b}`);
    expect(speech[0].text.length).toBe(1000 + 2 + 700);
    expect(speech[1].text).toBe(c);
  });

  it('never merges dialogue or cued lines', () => {
    const segs = audio.buildSegments({
      text: '(cold) Night fell.\nAlice: Hello.\nMore narration.',
      narratorVoice: narrator,
      characters: [{ name: 'Alice', voice: 'Puck' }],
    });
    const speech = segs.filter((s: any) => s.kind === 'speech');
    expect(speech).toHaveLength(3);
    expect(speech[0].text).toBe('Say cold: Night fell.');
    expect(speech[1]).toMatchObject({ text: 'Hello.', voice: 'Puck' });
    expect(speech[2]).toMatchObject({ text: 'More narration.', voice: narrator });
  });

  it('splits an oversized paragraph at a sentence boundary', () => {
    const first = `${'A'.repeat(1590)}. `;
    const rest = `${'B'.repeat(400)}.`;
    const segs = audio.buildSegments({
      text: first + rest,
      narratorVoice: narrator,
      characters: [],
    });
    const speech = segs.filter((s: any) => s.kind === 'speech');
    expect(speech.length).toBeGreaterThanOrEqual(2);
    expect(speech[0].text.endsWith('.')).toBe(true);
    expect(speech[0].text.length).toBeLessThanOrEqual(1800);
    expect(speech[1].text).toContain('B');
  });
});

describe('audio.parseWavSampleRate', () => {
  it('reads the fmt chunk rate from a WAV', () => {
    const wav = audio.pcmToWav(new Int16Array([1]), 16000);
    expect(audio.parseWavSampleRate(wav)).toBe(16000);
  });

  it('returns null for raw PCM', () => {
    expect(audio.parseWavSampleRate(Buffer.from([1, 0, 2, 0]))).toBeNull();
  });
});

const SAMPLE_PCM = new Int16Array([100, -100, 200, -200, 300]);
const SAMPLE_B64 = Buffer.from(SAMPLE_PCM.buffer, SAMPLE_PCM.byteOffset, SAMPLE_PCM.byteLength).toString('base64');

function ttsBody(parts: any[], extra: any = {}) {
  return { candidates: [{ content: { parts } }], ...extra };
}

describe('gemini.extractAudio / buildTtsRequest', () => {
  it('extracts the first inlineData audio part', () => {
    const out = gemini.extractAudio(
      ttsBody([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: SAMPLE_B64 } }]),
    );
    expect([...out.pcm]).toEqual([...SAMPLE_PCM]);
    expect(out.sampleRate).toBe(24000);
  });

  it('accepts snake_case inline_data', () => {
    const out = gemini.extractAudio(
      ttsBody([{ inline_data: { mime_type: 'audio/L16;codec=pcm;rate=16000', data: SAMPLE_B64 } }]),
    );
    expect(out.sampleRate).toBe(16000);
    expect([...out.pcm]).toEqual([...SAMPLE_PCM]);
  });

  it('WAV inline data: fmt chunk rate wins over mime', () => {
    const wav = audio.pcmToWav(SAMPLE_PCM, 16000);
    const out = gemini.extractAudio(
      ttsBody([
        {
          inlineData: {
            mimeType: 'audio/L16;codec=pcm;rate=24000',
            data: wav.toString('base64'),
          },
        },
      ]),
    );
    expect(out.sampleRate).toBe(16000);
    expect([...out.pcm]).toEqual([...SAMPLE_PCM]);
  });

  it('text-only parts → upstream_error, no audio', () => {
    expect(() => gemini.extractAudio(ttsBody([{ text: 'sorry' }]))).toThrow(
      expect.objectContaining({ code: 'upstream_error', message: 'gemini: no audio in response' }),
    );
  });

  it('blockReason → gemini: blocked (reason), never leaks other text', () => {
    expect(() => gemini.extractAudio({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(
      expect.objectContaining({ code: 'upstream_error', message: 'gemini: blocked (SAFETY)' }),
    );
  });

  it('buildTtsRequest uses AUDIO modality, canonical voice, and Say style prefix', () => {
    expect(gemini.buildTtsRequest({ text: 'hello', voice: 'Puck' })).toEqual({
      contents: [{ parts: [{ text: 'hello' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      },
    });
    expect(gemini.buildTtsRequest({ text: 'hello', voice: 'Kore', style: 'whisper' }).contents[0].parts[0].text).toBe(
      'Say whisper: hello',
    );
  });

  it('endpointFor has no query string', () => {
    const url = gemini.endpointFor(gemini.MODELS['gemini-3.8-flash-lite-tts']);
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent',
    );
    expect(url).not.toContain('key=');
  });
});

describe('gemini.synthesize', () => {
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

  it('posts x-goog-api-key header, never puts the key in the URL, returns pcm', async () => {
    const { ctx, fetchMock } = fakeGeminiCtx(
      async () =>
        new Response(
          JSON.stringify(
            ttsBody([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: SAMPLE_B64 } }]),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const out = await gemini.synthesize(ctx, 'secret-key', {
      text: 'hi',
      voice: 'Kore',
      model: 'gemini-3.8-flash-lite-tts',
    });
    expect([...out.pcm]).toEqual([...SAMPLE_PCM]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('secret-key');
    expect(url).not.toContain('?key=');
    expect(init.headers['x-goog-api-key']).toBe('secret-key');
    expect(JSON.stringify(out)).not.toContain('secret-key');
  });

  it('HTTP 400 → upstream_error with no upstream body text', async () => {
    const { ctx } = fakeGeminiCtx(
      async () => new Response(JSON.stringify({ error: { message: 'leaked-secret' } }), { status: 400 }),
    );
    const err: any = await gemini
      .synthesize(ctx, 'k', { text: 'hi', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts' })
      .catch((e: any) => e);
    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('gemini (gemini-3.8-flash-lite-tts): HTTP 400');
    expect(err.message).not.toContain('leaked-secret');
  });

  it('200 HTML body → invalid JSON response', async () => {
    const { ctx } = fakeGeminiCtx(async () => new Response('<html>leaked</html>', { status: 200 }));
    const err: any = await gemini
      .synthesize(ctx, 'k', { text: 'hi', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts' })
      .catch((e: any) => e);
    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('gemini: invalid JSON response');
    expect(err.message).not.toContain('leaked');
  });

  it('TimeoutError → timeout', async () => {
    const { ctx } = fakeGeminiCtx(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(
      gemini.synthesize(ctx, 'k', { text: 'hi', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts' }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('retries once on 503 then succeeds; does not retry 400', async () => {
      const prev = gemini.config.retryBackoffMs;
    gemini.config.retryBackoffMs = 0;
    try {
      let n = 0;
      const { ctx, fetchMock } = fakeGeminiCtx(async () => {
        n += 1;
        if (n === 1) return new Response('{}', { status: 503 });
        return new Response(
          JSON.stringify(
            ttsBody([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: SAMPLE_B64 } }]),
          ),
          { status: 200 },
        );
      });
      await gemini.synthesize(ctx, 'k', { text: 'hi', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts' });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const bad = fakeGeminiCtx(async () => new Response('{}', { status: 400 }));
      await expect(
        gemini.synthesize(bad.ctx, 'k', { text: 'hi', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts' }),
      ).rejects.toMatchObject({ code: 'upstream_error' });
      expect(bad.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      gemini.config.retryBackoffMs = prev;
    }
  });
});

const AGENT = { kind: 'agent', conversationId: 'conv-test-1' } as any;
const OPERATOR = { kind: 'operator' } as any;

function geminiTtsOk(pcm: Int16Array = SAMPLE_PCM, rate = 24000) {
  const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  return new Response(
    JSON.stringify(ttsBody([{ inlineData: { mimeType: `audio/L16;codec=pcm;rate=${rate}`, data: b64 } }])),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function pcmFilled(value: number, n = 8) {
  return new Int16Array(n).fill(value);
}

function fakeCtx(opts: { key?: string; fetchImpl?: (...a: any[]) => Promise<any> } = {}) {
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => new Response('{}', { status: 500 })));
  const ctx = {
    manifest: {
      id: 'gemini-audiobook',
      capabilities: [
        { name: 'audio.generate', agentCallable: true, rateLimitPerMin: 10 },
        { name: 'audiobook.generate.chapter', agentCallable: true, rateLimitPerMin: 2 },
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
  const generate = ctx.capability.mock.calls.find((c: any[]) => c[0] === 'audio.generate')?.[1];
  const chapter = ctx.capability.mock.calls.find((c: any[]) => c[0] === 'audiobook.generate.chapter')?.[1];
  if (!generate || !chapter) throw new Error('plugin did not register both capabilities');
  return { ctx, fetchMock, generate, chapter };
}

let tmp = '';
const oldDb = process.env.TIERWYN_DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gemini-audiobook-test-'));
  process.env.TIERWYN_DB = join(tmp, 'test.db');
  plugin.resetFfmpegProbe?.();
});

afterEach(() => {
  if (oldDb === undefined) delete process.env.TIERWYN_DB;
  else process.env.TIERWYN_DB = oldDb;
  rmSync(tmp, { recursive: true, force: true });
  plugin.resetFfmpegProbe?.();
  gemini.config.retryBackoffMs = 2_000;
  if (plugin.config) plugin.config.chapterBudgetMs = 280_000;
});

describe('gemini-audiobook input validation', () => {
  it('rejects missing/empty/oversized audio text without fetch', async () => {
    const { fetchMock, generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    for (const bad of [null, undefined, {}, { text: '' }, { text: '   ' }, { text: 42 }, { text: 'x'.repeat(5001) }]) {
      await expect(generate(bad, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('oversized audio text tells the caller to use generate.chapter', () => {
    expect(() => plugin.validateAudioInput({ text: 'x'.repeat(5001) })).toThrow(
      expect.objectContaining({ code: 'bad_input', message: expect.stringMatching(/generate\.chapter/) }),
    );
  });

  it('rejects unknown voice or model without fetch', async () => {
    const { fetchMock, generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    await expect(generate({ text: 'hi', voice: 'NotAVoice' }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(generate({ text: 'hi', model: 'dall-e' }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects path-like filenames without fetch', async () => {
    const { fetchMock, generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    for (const filename of ['../../etc/passwd', 'a/b', 'a\\b', '..', '.hidden', 'a b']) {
      await expect(generate({ text: 'hi', filename }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate / too many characters and >48 segments without fetch', async () => {
    const { fetchMock, chapter } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    await expect(
      chapter({ text: 'Hi', characters: [{ name: 'A', voice: 'Puck' }, { name: 'A', voice: 'Kore' }] }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, voice: 'Puck' }));
    await expect(chapter({ text: 'Hi', characters: nine }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    const lines = Array.from({ length: 49 }, (_, i) => `Alice: line ${i}.`).join('\n');
    await expect(
      chapter({ text: lines, characters: [{ name: 'Alice', voice: 'Puck' }] }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown format', () => {
    expect(() => plugin.validateAudioInput({ text: 'hi', format: 'ogg' })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
  });
});

describe('gemini-audiobook handler', () => {
  it('missing or empty key → credential_missing; fetch not called', async () => {
    const a = fakeCtx({ key: undefined });
    await expect(a.generate({ text: 'hi' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
    expect(a.fetchMock).not.toHaveBeenCalled();
    const b = fakeCtx({ key: '' });
    await expect(b.generate({ text: 'hi' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
    expect(b.fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: writes WAV in the agent shard, returns metadata, key never in body/url', async () => {
    const { fetchMock, generate } = fakeCtx({ key: 'test-key', fetchImpl: async () => geminiTtsOk() });
    const out = await generate({ text: 'Hello from Tierwyn.', voice: 'puck', filename: 'hello' }, AGENT);
    expect(isAbsolute(out.path)).toBe(true);
    expect(out.path.startsWith(join(tmp, 'artifacts', 'conv-test-1'))).toBe(true);
    expect(out.path.endsWith('/hello.wav')).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(out.mime).toBe('audio/wav');
    expect(out.sampleRate).toBe(24000);
    expect(out.segments).toBe(1);
    expect(out.bytes).toBe(statSize(out.path));
    expect(out.durationSec).toBeGreaterThan(0);
    const wav = readFileSync(out.path);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain('/models/gemini-3.8-flash-lite-tts:generateContent');
    expect(url).not.toContain('test-key');
    expect(url).not.toContain('?key=');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(init.body);
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
    expect(JSON.stringify(out)).not.toContain('test-key');
  });

  it('style prefixes the spoken text', async () => {
    const { fetchMock, generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    await generate({ text: 'hello', style: 'whisper' }, AGENT);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body).contents[0].parts[0].text).toBe(
      'Say whisper: hello',
    );
  });

  it('existing filename → bad_input BEFORE the paid call', async () => {
    const { fetchMock, generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    const first = await generate({ text: 'hi', filename: 'fox' }, AGENT);
    await expect(generate({ text: 'hi', filename: 'fox' }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(first.path)).toBe(true);
  });

  it('agent with no conversation id → bad_input without fetch; operator → artifacts/operator', async () => {
    const anon = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    await expect(anon.generate({ text: 'hi' }, { kind: 'agent' })).rejects.toMatchObject({ code: 'bad_input' });
    expect(anon.fetchMock).not.toHaveBeenCalled();
    const op = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
    const out = await op.generate({ text: 'hi' }, OPERATOR);
    expect(out.path.startsWith(join(tmp, 'artifacts', 'operator'))).toBe(true);
  });

  it('HTTP 400 → upstream_error with no upstream text', async () => {
    const { generate } = fakeCtx({
      key: 'k',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'leaked-upstream' } }), { status: 400 }),
    });
    const err: any = await generate({ text: 'hi' }, AGENT).catch((e: any) => e);
    expect(err.code).toBe('upstream_error');
    expect(err.message).not.toContain('leaked-upstream');
  });

  it('TimeoutError → timeout', async () => {
    const { generate } = fakeCtx({
      key: 'k',
      fetchImpl: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    await expect(generate({ text: 'hi' }, AGENT)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('chapter keeps segment order even when fetches complete out of order', async () => {
    const { fetchMock, chapter } = fakeCtx({
      key: 'k',
      fetchImpl: async (_url: string, init: any) => {
        const text = JSON.parse(init.body).contents[0].parts[0].text;
        if (text === 'Hi.') await new Promise((r) => setTimeout(r, 40));
        const v = text === 'Hi.' ? 111 : 222;
        return geminiTtsOk(pcmFilled(v, 4));
      },
    });
    const out = await chapter(
      {
        text: 'Alice: Hi.\nBob: Hello.',
        characters: [
          { name: 'Alice', voice: 'Puck' },
          { name: 'Bob', voice: 'Fenrir' },
        ],
        filename: 'ordered',
      },
      AGENT,
    );
    const pcm = audio.extractPcm(readFileSync(out.path));
    const voices = fetchMock.mock.calls.map((c: any[]) => {
      const b = JSON.parse(c[1].body);
      return {
        text: b.contents[0].parts[0].text,
        voice: b.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      };
    });
    expect(voices).toEqual(
      expect.arrayContaining([
        { text: 'Hi.', voice: 'Puck' },
        { text: 'Hello.', voice: 'Fenrir' },
      ]),
    );
    // After ramps, first speech block is 111-based, then 250ms silence, then 222-based.
    expect(pcm[0]).toBe(0); // ramp start
    const firstMid = pcm[1];
    expect(firstMid).toBeGreaterThan(0);
    expect(pcm[pcm.length - 1]).toBe(0); // ramp end
  });

  it('chapter deadline abort → timeout, no artifact written', async () => {
    const prev = plugin.config.chapterBudgetMs;
    plugin.config.chapterBudgetMs = 20;
    try {
      const { chapter, fetchMock } = fakeCtx({
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
      const err: any = await chapter(
        {
          text: 'Alice: Hi.\nBob: Hello.',
          characters: [
            { name: 'Alice', voice: 'Puck' },
            { name: 'Bob', voice: 'Fenrir' },
          ],
          filename: 'late',
        },
        AGENT,
      ).catch((e: any) => e);
      expect(err.code).toBe('timeout');
      expect(err.message).toMatch(/split the chapter/);
      expect(existsSync(join(tmp, 'artifacts', 'conv-test-1', 'late.wav'))).toBe(false);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    } finally {
      plugin.config.chapterBudgetMs = prev;
    }
  });

  it('mp3 without ffmpeg → bad_input before the paid call', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/tmp/no-ffmpeg-bin';
    plugin.resetFfmpegProbe();
    try {
      const { fetchMock, generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk() });
      await expect(generate({ text: 'hi', format: 'mp3', filename: 'nope' }, AGENT)).rejects.toMatchObject({
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
    const longPcm = new Int16Array(24000); // 1s of silence-ish
    for (let i = 0; i < longPcm.length; i++) longPcm[i] = Math.round(Math.sin(i / 20) * 8000);
    const { generate } = fakeCtx({ key: 'k', fetchImpl: async () => geminiTtsOk(longPcm) });
    const out = await generate({ text: 'hi', format: 'mp3', filename: 'hello' }, AGENT);
    expect(out.path.endsWith('/hello.mp3')).toBe(true);
    expect(out.mime).toBe('audio/mpeg');
    expect(existsSync(out.path)).toBe(true);
    const buf = readFileSync(out.path);
    expect(buf.length).toBeGreaterThan(100);
    const ff = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', out.path],
      { encoding: 'utf8' },
    );
    if (ff.status === 0) {
      const info = JSON.parse(ff.stdout);
      expect(info.streams[0].codec_name).toBe('mp3');
      expect(String(info.streams[0].channels)).toBe('1');
    }
  });
});

describe('gemini-audiobook manifest example', () => {
  it('plugin.json.example validates and matches registered capabilities', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    expect(validateManifest(json)).toEqual({ ok: true, manifest: expect.objectContaining({ id: 'gemini-audiobook' }) });
    const names = json.capabilities.map((c: any) => c.name).sort();
    expect(names).toEqual(['audio.generate', 'audiobook.generate.chapter']);
    const audioCap = json.capabilities.find((c: any) => c.name === 'audio.generate');
    const chapterCap = json.capabilities.find((c: any) => c.name === 'audiobook.generate.chapter');
    expect(audioCap.timeoutMs).toBe(120000);
    expect(chapterCap.timeoutMs).toBe(300000);
    expect(chapterCap.timeoutMs).toBeLessThanOrEqual(300000);
    expect(audioCap.rateLimitPerMin).toBe(10);
    expect(chapterCap.rateLimitPerMin).toBe(2);
    expect(json.permissions).toEqual(['outbound:https://generativelanguage.googleapis.com']);
    for (const spec of Object.values(gemini.MODELS) as any[]) {
      expect(spec.fetchMs).toBeLessThan(chapterCap.timeoutMs);
    }
  });

  it('HELP.md documents both capabilities, models, and format', () => {
    const help = readFileSync(join(pluginDir, 'HELP.md'), 'utf8');
    expect(help).toContain('audio.generate');
    expect(help).toContain('audiobook.generate.chapter');
    for (const key of Object.keys(gemini.MODELS)) {
      expect(help).toContain(key);
    }
    expect(help).toContain('format');
    expect(help).toContain('ffmpeg');
    expect(help.length).toBeLessThan(64 * 1024);
  });
});

function statSize(p: string) {
  return readFileSync(p).length;
}
