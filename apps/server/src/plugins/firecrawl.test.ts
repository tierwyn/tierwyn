// Tests for the firecrawl plugin (plain JS at plugin-src/firecrawl).
// Import the real module; stub ctx.http.fetch; fake timers for extract polling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateManifest } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '../../../../plugin-src/firecrawl');
const plugin: any = await import(join(pluginDir, 'index.js'));

const KEY = 'fc-test-secret-key-do-not-leak';
const CRAWL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXTRACT_ID = '11111111-2222-3333-4444-555555555555';

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fakeCtx(opts: { key?: string | undefined; fetchImpl?: (...a: any[]) => Promise<any> } = {}) {
  const caps = new Map<string, (input: any, caller?: any) => Promise<any>>();
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => jsonRes({ success: false }, 500)));
  const credentialsGet = vi.fn(() => opts.key);
  const ctx = {
    manifest: {
      id: 'firecrawl',
      capabilities: [
        { name: 'web.scrape', agentCallable: true, rateLimitPerMin: 20 },
        { name: 'web.search', agentCallable: true, rateLimitPerMin: 20 },
        { name: 'web.crawl', agentCallable: true, rateLimitPerMin: 20 },
        { name: 'web.crawl.status', agentCallable: true, rateLimitPerMin: 20 },
        { name: 'web.map', agentCallable: true, rateLimitPerMin: 20 },
        { name: 'web.extract', agentCallable: true, rateLimitPerMin: 20 },
      ],
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { get: () => ({}) },
    credentials: { get: credentialsGet },
    http: { fetch: fetchMock },
    capability: vi.fn((name: string, handler: any) => {
      caps.set(name, handler);
    }),
    onDeactivate: vi.fn(),
  };
  plugin.default.activate(ctx as any);
  return {
    ctx,
    fetchMock,
    credentialsGet,
    handler: (name: string) => {
      const h = caps.get(name);
      if (!h) throw new Error(`missing capability ${name}`);
      return h;
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── 1. Manifest ──────────────────────────────────────────────────────────────

describe('firecrawl manifest', () => {
  it('validateManifest accepts the example; id matches dir; six caps equal rate + handlers', () => {
    const json = JSON.parse(readFileSync(join(pluginDir, 'plugin.json.example'), 'utf8'));
    expect(validateManifest(json)).toEqual({
      ok: true,
      manifest: expect.objectContaining({ id: 'firecrawl' }),
    });
    expect(json.id).toBe('firecrawl');
    expect(json.capabilities).toHaveLength(6);
    const rates = json.capabilities.map((c: any) => c.rateLimitPerMin);
    expect(new Set(rates)).toEqual(new Set([20]));
    const { ctx } = fakeCtx({ key: KEY });
    const names = (ctx.capability as any).mock.calls.map((c: any[]) => c[0]).sort();
    expect(names).toEqual([
      'web.crawl',
      'web.crawl.status',
      'web.extract',
      'web.map',
      'web.scrape',
      'web.search',
    ]);
  });
});

// ─── 2. Validation (no fetch, no key read) ────────────────────────────────────

describe('firecrawl validation', () => {
  it('rejects unknown field webhook on scrape', () => {
    expect(() => plugin.validateScrape({ url: 'https://example.com', webhook: 'https://x' })).toThrow(
      expect.objectContaining({ code: 'bad_input', message: expect.stringContaining('webhook') }),
    );
  });

  it('rejects non-object input', () => {
    for (const bad of [null, undefined, [], 'x', 1]) {
      expect(() => plugin.validateScrape(bad)).toThrow(
        expect.objectContaining({ code: 'bad_input', message: 'input must be a JSON object' }),
      );
    }
  });

  it('rejects non-http URLs and URLs with embedded credentials', () => {
    expect(() => plugin.validateScrape({ url: 'ftp://example.com' })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateScrape({ url: 'https://user:pass@example.com/' })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
  });

  it('rejects waitFor above half of timeoutMs', () => {
    expect(() =>
      plugin.validateScrape({ url: 'https://example.com', waitFor: 20000, timeoutMs: 30000 }),
    ).toThrow(expect.objectContaining({ code: 'bad_input', message: expect.stringContaining('waitFor') }));
  });

  it('rejects bad UUID for crawlId / extractId', () => {
    expect(() => plugin.validateCrawlStatus({ crawlId: 'not-a-uuid' })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateExtract({ extractId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
  });

  it('rejects bad types and ranges', () => {
    expect(() => plugin.validateScrape({ url: 'https://example.com', timeoutMs: 500 })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateScrape({ url: 'https://example.com', timeoutMs: 30.5 })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateSearch({ query: 'a', limit: 0 })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateCrawl({ url: 'https://example.com', limit: 1001 })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateMap({ url: 'https://example.com', sitemapOnly: true, ignoreSitemap: true })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateSearch({ query: 'a', onlyMainContent: true })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() => plugin.validateExtract({ urls: ['https://example.com'] })).toThrow(
      expect.objectContaining({ code: 'bad_input' }),
    );
    expect(() =>
      plugin.validateExtract({ extractId: EXTRACT_ID, prompt: 'x' }),
    ).toThrow(expect.objectContaining({ code: 'bad_input' }));
  });

  it('allows trailing /* glob on extract URLs', () => {
    const v = plugin.validateExtract({
      urls: ['https://example.com/docs/*'],
      prompt: 'summarise',
    });
    expect(v.urls[0]).toBe('https://example.com/docs/*');
  });

  it.each([
    ['web.scrape', { url: 'https://example.com', webhook: 'x' }],
    ['web.scrape', { url: 'https://example.com', waitFor: 20000, timeoutMs: 30000 }],
    ['web.search', { query: 'q', headers: {} }],
    ['web.crawl', { url: 'https://user:pass@example.com' }],
    ['web.crawl.status', { crawlId: '../../evil' }],
    ['web.map', { url: 'ftp://example.com' }],
    ['web.extract', { urls: ['https://example.com'] }],
    ['web.extract', { extractId: 'nope' }],
  ])('%s handler rejects %j before reading the key or fetching', async (cap, input) => {
    const { fetchMock, credentialsGet, handler } = fakeCtx({ key: KEY });
    await expect(handler(cap)(input)).rejects.toMatchObject({ code: 'bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(credentialsGet).not.toHaveBeenCalled();
  });
});

// ─── 3. Missing key ───────────────────────────────────────────────────────────

describe('firecrawl missing key', () => {
  it('valid input with missing key -> credential_missing; no fetch', async () => {
    const { fetchMock, handler } = fakeCtx({ key: undefined });
    await expect(handler('web.scrape')({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'credential_missing',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const empty = fakeCtx({ key: '' });
    await expect(empty.handler('web.scrape')({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'credential_missing',
    });
    expect(empty.fetchMock).not.toHaveBeenCalled();
  });
});

// ─── 4. Request shapes ────────────────────────────────────────────────────────

describe('firecrawl request shapes', () => {
  it.each([
    ['web.scrape', { url: 'https://example.com' }, 'POST', '/scrape'],
    ['web.search', { query: 'q' }, 'POST', '/search'],
    ['web.crawl', { url: 'https://example.com' }, 'POST', '/crawl'],
    ['web.crawl.status', { crawlId: CRAWL_ID }, 'GET', `/crawl/${CRAWL_ID}?skip=0&limit=10`],
    ['web.map', { url: 'https://example.com' }, 'POST', '/map'],
    ['web.extract', { urls: ['https://example.com'], prompt: 'p' }, 'POST', '/extract'],
    ['web.extract', { extractId: EXTRACT_ID }, 'GET', `/extract/${EXTRACT_ID}`],
  ])('%s %j -> %s %s with Bearer', async (cap, input, method, path) => {
    vi.useFakeTimers();
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({ success: true, id: EXTRACT_ID, status: 'completed', data: [], links: [] }),
    });
    const p = handler(cap)(input);
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`https://api.firecrawl.dev/v1${path}`);
    expect(init.method).toBe(method);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    if (method === 'GET') {
      expect(init.body).toBeUndefined();
      expect(init.headers).not.toHaveProperty('Content-Type');
    } else {
      expect(init.headers['Content-Type']).toBe('application/json');
    }
  });

  it('maxChars is plugin-only and never sent upstream', async () => {
    const scrape = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, data: { markdown: 'x' } }),
    });
    await scrape.handler('web.scrape')({ url: 'https://example.com', maxChars: 1000 });
    expect(JSON.parse((scrape.fetchMock.mock.calls[0] as any)[1].body)).not.toHaveProperty('maxChars');

    const search = fakeCtx({ key: KEY, fetchImpl: async () => jsonRes({ success: true, data: [] }) });
    await search.handler('web.search')({ query: 'q', formats: ['markdown'], maxChars: 1000 });
    const body = JSON.parse((search.fetchMock.mock.calls[0] as any)[1].body);
    expect(body).not.toHaveProperty('maxChars');
    expect(body.scrapeOptions).toEqual({ formats: ['markdown'] });
  });

  it('web.search without formats sends no scrapeOptions', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, data: [] }),
    });
    await handler('web.search')({ query: 'q' });
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({
      query: 'q',
      limit: 5,
      timeout: 60000,
    });
  });

  it('web.scrape: method, path, Bearer, exact body with defaults', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          success: true,
          data: { markdown: '# Hi', metadata: { sourceURL: 'https://example.com', title: 'T' } },
        }),
    });
    await handler('web.scrape')({ url: 'https://example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.firecrawl.dev/v1/scrape');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://example.com',
      formats: ['markdown'],
      timeout: 30000,
    });
  });

  it('web.search: limit default 5; formats become scrapeOptions', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, data: [] }),
    });
    await handler('web.search')({ query: 'hello', formats: ['markdown'] });
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body)).toEqual({
      query: 'hello',
      limit: 5,
      timeout: 60000,
      scrapeOptions: { formats: ['markdown'] },
    });
  });

  it('web.crawl: limit defaults to 100; formats always sent', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, id: CRAWL_ID }),
    });
    const out = await handler('web.crawl')({ url: 'https://example.com/docs' });
    expect(out).toEqual({
      crawlId: CRAWL_ID,
      url: 'https://example.com/docs',
      limit: 100,
      status: 'scraping',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.firecrawl.dev/v1/crawl');
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://example.com/docs',
      limit: 100,
      scrapeOptions: { formats: ['markdown'] },
    });
  });

  it('web.map: limit and timeout always sent', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, links: ['https://example.com/a'] }),
    });
    await handler('web.map')({ url: 'https://example.com', search: 'pricing' });
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://example.com',
      limit: 1000,
      timeout: 60000,
      search: 'pricing',
    });
  });

  it('web.extract start: POST body built field-by-field', async () => {
    vi.useFakeTimers();
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async (url: string) => {
        if (String(url).endsWith('/extract') && !String(url).includes(EXTRACT_ID)) {
          return jsonRes({ success: true, id: EXTRACT_ID });
        }
        return jsonRes({ success: true, status: 'completed', data: { ok: true } });
      },
    });
    const p = handler('web.extract')({
      urls: ['https://example.com/pricing'],
      prompt: 'List plans',
      schema: { type: 'object' },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await p;
    expect(out.status).toBe('completed');
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body)).toEqual({
      urls: ['https://example.com/pricing'],
      prompt: 'List plans',
      schema: { type: 'object' },
    });
  });
});

