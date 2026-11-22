// Tests for the gemini-image plugin (plain JS at plugins/gemini-image).
// exercises the real module: input validation, happy path against a fake fetch,
// manifest example consistency, caller sharding, timeout mapping.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { validateManifest } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '../../../../plugin-src/gemini-image');
const plugin: any = await import(join(pluginDir, 'index.js'));

// 1x1 transparent PNG, base64 — tiny but a real PNG signature.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_1x1, 'base64');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Tiny synthetic JPEG (SOI + a few bytes + EOI) — magic-byte check only needs FF D8 FF.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01]);
const JPEG_B64 = JPEG_BYTES.toString('base64');
// RIFF....WEBP header; sniff only reads 12 bytes.
const WEBP_BYTES = Buffer.from('RIFF\x0c\x00\x00\x00WEBP', 'latin1');

const AGENT = { kind: 'agent', conversationId: 'conv-test-1' } as any;
const OPERATOR = { kind: 'operator' } as any;

/** buildGeminiRequest-shaped 200 response carrying the given parts (default: one inline PNG part). */
function geminiOk(parts: any[] = [{ inlineData: { mimeType: 'image/png', data: PNG_1x1 } }]) {
  const body = { candidates: [{ content: { parts } }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeCtx(opts: { key?: string; fetchImpl?: (...a: any[]) => Promise<any>; settings?: any } = {}) {
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => new Response('{}', { status: 500 })));
  const ctx = {
    manifest: {
      id: 'gemini-image',
      capabilities: [{ name: 'image.generate', agentCallable: true, rateLimitPerMin: 4 }],
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { get: () => opts.settings ?? {} },
    credentials: { get: vi.fn(() => opts.key) },
    http: { fetch: fetchMock },
    capability: vi.fn(),
    onDeactivate: vi.fn(),
  };
  plugin.default.activate(ctx as any);
  const call = (ctx.capability as any).mock.calls.find((c: any[]) => c[0] === 'image.generate');
  if (!call) throw new Error('plugin did not register image.generate');
  return { ctx, fetchMock, handler: call[1] as (input: any, caller: any) => Promise<any> };
}

let tmp = '';
const oldDb = process.env.TIERWYN_DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gemini-image-test-'));
  process.env.TIERWYN_DB = join(tmp, 'test.db');
});

afterEach(() => {
  if (oldDb === undefined) delete process.env.TIERWYN_DB;
  else process.env.TIERWYN_DB = oldDb;
  rmSync(tmp, { recursive: true, force: true });
});

