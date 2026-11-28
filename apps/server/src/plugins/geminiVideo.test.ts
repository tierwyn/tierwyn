// Tests for the gemini-video plugin (plain JS at plugin-src/gemini-video).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateManifest } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '../../../../plugin-src/gemini-video');
const plugin: any = await import(join(pluginDir, 'index.js'));

const MP4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00', 'latin1'), Buffer.alloc(32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const AGENT = { kind: 'agent', conversationId: 'conv-video-1' } as any;

function interactionInlineOk(video: Buffer, id = 'v1_abc123') {
  const body = {
    id,
    status: 'completed',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
      { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: video.toString('base64') }] },
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
  const call = (ctx.capability as any).mock.calls.find((c: any[]) => c[0] === 'video.generate');
  return { fetchMock, handler: call[1] as (input: any, caller: any) => Promise<any> };
}

let tmp = '';
const oldDb = process.env.TIERWYN_DB;
beforeEach(() => {
  plugin.setPollIntervalMsForTests(0);
  tmp = mkdtempSync(join(tmpdir(), 'gemini-video-test-'));
  process.env.TIERWYN_DB = join(tmp, 'test.db');
});
afterEach(() => {
  plugin.setPollIntervalMsForTests(4_000);
  if (oldDb === undefined) delete process.env.TIERWYN_DB;
  else process.env.TIERWYN_DB = oldDb;
  rmSync(tmp, { recursive: true, force: true });
});

describe('gemini-video', () => {
  it('manifest example validates', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    expect(validateManifest(json)).toEqual({ ok: true, manifest: expect.objectContaining({ id: 'gemini-video' }) });
  });

  it('rejects bad input', () => {
    for (const bad of [
      null,
      {},
      { prompt: '' },
      { prompt: 'x'.repeat(8001) },
      { prompt: 'a', model: 'veo-old' },
      { prompt: 'a', aspectRatio: '4:3' },
      { prompt: 'a', resolution: '8K' },
      { prompt: 'a', duration: 2 },
      { prompt: 'a', duration: 16 },
      { prompt: 'a', duration: 'fast' },
      { prompt: 'a', inputImages: ['1', '2', '3'] },
      { prompt: 'a', inputImages: ['1', '2'], duration: 12 },
      { prompt: 'a', previousInteractionId: 'bad id with spaces' },
      { prompt: 'a', filename: '../escape' },
    ]) {
      expect(() => plugin.validateInput(bad)).toThrow(expect.objectContaining({ code: 'bad_input' }));
    }
  });

  it('builds request for text-to-video, resolution/duration normalisation, previousInteractionId, and images', () => {
    const basic = plugin.buildRequest(
      plugin.validateInput({
        prompt: 'Misty valley at dawn',
        resolution: '4k',
        aspectRatio: '9:16',
        duration: 8,
        previousInteractionId: 'v1_prev_99',
      }),
    );
    expect(basic).toEqual({
      model: 'gemini-omni-1.2-flash',
      input: 'Misty valley at dawn',
      response_format: { type: 'video', resolution: '4K', aspect_ratio: '9:16', duration: '8s' },
      background: true,
      store: true,
      previous_interaction_id: 'v1_prev_99',
    });

    const withImages = plugin.buildRequest({
      ...plugin.validateInput({ prompt: 'Smooth transition', duration: '6s' }),
      images: [{ mimeType: 'image/png', data: 'AAAA' }],
    });
    expect(withImages.input).toEqual([
      { type: 'image', mime_type: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'Smooth transition' },
    ]);
  });

  it('happy path writes inline MP4 into caller shard and returns path + interactionId, key only in header', async () => {
    const { handler, fetchMock } = fakeCtx({ key: 'sekret-key-123', fetchImpl: async () => interactionInlineOk(MP4) });
    const out = await handler({ prompt: 'dawn valley', resolution: '720p', duration: 5, filename: 'clip' }, AGENT);
    expect(out).toMatchObject({
      mime: 'video/mp4',
      bytes: MP4.length,
      model: 'gemini-omni-1.2-flash',
      interactionId: 'v1_abc123',
    });
    expect(out.path).toBe(join(tmp, 'artifacts', 'conv-video-1', 'clip.mp4'));
    expect(readFileSync(out.path)).toEqual(MP4);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(plugin.ENDPOINT);
    expect(init.headers['x-goog-api-key']).toBe('sekret-key-123');
    expect(init.body).not.toContain('sekret');

    await expect(handler({ prompt: 'again', filename: 'clip' }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // existing filename fails before a paid call
  });

  it('polls in_progress interactions and downloads URI-delivered MP4', async () => {
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/file123:download?alt=media';
    const responses = [
      new Response(JSON.stringify({ id: 'v1_poll_1', status: 'in_progress', steps: [] }), { status: 200 }),
      new Response(
        JSON.stringify({
          id: 'v1_poll_1',
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri }] }],
        }),
        { status: 200 },
      ),
      new Response(MP4, { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
    ];
    let i = 0;
    const { handler, fetchMock } = fakeCtx({
      key: 'k-secret-999',
      fetchImpl: async () => responses[i++],
    });

    const out = await handler({ prompt: 'city skyline', filename: 'skyline.mp4' }, AGENT);
    expect(out).toMatchObject({
      path: join(tmp, 'artifacts', 'conv-video-1', 'skyline.mp4'),
      mime: 'video/mp4',
      bytes: MP4.length,
      interactionId: 'v1_poll_1',
    });
    expect(readFileSync(out.path)).toEqual(MP4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(`${plugin.ENDPOINT}/v1_poll_1`);
    expect(fetchMock.mock.calls[2][0]).toBe(uri);
  });

  it('confines inputImages to the caller artifacts shard', async () => {
    const shardDir = join(tmp, 'artifacts', 'conv-video-1');
    mkdirSync(shardDir, { recursive: true });
    const goodImg = join(shardDir, 'frame1.png');
    const outsideImg = join(tmp, 'outside.png');
    writeFileSync(goodImg, PNG);
    writeFileSync(outsideImg, PNG);

    const { handler } = fakeCtx({ key: 'k', fetchImpl: async () => interactionInlineOk(MP4) });
    const out = await handler({ prompt: 'animate this', inputImages: [goodImg], filename: 'anim' }, AGENT);
    expect(out.path).toBe(join(shardDir, 'anim.mp4'));

    await expect(
      handler({ prompt: 'escape', inputImages: [outsideImg], filename: 'esc' }, AGENT),
    ).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('error mapping: missing key, HTTP error, failed status, invalid bytes, timeout', async () => {
    await expect(fakeCtx().handler({ prompt: 'x' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
    await expect(
      fakeCtx({ key: 'k', fetchImpl: async () => new Response('no', { status: 403 }) }).handler({ prompt: 'x' }, AGENT),
    ).rejects.toMatchObject({ code: 'upstream_error' });
    const failed = async () => new Response(JSON.stringify({ status: 'failed', steps: [] }), { status: 200 });
    await expect(fakeCtx({ key: 'k', fetchImpl: failed }).handler({ prompt: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('status failed'),
    });
    const badBytes = async () => interactionInlineOk(Buffer.from('not-a-video'));
    await expect(fakeCtx({ key: 'k', fetchImpl: badBytes }).handler({ prompt: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'upstream_error',
    });
    const slow = async () => {
      throw new DOMException('timeout', 'TimeoutError');
    };
    await expect(fakeCtx({ key: 'k', fetchImpl: slow }).handler({ prompt: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