// ─── 5. Error mapping ─────────────────────────────────────────────────────────

describe('firecrawl error mapping', () => {
  async function scrapeWithStatus(
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ) {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes(body, status, headers),
    });
    return handler('web.scrape')({ url: 'https://example.com' }).catch((e) => e);
  }

  it('400/422 -> bad_input with safeMessage; details appended', async () => {
    const err = await scrapeWithStatus(400, {
      success: false,
      error: 'bad',
      details: [{ path: ['url'], message: 'required' }],
    });
    expect(err.code).toBe('bad_input');
    expect(err.message).toContain('firecrawl:');
    expect(err.message).toContain('bad');
    expect(err.message).toContain('url: required');
  });

  it('401 -> credential_missing; upstream text dropped', async () => {
    const err = await scrapeWithStatus(401, { error: 'Unauthorized secret stuff' });
    expect(err.code).toBe('credential_missing');
    expect(err.message).toBe(
      'Firecrawl rejected FIRECRAWL_API_KEY — ask the operator to check it in Settings → Plugins',
    );
    expect(err.message).not.toContain('Unauthorized');
  });

  it('402 -> upstream_error out of credits; do not retry', async () => {
    const err = await scrapeWithStatus(402, { error: 'Payment required' });
    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe(
      'firecrawl: out of credits or payment required — tell the operator; do not retry',
    );
  });

  it('403 -> upstream_error refused', async () => {
    const err = await scrapeWithStatus(403, { error: 'forbidden' });
    expect(err.code).toBe('upstream_error');
    expect(err.message).toContain('request refused');
  });

  it('404 on crawl status -> bad_input unknown crawl id', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ error: 'Job not found' }, 404),
    });
    await expect(handler('web.crawl.status')({ crawlId: CRAWL_ID })).rejects.toMatchObject({
      code: 'bad_input',
      message: 'unknown or expired crawl id',
    });
  });

  it('404 on extract resume -> bad_input unknown extract id', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ error: 'Job not found' }, 404),
    });
    await expect(handler('web.extract')({ extractId: EXTRACT_ID })).rejects.toMatchObject({
      code: 'bad_input',
      message: 'unknown or expired extract id',
    });
  });

  it('404 on a POST is not a job-id error', async () => {
    const err = await scrapeWithStatus(404, { error: 'no route' });
    expect(err.code).toBe('upstream_error');
    expect(err.message).toContain('HTTP 404');
  });

  it('422 -> bad_input', async () => {
    const err = await scrapeWithStatus(422, { error: 'invalid' });
    expect(err.code).toBe('bad_input');
    expect(err.message).toBe('firecrawl: invalid');
  });

  it('2xx HTML body -> fixed invalid-JSON message, never echoed', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => new Response('<html>leaked-upstream-secret</html>', { status: 200 }),
    });
    await expect(handler('web.scrape')({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'firecrawl: invalid JSON response',
    });
  });

  it('non-numeric Retry-After falls back to 60', async () => {
    const err = await scrapeWithStatus(429, {}, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(err.retryAfter).toBe(60);
  });

  it('408 -> timeout', async () => {
    const err = await scrapeWithStatus(408, { error: 'timed out' });
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('firecrawl: upstream timed out');
  });

  it('429 honours Retry-After and falls back to 60', async () => {
    const withHdr = await scrapeWithStatus(429, { error: 'slow down' }, { 'Retry-After': '42' });
    expect(withHdr.code).toBe('rate_limited');
    expect(withHdr.retryAfter).toBe(42);

    const noHdr = await scrapeWithStatus(429, { error: 'slow down' });
    expect(noHdr.code).toBe('rate_limited');
    expect(noHdr.retryAfter).toBe(60);
  });

  it('other non-2xx -> upstream_error with status', async () => {
    const err = await scrapeWithStatus(500, { error: 'boom' });
    expect(err.code).toBe('upstream_error');
    expect(err.message).toContain('HTTP 500');
  });

  it('HTML error bodies are never echoed', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        new Response('<html>leaked-upstream-secret</html>', { status: 502 }),
    });
    const err: any = await handler('web.scrape')({ url: 'https://example.com' }).catch((e) => e);
    expect(err.code).toBe('upstream_error');
    expect(err.message).not.toContain('leaked-upstream-secret');
    expect(err.message).not.toContain('<html>');
  });

  it('body containing the key is scrubbed', async () => {
    const err = await scrapeWithStatus(400, { error: `bad key ${KEY} used` });
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[REDACTED]');
  });
});