describe('gemini-image input validation', () => {
  it('rejects missing/empty/oversized prompts with bad_input', () => {
    for (const bad of [null, undefined, {}, { prompt: '' }, { prompt: '   ' }, { prompt: 42 }, { prompt: 'x'.repeat(8001) }]) {
      expect(() => plugin.validateInput(bad)).toThrow(expect.objectContaining({ code: 'bad_input' }));
    }
  });

  it('rejects path-like and illegal filenames with bad_input', () => {
    for (const name of ['../../etc/passwd', 'a/b', 'a\\b', '..', '.hidden', 'a b']) {
      expect(() => plugin.sanitizeFilename(name)).toThrow(expect.objectContaining({ code: 'bad_input' }));
    }
  });

  it('rejects unknown aspectRatio values and non-strings', () => {
    expect(() => plugin.validateInput({ prompt: 'a cat', aspectRatio: '7:3' })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateInput({ prompt: 'a cat', aspectRatio: 16 })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
  });

  it('accepts valid input and normalises filename + prompt', () => {
    const out = plugin.validateInput({ prompt: '  a cat  ', aspectRatio: '16:9', filename: 'fox' });
    expect(out).toMatchObject({ prompt: 'a cat', aspectRatio: '16:9', filename: 'fox.png' });
    const minimal = plugin.validateInput({ prompt: 'a cat' });
    expect(minimal.aspectRatio).toBeUndefined();
    expect(minimal.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
  });
});

describe('gemini-image handler', () => {
  it('missing key -> credential_missing; empty string key too', async () => {
    const a = fakeCtx({ key: undefined });
    await expect(a.handler({ prompt: 'a cat' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
    const b = fakeCtx({ key: '' });
    await expect(b.handler({ prompt: 'a cat' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
  });

  it('fetch not called when key missing', async () => {
    const { fetchMock, handler } = fakeCtx({ key: undefined });
    await expect(handler({ prompt: 'a cat' }, AGENT)).rejects.toMatchObject({ code: 'credential_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: writes PNG, returns path only, key never in body', async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'test-key', fetchImpl: async () => geminiOk() });
    const out = await handler({ prompt: 'a cat', aspectRatio: '16:9' }, AGENT);
    expect(isAbsolute(out.path)).toBe(true);
    expect(out.path.startsWith(join(tmp, 'artifacts', 'conv-test-1'))).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path).equals(PNG_BYTES)).toBe(true);
    expect(out).toEqual({ path: out.path, mime: 'image/png', bytes: PNG_BYTES.length });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(new URL(url).host).toBe('generativelanguage.googleapis.com');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
    expect(init.headers).not.toHaveProperty('Authorization');
    const body = JSON.parse(init.body);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('16:9');
    expect(init.body).not.toContain('test-key');
    expect(out.path).toMatch(/\/[0-9a-f-]{36}\.png$/);
    expect(url).not.toContain('test-key'); // key rides the x-goog-api-key header, never the query string
  });

  it('happy path with mixed [text, inlineData] parts shape', async () => {
    const { handler } = fakeCtx({
      key: 'test-key',
      fetchImpl: async () =>
        geminiOk([{ text: 'here is your image' }, { inlineData: { mimeType: 'image/png', data: PNG_1x1 } }]),
    });
    const out = await handler({ prompt: 'a cat' }, AGENT);
    expect(out.bytes).toBe(PNG_BYTES.length);
    expect(readFileSync(out.path).equals(PNG_BYTES)).toBe(true);
  });

  it('snake_case inline_data fallback works', async () => {
    const { handler } = fakeCtx({
      key: 'test-key',
      fetchImpl: async () => geminiOk([{ inline_data: { mime_type: 'image/png', data: PNG_1x1 } }]),
    });
    const out = await handler({ prompt: 'a cat' }, AGENT);
    expect(out.bytes).toBe(PNG_BYTES.length);
  });

  it('custom filename: .png appended, collision -> bad_input BEFORE the paid call', async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    const out = await handler({ prompt: 'a cat', filename: 'fox' }, AGENT);
    expect(out.path.endsWith('/fox.png')).toBe(true);
    await expect(handler({ prompt: 'a cat', filename: 'fox' }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // collision rejected pre-fetch, no second paid call
    expect(statSync(out.path).isFile()).toBe(true);
  });

  it('caller sharding: agent -> <conversationId>, no id -> bad_input without fetch, operator -> artifacts/operator', async () => {
    const agent = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    const agentOut = await agent.handler({ prompt: 'a cat' }, AGENT);
    expect(agentOut.path.startsWith(join(tmp, 'artifacts', 'conv-test-1'))).toBe(true);
    // omitted aspectRatio -> body carries no imageConfig at all
    const [, agentInit] = agent.fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(agentInit.body).generationConfig.imageConfig).toBeUndefined();

    const anon = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await expect(anon.handler({ prompt: 'a cat' }, { kind: 'agent' })).rejects.toMatchObject({
      code: 'bad_input',
    });
    expect(anon.fetchMock).not.toHaveBeenCalled();

    const op = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    const opOut = await op.handler({ prompt: 'a cat' }, OPERATOR);
    expect(opOut.path.startsWith(join(tmp, 'artifacts', 'operator'))).toBe(true);
  });

  it('timeout: fetch TimeoutError -> code timeout', async () => {
    const { handler } = fakeCtx({
      key: 'k',
      fetchImpl: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    await expect(handler({ prompt: 'a cat' }, AGENT)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('timeout during body read (json() rejects with TimeoutError) -> code timeout, not un-coded', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: 'k',
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
          },
        }) as any,
    });
    await expect(handler({ prompt: 'a cat' }, AGENT)).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('200 with non-JSON body -> upstream_error with fixed message, no upstream text leaked', async () => {
    const { handler } = fakeCtx({
      key: 'k',
      fetchImpl: async () => new Response('<!DOCTYPE html><html>leaked-upstream-secret</html>', { status: 200 }),
    });
    const err: any = await handler({ prompt: 'a cat' }, AGENT).catch((e) => e);
    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('gemini: invalid JSON response');
    expect(err.message).not.toContain('leaked-upstream-secret');
  });
});

describe('gemini-image response parsing', () => {
  it('extractImage: text-only reply and HTTP 400 both -> upstream_error', async () => {
    expect(() =>
      plugin.extractImage({ candidates: [{ content: { parts: [{ text: 'I cannot do that' }] } }] }),
    ).toThrow(expect.objectContaining({ code: 'upstream_error' }));
    expect(() =>
      plugin.extractImage({ promptFeedback: { blockReason: 'SAFETY' } }),
    ).toThrow(expect.objectContaining({ code: 'upstream_error', message: 'gemini: blocked (SAFETY)' }));
    const { handler } = fakeCtx({ key: 'k', fetchImpl: async () => new Response('{"error":{}}', { status: 400 }) });
    await expect(handler({ prompt: 'a cat' }, AGENT)).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('extractImage: non-PNG bytes under image/png mime -> upstream_error', () => {
    expect(() =>
      plugin.extractImage({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('hello').toString('base64') } }] } }],
      }),
    ).toThrow(expect.objectContaining({ code: 'upstream_error', message: 'gemini: not a valid PNG' }));
    // long enough to pass the length check and reach the 8-byte signature comparison itself
    expect(() =>
      plugin.extractImage({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('0123456789abcdef').toString('base64') } }] } }],
      }),
    ).toThrow(expect.objectContaining({ code: 'upstream_error', message: 'gemini: not a valid PNG' }));
  });
});

