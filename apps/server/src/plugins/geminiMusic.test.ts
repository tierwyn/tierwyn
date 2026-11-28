// Tests for the gemini-music plugin (plain JS at plugin-src/gemini-music).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateManifest } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '../../../../plugin-src/gemini-music');
const plugin: any = await import(join(pluginDir, 'index.js'));

const WAV = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(32)]);
const MP3 = Buffer.concat([Buffer.from('ID3\x04', 'latin1'), Buffer.alloc(32)]);
const AGENT = { kind: 'agent', conversationId: 'conv-music-1' } as any;

function interactionOk(audio: Buffer, mime = 'audio/wav', text = '[Intro] soft keys') {
  const body = {
    status: 'completed',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
      { type: 'model_output', content: [{ type: 'text', text }, { type: 'audio', mime_type: mime, data: audio.toString('base64') }] },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeCtx(opts: { key?: string; fetchImpl?: (...a: any[]) => Promise<any> } = {}) {
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => new Response('{}', { status: 500 })));
  const ctx = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    credentials: { get: vi.fn(() => opts.key) },
    http: { fetch: fetchMock },
    capability: vi.fn(),
  };
  plugin.default.activate(ctx as any);
  const call = (ctx.capability as any).mock.calls.find((c: any[]) => c[0] === 'music.generate');
  return { fetchMock, handler: call[1] as (input: any, caller: any) => Promise<any> };
}

let tmp = '';
const oldDb = process.env.TIERWYN_DB;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gemini-music-test-'));
  process.env.TIERWYN_DB = join(tmp, 'test.db');
});
afterEach(() => {
  if (oldDb === undefined) delete process.env.TIERWYN_DB;
  else process.env.TIERWYN_DB = oldDb;
  rmSync(tmp, { recursive: true, force: true });
});

describe('gemini-music', () => {
  it('manifest example validates', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    expect(validateManifest(json)).toEqual({ ok: true, manifest: expect.objectContaining({ id: 'gemini-music' }) });
  });

  it('rejects bad input', () => {
    for (const bad of [null, {}, { prompt: '' }, { prompt: 'x'.repeat(8001) }, { prompt: 'a', model: 'nope' },
      { prompt: 'a', model: 'lyria-3-clip-preview', format: 'wav' }, { prompt: 'a', instrumental: 'yes' },
      { prompt: 'a', filename: '../x' }]) {
      expect(() => plugin.validateInput(bad)).toThrow(expect.objectContaining({ code: 'bad_input' }));
    }
  });

  it('request: WAV asks for audio/wav, instrumental appends the suffix, MP3 sends no format', () => {
    const wav = plugin.buildRequest(plugin.validateInput({ prompt: 'lofi', format: 'wav', instrumental: true }));
    expect(wav).toEqual({ model: 'lyria-3.5', input: 'lofi\n\nInstrumental only, no vocals.',
      response_format: { type: 'audio', mime_type: 'audio/wav' } });
    expect(plugin.buildRequest(plugin.validateInput({ prompt: 'x', model: 'lyria-3-clip-preview' })))
      .toEqual({ model: 'lyria-3-clip-preview', input: 'x' });
  });

  it('happy path writes the WAV into the caller shard and returns path + lyrics, key only in the header', async () => {
    const { handler, fetchMock } = fakeCtx({ key: 'sekret-key-123', fetchImpl: async () => interactionOk(WAV) });
    const out = await handler({ prompt: 'lofi', format: 'wav', filename: 'bed' }, AGENT);
    expect(out).toMatchObject({ mime: 'audio/wav', bytes: WAV.length, model: 'lyria-3.5', lyrics: '[Intro] soft keys' });
    expect(out.path).toBe(join(tmp, 'artifacts', 'conv-music-1', 'bed.wav'));
    expect(readFileSync(out.path)).toEqual(WAV);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(plugin.ENDPOINT);
    expect(init.headers['x-goog-api-key']).toBe('sekret-key-123');
    expect(init.body).not.toContain('sekret');
    await expect(handler({ prompt: 'again', filename: 'bed' }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // existing filename fails before a paid call
  });

  it('extension follows the returned audio (MP3)', async () => {
    const { handler } = fakeCtx({ key: 'k', fetchImpl: async () => interactionOk(MP3, 'audio/mp3', '') });
    const out = await handler({ prompt: 'x', filename: 'song.wav' }, AGENT);
    expect(out.path.endsWith('song.mp3')).toBe(true);
    expect(out.lyrics).toBeUndefined();
  });

  it('error mapping: missing key, HTTP error, no audio, timeout', async () => {
    await expect(fakeCtx().handler({ prompt: 'x' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
    await expect(fakeCtx({ key: 'k', fetchImpl: async () => new Response('no', { status: 403 }) }).handler({ prompt: 'x' }, AGENT))
      .rejects.toMatchObject({ code: 'upstream_error' });
    const noAudio = async () => new Response(JSON.stringify({ status: 'failed', steps: [] }), { status: 200 });
    await expect(fakeCtx({ key: 'k', fetchImpl: noAudio }).handler({ prompt: 'x' }, AGENT))
      .rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('status failed') });
    const slow = async () => { throw new DOMException('timeout', 'TimeoutError'); };
    await expect(fakeCtx({ key: 'k', fetchImpl: slow }).handler({ prompt: 'x' }, AGENT)).rejects.toMatchObject({ code: 'timeout' });
  });
});