// ─── 6. TimeoutError ──────────────────────────────────────────────────────────

describe('firecrawl TimeoutError', () => {
  it('maps TimeoutError to timeout', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    await expect(handler('web.scrape')({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('timed out'),
    });
  });

  it('crawl start timeout uses do-not-blindly-retry message', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    await expect(handler('web.crawl')({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'timeout',
      message:
        'firecrawl: timed out starting the crawl; it may still be running — do not blindly retry',
    });
  });
});

// ─── 7. Output allow-list + key never leaked ──────────────────────────────────

describe('firecrawl output allow-list', () => {
  it('drops extra upstream metadata fields; truncation sets truncated', async () => {
    const long = 'x'.repeat(1500);
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          success: true,
          data: {
            markdown: long,
            metadata: {
              title: 'T',
              sourceURL: 'https://example.com',
              foo: 'secret-extra',
              statusCode: 200,
            },
            internalStuff: true,
          },
        }),
    });
    const out = await handler('web.scrape')({ url: 'https://example.com', maxChars: 1000 });
    expect(out.truncated).toBe(true);
    expect(out.markdown).toHaveLength(1000);
    expect(out.metadata).toEqual({ title: 'T', sourceURL: 'https://example.com', statusCode: 200 });
    expect(out.metadata).not.toHaveProperty('foo');
    expect(out).not.toHaveProperty('internalStuff');
  });

  it('key appears nowhere in JSON.stringify(result) across happy paths', async () => {
    const scrape = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          success: true,
          data: { markdown: 'hi', metadata: { sourceURL: 'https://example.com' } },
        }),
    });
    const scrapeOut = await scrape.handler('web.scrape')({ url: 'https://example.com' });
    expect(JSON.stringify(scrapeOut)).not.toContain(KEY);

    const search = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          success: true,
          data: [{ url: 'https://a.com', title: 'A', description: 'd' }],
        }),
    });
    expect(JSON.stringify(await search.handler('web.search')({ query: 'q' }))).not.toContain(KEY);

    const crawl = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, id: CRAWL_ID }),
    });
    expect(JSON.stringify(await crawl.handler('web.crawl')({ url: 'https://example.com' }))).not.toContain(
      KEY,
    );

    const status = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          status: 'completed',
          total: 1,
          completed: 1,
          creditsUsed: 1,
          expiresAt: '2026-01-01',
          data: [{ markdown: 'p', metadata: { sourceURL: 'https://example.com/1' } }],
        }),
    });
    expect(
      JSON.stringify(await status.handler('web.crawl.status')({ crawlId: CRAWL_ID })),
    ).not.toContain(KEY);

    const map = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ success: true, links: ['https://example.com'] }),
    });
    expect(JSON.stringify(await map.handler('web.map')({ url: 'https://example.com' }))).not.toContain(
      KEY,
    );

    vi.useFakeTimers();
    const extract = fakeCtx({
      key: KEY,
      fetchImpl: async (_url: string, init?: any) =>
        init?.method === 'POST'
          ? jsonRes({ success: true, id: EXTRACT_ID })
          : jsonRes({ status: 'completed', data: { a: 1 } }),
    });
    const p = extract.handler('web.extract')({ urls: ['https://example.com'], prompt: 'p' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.stringify(await p)).not.toContain(KEY);
  });
});