describe('gemini-image manifest example', () => {
  it('plugin.json.example validates and matches the hardcoded host rules', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    expect(validateManifest(json)).toEqual({ ok: true, manifest: expect.objectContaining({ id: 'gemini-image' }) });
    const cap = json.capabilities.find((c: any) => c.name === 'image.generate');
    expect(cap?.agentCallable).toBe(true);
    expect(cap?.timeoutMs).toBe(180000);
    expect(cap?.rateLimitPerMin).toBe(4);
    expect(json.capabilities.some((c: any) => c.name === 'image.remix')).toBe(false);
    expect(json.permissions).toEqual(['outbound:https://generativelanguage.googleapis.com']);
  });
});

describe('gemini-image v2 models', () => {
  it('B1 unknown model dall-e → bad_input listing valid keys', () => {
    const err = (() => {
      try {
        plugin.validateInput({ prompt: 'a cat', model: 'dall-e' });
      } catch (e) {
        return e as any;
      }
    })();
    expect(err).toMatchObject({ code: 'bad_input' });
    expect(err.message).toMatch(/gemini-3\.1-flash-image/);
    expect(err.message).toMatch(/gemini-3\.1-flash-lite-image/);
    expect(err.message).toMatch(/gemini-3-pro-image/);
    expect(err.message).not.toMatch(/2\.5-flash-image/);
  });

  it('B2 preview aliases resolve to GA ids', () => {
    expect(plugin.resolveModel('gemini-3-pro-image-preview')).toMatchObject({
      key: 'gemini-3-pro-image',
      id: 'gemini-3-pro-image',
    });
    expect(plugin.resolveModel('gemini-3.1-flash-image-preview')).toMatchObject({
      key: 'gemini-3.1-flash-image',
      id: 'gemini-3.1-flash-image',
    });
  });

  it('B3 default {prompt} hits 3.1 flash endpoint; no imageSize/thinkingConfig/tools', async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await handler({ prompt: 'a cat' }, AGENT);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(plugin.ENDPOINT);
    expect(url).toContain('/models/gemini-3.1-flash-image:generateContent');
    const body = JSON.parse(init.body);
    expect(body.generationConfig.imageConfig).toBeUndefined();
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(plugin.buildGeminiRequest({ prompt: 'a cat', aspectRatio: '16:9' })).toEqual({
      contents: [{ parts: [{ text: 'a cat' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '16:9' },
      },
    });
  });

  it("B4 pro + imageSize '4k' → GA URL and imageSize 4K", async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await handler({ prompt: 'a cat', model: 'gemini-3-pro-image', imageSize: '4k' }, AGENT);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain('/models/gemini-3-pro-image:generateContent');
    expect(url).not.toContain('preview');
    expect(JSON.parse(init.body).generationConfig.imageConfig.imageSize).toBe('4K');
  });

  it('B5 pro with no imageSize omits the key (API default 1K)', async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await handler({ prompt: 'a cat', model: 'gemini-3-pro-image' }, AGENT);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body);
    expect(body.generationConfig.imageConfig).toBeUndefined();
  });

  it("B6 imageSize '512' on pro and '2K' on lite → bad_input naming the model", () => {
    const pro = (() => {
      try {
        plugin.validateInput({ prompt: 'a', model: 'gemini-3-pro-image', imageSize: '512' });
      } catch (e) {
        return e as any;
      }
    })();
    expect(pro).toMatchObject({ code: 'bad_input' });
    expect(pro.message).toMatch(/gemini-3-pro-image/);

    const lite = (() => {
      try {
        plugin.validateInput({ prompt: 'a', model: 'gemini-3.1-flash-lite-image', imageSize: '2K' });
      } catch (e) {
        return e as any;
      }
    })();
    expect(lite).toMatchObject({ code: 'bad_input' });
    expect(lite.message).toMatch(/gemini-3\.1-flash-lite-image/);
  });

  it("B7 aspectRatio 1:8 ok on 3.1 flash; bad_input on pro", () => {
    expect(plugin.validateInput({ prompt: 'a', aspectRatio: '1:8' })).toMatchObject({ aspectRatio: '1:8' });
    const err = (() => {
      try {
        plugin.validateInput({ prompt: 'a', model: 'gemini-3-pro-image', aspectRatio: '1:8' });
      } catch (e) {
        return e as any;
      }
    })();
    expect(err).toMatchObject({ code: 'bad_input' });
    expect(err.message).toMatch(/gemini-3-pro-image/);
  });

  it('B8 AbortSignal.timeout uses per-model fetchMs', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const a = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
      await a.handler({ prompt: 'a cat' }, AGENT);
      expect(spy).toHaveBeenLastCalledWith(90_000);

      const b = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
      await b.handler({ prompt: 'a cat', model: 'gemini-3-pro-image' }, AGENT);
      expect(spy).toHaveBeenLastCalledWith(170_000);

      const c = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
      await c.handler({ prompt: 'a cat', model: 'gemini-3.1-flash-image' }, AGENT);
      expect(spy).toHaveBeenLastCalledWith(90_000);

      const d = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
      await d.handler({ prompt: 'a cat', model: 'gemini-3.1-flash-lite-image' }, AGENT);
      expect(spy).toHaveBeenLastCalledWith(30_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('B9 every MODELS fetchMs is under the example manifest timeoutMs', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    const cap = json.capabilities.find((c: any) => c.name === 'image.generate');
    expect(cap.timeoutMs).toBe(180000);
    expect(Object.keys(plugin.MODELS)).toEqual([
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
      'gemini-3-pro-image',
    ]);
    for (const spec of Object.values(plugin.MODELS) as any[]) {
      expect(spec.fetchMs).toBeLessThan(cap.timeoutMs);
    }
  });

  it("B10 thinkingLevel high on 3.1 flash → HIGH; on pro → bad_input", async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await handler({ prompt: 'a cat', thinkingLevel: 'high' }, AGENT);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body).generationConfig.thinkingConfig.thinkingLevel).toBe(
      'HIGH',
    );
    expect(() => plugin.validateInput({ prompt: 'a', model: 'gemini-3-pro-image', thinkingLevel: 'high' })).toThrow(
      expect.objectContaining({ code: 'bad_input', message: expect.stringMatching(/gemini-3-pro-image/) }),
    );
  });

  it('B11 googleSearch true on pro → tools; on lite → bad_input', async () => {
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await handler({ prompt: 'a cat', model: 'gemini-3-pro-image', googleSearch: true }, AGENT);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body).tools).toEqual([{ googleSearch: {} }]);
    expect(() =>
      plugin.validateInput({ prompt: 'a', model: 'gemini-3.1-flash-lite-image', googleSearch: true }),
    ).toThrow(expect.objectContaining({ code: 'bad_input', message: expect.stringMatching(/gemini-3\.1-flash-lite-image/) }));
  });
});