// ─── 8. Crawl status ──────────────────────────────────────────────────────────

describe('firecrawl crawl status', () => {
  it('puts skip and limit in the query; never fetches next', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          status: 'scraping',
          total: 10,
          completed: 2,
          creditsUsed: 2,
          next: 'https://evil.example/v1/crawl/x?skip=10',
          data: [
            { markdown: 'a', metadata: { sourceURL: 'https://example.com/a' } },
            { markdown: 'b', metadata: { sourceURL: 'https://example.com/b' } },
          ],
        }),
    });
    const out = await handler('web.crawl.status')({ crawlId: CRAWL_ID, skip: 0, limit: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`https://api.firecrawl.dev/v1/crawl/${CRAWL_ID}?skip=0&limit=10`);
    expect(url).not.toContain('evil');
    expect(JSON.stringify(out)).not.toContain('evil');
    expect(out.nextSkip).toBe(2); // upstream next truthy → skip + pagesIncluded
    expect(out.done).toBe(false);
  });

  it('nextSkip null at end; budget cuts pages; includeData:false', async () => {
    const end = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          status: 'completed',
          total: 2,
          completed: 2,
          creditsUsed: 2,
          data: [
            { markdown: 'a', metadata: { sourceURL: 'https://example.com/a' } },
            { markdown: 'b', metadata: { sourceURL: 'https://example.com/b' } },
          ],
        }),
    });
    const endOut = await end.handler('web.crawl.status')({ crawlId: CRAWL_ID, skip: 0, limit: 10 });
    expect(endOut.nextSkip).toBeNull();
    expect(endOut.done).toBe(true);
    expect(endOut.pages).toHaveLength(2);

    // Budget: CRAWL_RESPONSE_CHARS is 1_000_000; crawl maxChars caps at 200000,
    // so six full-size pages exceed the response budget (5 × 200k = 1M).
    const big = 'y'.repeat(200_000);
    const budget = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          status: 'completed',
          total: 6,
          completed: 6,
          creditsUsed: 6,
          data: Array.from({ length: 6 }, (_, i) => ({
            markdown: big,
            metadata: { sourceURL: `https://example.com/${i + 1}` },
          })),
        }),
    });
    const budgetOut = await budget.handler('web.crawl.status')({
      crawlId: CRAWL_ID,
      skip: 5,
      limit: 10,
      maxChars: 200000,
    });
    expect(budgetOut.pages).toHaveLength(5); // 6th left out by budget
    expect(budgetOut.nextSkip).toBe(10); // skip + pagesIncluded
    expect(budgetOut.truncated).toBe(true);

    const progress = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          status: 'scraping',
          total: 10,
          completed: 3,
          creditsUsed: 3,
          data: [{ markdown: 'x', metadata: { sourceURL: 'https://example.com/x' } }],
        }),
    });
    const progOut = await progress.handler('web.crawl.status')({
      crawlId: CRAWL_ID,
      skip: 7,
      includeData: false,
    });
    expect(progOut.pages).toEqual([]);
    expect(progOut.nextSkip).toBe(7);
    const [progUrl] = progress.fetchMock.mock.calls[0] as [string, any];
    expect(progUrl).toContain('limit=1');
  });

  it('failed job with success:false returns as data', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () =>
        jsonRes({
          success: false,
          status: 'failed',
          total: 0,
          completed: 0,
          creditsUsed: 1,
          data: [],
          error: 'upstream failed',
        }),
    });
    const out = await handler('web.crawl.status')({ crawlId: CRAWL_ID });
    expect(out.status).toBe('failed');
    expect(out.done).toBe(true);
  });
});

// ─── 9. Extract ───────────────────────────────────────────────────────────────

describe('firecrawl extract', () => {
  it('completes on a later poll', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async (url: string, init?: any) => {
        if (init?.method === 'POST') return jsonRes({ success: true, id: EXTRACT_ID });
        polls += 1;
        if (polls < 2) return jsonRes({ status: 'processing' });
        return jsonRes({ status: 'completed', data: { plans: [] }, expiresAt: '2026-12-01' });
      },
    });
    const p = handler('web.extract')({ urls: ['https://example.com'], prompt: 'plans' });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await p;
    expect(out).toMatchObject({
      extractId: EXTRACT_ID,
      status: 'completed',
      data: { plans: [] },
      expiresAt: '2026-12-01',
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('deadline returns still-running form', async () => {
    vi.useFakeTimers();
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async (url: string, init?: any) => {
        if (init?.method === 'POST') return jsonRes({ success: true, id: EXTRACT_ID });
        return jsonRes({ status: 'processing' });
      },
    });
    const p = handler('web.extract')({ urls: ['https://example.com'], prompt: 'plans' });
    // Advance past EXTRACT_WAIT_MS (120s) in chunks so the loop can poll
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const out = await p;
    expect(out).toEqual({
      extractId: EXTRACT_ID,
      status: 'processing',
      note: `Still running. Call web.extract with {"extractId":"${EXTRACT_ID}"} after at least 15 s.`,
    });
  });

  it('poll error returns still-running form with the id', async () => {
    vi.useFakeTimers();
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async (url: string, init?: any) => {
        if (init?.method === 'POST') return jsonRes({ success: true, id: EXTRACT_ID });
        return jsonRes({ error: 'nope' }, 500);
      },
    });
    const p = handler('web.extract')({ urls: ['https://example.com'], prompt: 'plans' });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await p;
    expect(out.status).toBe('processing');
    expect(out.extractId).toBe(EXTRACT_ID);
  });

  it('resume does exactly one GET', async () => {
    const { fetchMock, handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ status: 'completed', data: { a: 1 } }),
    });
    const out = await handler('web.extract')({ extractId: EXTRACT_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`https://api.firecrawl.dev/v1/extract/${EXTRACT_ID}`);
    expect(init.method).toBe('GET');
    expect(out).toMatchObject({ extractId: EXTRACT_ID, status: 'completed', data: { a: 1 } });
  });

  it('failed returns as data', async () => {
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ status: 'failed', error: 'LLM blew up', data: null }),
    });
    const out = await handler('web.extract')({ extractId: EXTRACT_ID });
    expect(out.status).toBe('failed');
    expect(out.error).toContain('LLM blew up');
  });

  it('wait deadline counts from handler start, so a slow POST cannot outlive the host race', async () => {
    vi.useFakeTimers();
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async (_url: string, init?: any) => {
        if (init?.method === 'POST') {
          await new Promise((r) => setTimeout(r, 29_000)); // just under JOB_FETCH_MS
          return jsonRes({ success: true, id: EXTRACT_ID });
        }
        return jsonRes({ status: 'processing' });
      },
    });
    const started = Date.now();
    let elapsed = -1;
    const p = handler('web.extract')({ urls: ['https://example.com'], prompt: 'p' }).then((out) => {
      elapsed = Date.now() - started;
      return out;
    });
    await vi.advanceTimersByTimeAsync(200_000);
    expect((await p).status).toBe('processing');
    // EXTRACT_WAIT_MS + one sleep + one poll budget; §4.1 keeps this under the manifest's 150 s.
    expect(elapsed).toBeLessThanOrEqual(120_000 + 5_000 + 15_000);
  });

  it('oversized data on a start-mode poll throws, not a misleading still-running', async () => {
    vi.useFakeTimers();
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async (_url: string, init?: any) =>
        init?.method === 'POST'
          ? jsonRes({ success: true, id: EXTRACT_ID })
          : jsonRes({ status: 'completed', data: { blob: 'z'.repeat(1_000_001) } }),
    });
    const p = handler('web.extract')({ urls: ['https://example.com'], prompt: 'p' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({
      code: 'upstream_error',
      message: 'firecrawl: extract result too large; narrow the prompt or schema',
    });
  });

  it('failed job error scrubs the key before clipping', async () => {
    // Key straddles the 300-char clip: clipping first leaves a partial key the host redactor cannot match.
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ status: 'failed', error: `${'x'.repeat(290)}${KEY}`, data: null }),
    });
    const out = await handler('web.extract')({ extractId: EXTRACT_ID });
    expect(out.error).not.toContain(KEY.slice(0, 10));
    expect(out.error.length).toBeLessThanOrEqual(300);
  });

  it('oversized data throws upstream_error', async () => {
    const huge = { blob: 'z'.repeat(1_000_001) };
    const { handler } = fakeCtx({
      key: KEY,
      fetchImpl: async () => jsonRes({ status: 'completed', data: huge }),
    });
    await expect(handler('web.extract')({ extractId: EXTRACT_ID })).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'firecrawl: extract result too large; narrow the prompt or schema',
    });
  });
});