describe('gemini-image v2 inputImages + extractImage', () => {
  function shardDir() {
    const dir = join(tmp, 'artifacts', 'conv-test-1');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('B12 valid PNG in own shard is an inlineData part before text; escapes fail without fetch', async () => {
    const dir = shardDir();
    const imgPath = join(dir, 'ref.png');
    writeFileSync(imgPath, PNG_BYTES);

    const ok = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await ok.handler({ prompt: 'remix this', inputImages: [imgPath] }, AGENT);
    const parts = JSON.parse((ok.fetchMock.mock.calls[0] as [string, any])[1].body).contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe('image/png');
    expect(parts[0].inlineData.data).toBe(PNG_1x1);
    expect(parts[1].text).toBe('remix this');

    const webpPath = join(dir, 'ref.webp');
    writeFileSync(webpPath, WEBP_BYTES);
    const loaded = plugin.loadInputImages([webpPath], dir);
    expect(loaded[0].mimeType).toBe('image/webp');

    const outside = join(tmp, 'outside.png');
    writeFileSync(outside, PNG_BYTES);
    const otherDir = join(tmp, 'artifacts', 'other-conv');
    mkdirSync(otherDir, { recursive: true });
    const otherPath = join(otherDir, 'x.png');
    writeFileSync(otherPath, PNG_BYTES);
    const escapePath = join(dir, '..', '..', 'outside.png');
    const linkPath = join(dir, 'hosts-link');
    symlinkSync('/etc/hosts', linkPath);
    const junkPath = join(dir, 'junk.bin');
    writeFileSync(junkPath, Buffer.from('hello'));
    const bigPath = join(dir, 'big.png');
    const big = Buffer.alloc(7 * 1024 * 1024 + 1);
    PNG_SIGNATURE.copy(big);
    writeFileSync(bigPath, big);

    const cases: string[][] = [
      [outside],
      [escapePath],
      [linkPath],
      [otherPath],
      [junkPath],
      [bigPath],
      Array(15).fill(imgPath),
    ];
    for (const inputImages of cases) {
      const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
      await expect(handler({ prompt: 'a cat', inputImages }, AGENT)).rejects.toMatchObject({ code: 'bad_input' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('B12b symlink to a real PNG outside the shard is rejected by confinement before fetch', async () => {
    const dir = shardDir();
    const outsidePng = join(tmp, 'outside-real.png');
    writeFileSync(outsidePng, PNG_BYTES);
    const linkPath = join(dir, 'escaped.png');
    symlinkSync(outsidePng, linkPath);
    const { fetchMock, handler } = fakeCtx({ key: 'k', fetchImpl: async () => geminiOk() });
    await expect(handler({ prompt: 'a cat', inputImages: [linkPath] }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('B13 thought image first, final last → writes the last non-thought bytes', () => {
    const imgA = Buffer.concat([PNG_SIGNATURE, Buffer.from('AAA')]);
    const imgB = Buffer.concat([PNG_SIGNATURE, Buffer.from('BBB')]);
    const out = plugin.extractImage({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: imgA.toString('base64') }, thought: true },
              { inlineData: { mimeType: 'image/png', data: imgB.toString('base64') } },
            ],
          },
        },
      ],
    });
    expect(out.buf.equals(imgB)).toBe(true);
    expect(out.mime).toBe('image/png');
    expect(out.ext).toBe('png');
  });

  it('B13b thought image last is skipped so the earlier non-thought image is written', () => {
    const imgA = Buffer.concat([PNG_SIGNATURE, Buffer.from('AAA')]);
    const imgB = Buffer.concat([PNG_SIGNATURE, Buffer.from('BBB')]);
    const out = plugin.extractImage({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: imgA.toString('base64') } },
              { inlineData: { mimeType: 'image/png', data: imgB.toString('base64') }, thought: true },
            ],
          },
        },
      ],
    });
    expect(out.buf.equals(imgA)).toBe(true);
    expect(out.mime).toBe('image/png');
    expect(out.ext).toBe('png');
  });

  it("B14 JPEG response → *.jpg / image/jpeg; filename x.png + JPEG → x.jpg", async () => {
    const { handler } = fakeCtx({
      key: 'k',
      fetchImpl: async () =>
        geminiOk([{ inlineData: { mimeType: 'image/jpeg', data: JPEG_B64 } }]),
    });
    const out = await handler({ prompt: 'a cat', filename: 'x.png' }, AGENT);
    expect(out.path.endsWith('/x.jpg')).toBe(true);
    expect(out.mime).toBe('image/jpeg');
    expect(out.bytes).toBe(JPEG_BYTES.length);
    expect(readFileSync(out.path).equals(JPEG_BYTES)).toBe(true);
    expect(existsSync(join(tmp, 'artifacts', 'conv-test-1', 'x.png'))).toBe(false);
  });

  it("B14b existing x.jpg blocks filename x.png before fetch", async () => {
    const dir = shardDir();
    writeFileSync(join(dir, 'x.jpg'), JPEG_BYTES);
    const { fetchMock, handler } = fakeCtx({
      key: 'k',
      fetchImpl: async () => geminiOk(),
    });
    await expect(handler({ prompt: 'a cat', filename: 'x.png' }, AGENT)).rejects.toMatchObject({
      code: 'bad_input',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('B15 timeout and HTTP errors name the model, never the key', async () => {
    const t = fakeCtx({
      key: 'secret-key-value',
      fetchImpl: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    const tErr: any = await t.handler({ prompt: 'a cat', model: 'gemini-3-pro-image' }, AGENT).catch((e) => e);
    expect(tErr.code).toBe('timeout');
    expect(tErr.message).toMatch(/gemini-3-pro-image/);
    expect(tErr.message).toMatch(/170/);
    expect(tErr.message).not.toContain('secret-key-value');

    const h = fakeCtx({ key: 'secret-key-value', fetchImpl: async () => new Response('{}', { status: 503 }) });
    const hErr: any = await h.handler({ prompt: 'a cat', model: 'gemini-3-pro-image' }, AGENT).catch((e) => e);
    expect(hErr.code).toBe('upstream_error');
    expect(hErr.message).toMatch(/gemini-3-pro-image/);
    expect(hErr.message).toMatch(/HTTP 503/);
    expect(hErr.message).not.toContain('secret-key-value');
  });

  it('B16 HELP.md drift guard: documents every model, alias, and input field', () => {
    const help = readFileSync(join(pluginDir, 'HELP.md'), 'utf8');
    for (const key of Object.keys(plugin.MODELS)) {
      expect(help).toContain(key);
    }
    for (const alias of Object.keys(plugin.MODEL_ALIASES)) {
      expect(help).toContain(alias);
    }
    for (const field of [
      'prompt',
      'model',
      'aspectRatio',
      'imageSize',
      'thinkingLevel',
      'googleSearch',
      'inputImages',
      'filename',
    ]) {
      expect(help).toMatch(new RegExp(`\\\`${field}\\\``));
    }
  });
});
