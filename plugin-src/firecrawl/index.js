// Firecrawl — agent-callable web scrape / search / crawl / map / extract via Firecrawl v1.
// Agents never see FIRECRAWL_API_KEY; results are returned inline (no files written).

export const BASE = 'https://api.firecrawl.dev/v1';
export const CONTENT_FORMATS = new Set(['markdown', 'html', 'rawHtml', 'links']);
export const FETCH_GRACE_MS = 15_000;
export const JOB_FETCH_MS = 30_000;
export const STATUS_FETCH_MS = 60_000;
export const EXTRACT_POLL_FETCH_MS = 15_000;
export const EXTRACT_POLL_INTERVAL_MS = 5_000;
export const EXTRACT_WAIT_MS = 120_000;
export const MAX_LINKS = 1_000;
export const CRAWL_RESPONSE_CHARS = 1_000_000;
export const EXTRACT_RESPONSE_CHARS = 1_000_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TBS_RE =
  /^(qdr:[hdwmy]|cdr:1,cd_min:\d{2}\/\d{2}\/\d{4},cd_max:\d{2}\/\d{2}\/\d{4})$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const PROXY_VALUES = new Set(['basic', 'enhanced', 'auto']);
const EXTRACT_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function fail(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra ?? {}) });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collapse whitespace, redact key, clip to 300 chars. */
export function scrubSafeMessage(text, key) {
  let s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (key && s.includes(key)) s = s.split(key).join('[REDACTED]');
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

/**
 * Build safeMessage from a parsed JSON body.
 * For 400/422, append up to 5 details as "path: message".
 */
export function buildSafeMessage(body, status, key) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const parts = [];
  if (typeof body.error === 'string' && body.error) parts.push(body.error);
  if ((status === 400 || status === 422) && Array.isArray(body.details)) {
    let n = 0;
    for (const d of body.details) {
      if (n >= 5) break;
      if (!d || typeof d !== 'object') continue;
      const path = Array.isArray(d.path) ? d.path.join('.') : typeof d.path === 'string' ? d.path : '';
      const msg = typeof d.message === 'string' ? d.message : '';
      if (!path && !msg) continue;
      parts.push(path ? `${path}: ${msg}` : msg);
      n += 1;
    }
  }
  return scrubSafeMessage(parts.join('; '), key);
}

function assertObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('bad_input', 'input must be a JSON object');
  }
}

function assertAllowList(raw, allowed) {
  const keys = Object.keys(raw);
  const allowedSet = new Set(allowed);
  for (const k of keys) {
    if (!allowedSet.has(k)) {
      throw fail('bad_input', `unknown field ${k}; allowed: ${allowed.join(', ')}`);
    }
  }
}

function assertBoolean(v, name) {
  if (typeof v !== 'boolean') throw fail('bad_input', `${name} must be a boolean`);
  return v;
}

function assertInt(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw fail('bad_input', `${name} must be an integer`);
  }
  if (min !== undefined && v < min) throw fail('bad_input', `${name} must be >= ${min}`);
  if (max !== undefined && v > max) throw fail('bad_input', `${name} must be <= ${max}`);
  return v;
}

function assertStringArray(v, name, { maxItems, maxItemChars } = {}) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) {
    throw fail('bad_input', `${name} must be an array of non-empty strings`);
  }
  if (maxItems !== undefined && v.length > maxItems) {
    throw fail('bad_input', `${name} must have at most ${maxItems} items`);
  }
  if (maxItemChars !== undefined) {
    for (const s of v) {
      if (s.length > maxItemChars) {
        throw fail('bad_input', `${name} entries must be at most ${maxItemChars} chars`);
      }
    }
  }
  return v;
}

/** Validate a single URL. Trailing /* glob is allowed for extract. */
export function validateUrl(raw, { allowGlob = false } = {}) {
  if (typeof raw !== 'string') throw fail('bad_input', 'url must be a string');
  const trimmed = raw.trim();
  if (!trimmed) throw fail('bad_input', 'url is required');
  if (trimmed.length > 2048) throw fail('bad_input', 'url too long (max 2048 chars)');
  const forParse = allowGlob ? trimmed.replace(/\/\*$/, '') : trimmed;
  let parsed;
  try {
    parsed = new URL(forParse);
  } catch {
    throw fail('bad_input', 'url is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail('bad_input', 'url must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw fail('bad_input', 'url must not contain credentials');
  }
  return trimmed;
}

export function validateFormats(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw fail('bad_input', 'formats must be a non-empty array');
  }
  const seen = new Set();
  const out = [];
  for (const f of raw) {
    if (typeof f !== 'string' || !CONTENT_FORMATS.has(f)) {
      throw fail('bad_input', `formats entries must be one of: ${[...CONTENT_FORMATS].join(', ')}`);
    }
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

function validateLocation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('bad_input', 'location must be an object');
  }
  assertAllowList(raw, ['country', 'languages']);
  const out = {};
  if (raw.country !== undefined) {
    if (typeof raw.country !== 'string' || !COUNTRY_RE.test(raw.country)) {
      throw fail('bad_input', 'location.country must be a 2-letter uppercase code');
    }
    out.country = raw.country;
  }
  if (raw.languages !== undefined) {
    out.languages = assertStringArray(raw.languages, 'location.languages', { maxItems: 10 });
  }
  return out;
}

// ─── Validators ───────────────────────────────────────────────────────────────

export function validateScrape(raw) {
  assertObject(raw);
  assertAllowList(raw, [
    'url',
    'formats',
    'onlyMainContent',
    'includeTags',
    'excludeTags',
    'waitFor',
    'timeoutMs',
    'mobile',
    'maxAge',
    'proxy',
    'location',
    'maxChars',
  ]);
  const url = validateUrl(raw.url);
  const formats = raw.formats !== undefined ? validateFormats(raw.formats) : ['markdown'];
  const timeoutMs = raw.timeoutMs !== undefined ? assertInt(raw.timeoutMs, 'timeoutMs', 1000, 120000) : 30000;
  const out = { url, formats, timeoutMs };
  if (raw.onlyMainContent !== undefined) out.onlyMainContent = assertBoolean(raw.onlyMainContent, 'onlyMainContent');
  if (raw.includeTags !== undefined) {
    out.includeTags = assertStringArray(raw.includeTags, 'includeTags', { maxItems: 100, maxItemChars: 100 });
  }
  if (raw.excludeTags !== undefined) {
    out.excludeTags = assertStringArray(raw.excludeTags, 'excludeTags', { maxItems: 100, maxItemChars: 100 });
  }
  if (raw.waitFor !== undefined) {
    out.waitFor = assertInt(raw.waitFor, 'waitFor', 0, 60000);
    if (out.waitFor > timeoutMs / 2) {
      throw fail('bad_input', 'waitFor must be <= timeoutMs / 2');
    }
  }
  if (raw.mobile !== undefined) out.mobile = assertBoolean(raw.mobile, 'mobile');
  if (raw.maxAge !== undefined) out.maxAge = assertInt(raw.maxAge, 'maxAge', 0);
  if (raw.proxy !== undefined) {
    if (typeof raw.proxy !== 'string' || !PROXY_VALUES.has(raw.proxy)) {
      throw fail('bad_input', 'proxy must be basic, enhanced, or auto');
    }
    out.proxy = raw.proxy;
  }
  if (raw.location !== undefined) out.location = validateLocation(raw.location);
  out.maxChars = raw.maxChars !== undefined ? assertInt(raw.maxChars, 'maxChars', 1000, 500000) : 50000;
  return out;
}

export function validateSearch(raw) {
  assertObject(raw);
  assertAllowList(raw, [
    'query',
    'limit',
    'tbs',
    'location',
    'timeoutMs',
    'formats',
    'onlyMainContent',
    'maxChars',
  ]);
  if (typeof raw.query !== 'string') throw fail('bad_input', 'query must be a string');
  const query = raw.query.trim();
  if (!query || query.length > 2000) throw fail('bad_input', 'query must be 1..2000 chars');
  const limit = raw.limit !== undefined ? assertInt(raw.limit, 'limit', 1, 50) : 5;
  const timeoutMs = raw.timeoutMs !== undefined ? assertInt(raw.timeoutMs, 'timeoutMs', 1000, 120000) : 60000;
  const out = { query, limit, timeoutMs };
  if (raw.tbs !== undefined) {
    if (typeof raw.tbs !== 'string' || !TBS_RE.test(raw.tbs)) {
      throw fail('bad_input', 'tbs is not a valid time filter');
    }
    out.tbs = raw.tbs;
  }
  if (raw.location !== undefined) {
    if (typeof raw.location !== 'string' || !raw.location || raw.location.length > 200) {
      throw fail('bad_input', 'location must be a string of 1..200 chars');
    }
    out.location = raw.location;
  }
  if (raw.formats !== undefined) out.formats = validateFormats(raw.formats);
  if (raw.onlyMainContent !== undefined) {
    if (!out.formats) throw fail('bad_input', 'onlyMainContent requires formats');
    out.onlyMainContent = assertBoolean(raw.onlyMainContent, 'onlyMainContent');
  }
  if (raw.maxChars !== undefined) {
    if (!out.formats) throw fail('bad_input', 'maxChars requires formats');
    out.maxChars = assertInt(raw.maxChars, 'maxChars', 1000, 100000);
  } else if (out.formats) {
    out.maxChars = 10000;
  }
  return out;
}

export function validateCrawl(raw) {
  assertObject(raw);
  assertAllowList(raw, [
    'url',
    'limit',
    'maxDepth',
    'includePaths',
    'excludePaths',
    'ignoreSitemap',
    'ignoreQueryParameters',
    'crawlEntireDomain',
    'allowSubdomains',
    'formats',
    'onlyMainContent',
  ]);
  const url = validateUrl(raw.url);
  const limit = raw.limit !== undefined ? assertInt(raw.limit, 'limit', 1, 1000) : 100;
  const formats = raw.formats !== undefined ? validateFormats(raw.formats) : ['markdown'];
  const out = { url, limit, formats };
  if (raw.maxDepth !== undefined) out.maxDepth = assertInt(raw.maxDepth, 'maxDepth', 0, 100);
  if (raw.includePaths !== undefined) {
    out.includePaths = assertStringArray(raw.includePaths, 'includePaths', {
      maxItems: 100,
      maxItemChars: 500,
    });
  }
  if (raw.excludePaths !== undefined) {
    out.excludePaths = assertStringArray(raw.excludePaths, 'excludePaths', {
      maxItems: 100,
      maxItemChars: 500,
    });
  }
  if (raw.ignoreSitemap !== undefined) out.ignoreSitemap = assertBoolean(raw.ignoreSitemap, 'ignoreSitemap');
  if (raw.ignoreQueryParameters !== undefined) {
    out.ignoreQueryParameters = assertBoolean(raw.ignoreQueryParameters, 'ignoreQueryParameters');
  }
  if (raw.crawlEntireDomain !== undefined) {
    out.crawlEntireDomain = assertBoolean(raw.crawlEntireDomain, 'crawlEntireDomain');
  }
  if (raw.allowSubdomains !== undefined) {
    out.allowSubdomains = assertBoolean(raw.allowSubdomains, 'allowSubdomains');
  }
  if (raw.onlyMainContent !== undefined) {
    out.onlyMainContent = assertBoolean(raw.onlyMainContent, 'onlyMainContent');
  }
  return out;
}

export function validateCrawlStatus(raw) {
  assertObject(raw);
  assertAllowList(raw, ['crawlId', 'skip', 'limit', 'includeData', 'maxChars']);
  if (typeof raw.crawlId !== 'string' || !UUID_RE.test(raw.crawlId)) {
    throw fail('bad_input', 'crawlId must be a UUID');
  }
  const out = {
    crawlId: raw.crawlId,
    skip: raw.skip !== undefined ? assertInt(raw.skip, 'skip', 0) : 0,
    limit: raw.limit !== undefined ? assertInt(raw.limit, 'limit', 1, 100) : 10,
    includeData: raw.includeData !== undefined ? assertBoolean(raw.includeData, 'includeData') : true,
    maxChars: raw.maxChars !== undefined ? assertInt(raw.maxChars, 'maxChars', 1000, 200000) : 20000,
  };
  return out;
}

export function validateMap(raw) {
  assertObject(raw);
  assertAllowList(raw, [
    'url',
    'search',
    'limit',
    'ignoreSitemap',
    'sitemapOnly',
    'includeSubdomains',
    'timeoutMs',
  ]);
  const url = validateUrl(raw.url);
  const limit = raw.limit !== undefined ? assertInt(raw.limit, 'limit', 1, 5000) : 1000;
  const timeoutMs = raw.timeoutMs !== undefined ? assertInt(raw.timeoutMs, 'timeoutMs', 1000, 120000) : 60000;
  const out = { url, limit, timeoutMs };
  if (raw.search !== undefined) {
    if (typeof raw.search !== 'string' || !raw.search || raw.search.length > 500) {
      throw fail('bad_input', 'search must be a string of 1..500 chars');
    }
    out.search = raw.search;
  }
  if (raw.ignoreSitemap !== undefined) out.ignoreSitemap = assertBoolean(raw.ignoreSitemap, 'ignoreSitemap');
  if (raw.sitemapOnly !== undefined) out.sitemapOnly = assertBoolean(raw.sitemapOnly, 'sitemapOnly');
  if (raw.includeSubdomains !== undefined) {
    out.includeSubdomains = assertBoolean(raw.includeSubdomains, 'includeSubdomains');
  }
  if (out.sitemapOnly === true && out.ignoreSitemap === true) {
    throw fail('bad_input', 'sitemapOnly cannot be combined with ignoreSitemap: true');
  }
  return out;
}

export function validateExtract(raw) {
  assertObject(raw);
  // Resume mode: only extractId allowed
  if (raw.extractId !== undefined) {
    assertAllowList(raw, ['extractId']);
    if (typeof raw.extractId !== 'string' || !UUID_RE.test(raw.extractId)) {
      throw fail('bad_input', 'extractId must be a UUID');
    }
    return { mode: 'resume', extractId: raw.extractId };
  }
  assertAllowList(raw, [
    'urls',
    'prompt',
    'schema',
    'enableWebSearch',
    'includeSubdomains',
    'showSources',
  ]);
  if (!Array.isArray(raw.urls) || raw.urls.length < 1 || raw.urls.length > 10) {
    throw fail('bad_input', 'urls must be an array of 1..10 entries');
  }
  const urls = raw.urls.map((u) => validateUrl(u, { allowGlob: true }));
  const out = { mode: 'start', urls };
  if (raw.prompt !== undefined) {
    if (typeof raw.prompt !== 'string') throw fail('bad_input', 'prompt must be a string');
    const prompt = raw.prompt.trim();
    if (!prompt || prompt.length > 8000) throw fail('bad_input', 'prompt must be 1..8000 chars');
    out.prompt = prompt;
  }
  if (raw.schema !== undefined) {
    if (!raw.schema || typeof raw.schema !== 'object' || Array.isArray(raw.schema)) {
      throw fail('bad_input', 'schema must be a non-array object');
    }
    const serialized = JSON.stringify(raw.schema);
    if (serialized.length > 32768) throw fail('bad_input', 'schema too large (max 32768 chars serialised)');
    out.schema = raw.schema;
  }
  if (!out.prompt && !out.schema) {
    throw fail('bad_input', 'at least one of prompt or schema is required');
  }
  if (raw.enableWebSearch !== undefined) {
    out.enableWebSearch = assertBoolean(raw.enableWebSearch, 'enableWebSearch');
  }
  if (raw.includeSubdomains !== undefined) {
    out.includeSubdomains = assertBoolean(raw.includeSubdomains, 'includeSubdomains');
  }
  if (raw.showSources !== undefined) out.showSources = assertBoolean(raw.showSources, 'showSources');
  return out;
}

// ─── Output shaping ───────────────────────────────────────────────────────────

const META_KEYS = ['title', 'description', 'language', 'sourceURL', 'statusCode', 'error'];

/**
 * Shape a page/data object. Returns only keys that exist.
 * Sets truncated:true on the returned object when anything was cut (caller may also OR at response level).
 */
export function shapePage(raw, maxChars) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { truncated: false };
  const out = {};
  let truncated = false;
  for (const key of ['markdown', 'html', 'rawHtml']) {
    if (typeof raw[key] === 'string') {
      if (raw[key].length > maxChars) {
        out[key] = raw[key].slice(0, maxChars);
        truncated = true;
      } else {
        out[key] = raw[key];
      }
    }
  }
  if (Array.isArray(raw.links)) {
    const links = raw.links.filter((x) => typeof x === 'string');
    if (links.length > MAX_LINKS) {
      out.links = links.slice(0, MAX_LINKS);
      truncated = true;
    } else {
      out.links = links;
    }
  }
  if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    const meta = {};
    for (const k of META_KEYS) {
      if (raw.metadata[k] !== undefined) meta[k] = raw.metadata[k];
    }
    if (Object.keys(meta).length) out.metadata = meta;
  }
  out.truncated = truncated;
  return out;
}

function pageTextLength(page) {
  let n = 0;
  for (const k of ['markdown', 'html', 'rawHtml']) {
    if (typeof page[k] === 'string') n += page[k].length;
  }
  return n;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * Single outbound HTTP helper. Reads the key only here.
 * @param {object} ctx
 * @param {string} method
 * @param {string} path - begins with / (appended to BASE)
 * @param {object|undefined} body
 * @param {number} fetchMs
 * @param {{ kind?: 'oneshot'|'job'|'status', timeoutMessage?: string }} opts
 */
export async function callFirecrawl(ctx, method, path, body, fetchMs, opts = {}) {
  const key = ctx.credentials.get('FIRECRAWL_API_KEY');
  if (!key) {
    throw fail(
      'credential_missing',
      'Firecrawl key not configured — set FIRECRAWL_API_KEY in Settings → Plugins',
    );
  }
  const kind = opts.kind ?? 'oneshot';
  const headers = { Authorization: `Bearer ${key}` };
  const init = { method, headers, signal: AbortSignal.timeout(fetchMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  let text;
  try {
    res = await ctx.http.fetch(BASE + path, init);
    text = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      if (opts.timeoutMessage) throw fail('timeout', opts.timeoutMessage);
      throw fail('timeout', `firecrawl: request timed out after ${Math.round(fetchMs / 1000)}s`);
    }
    if (typeof err?.code === 'string') throw err;
    throw fail('upstream_error', 'firecrawl: network error');
  }

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    throw mapHttpError(res, parsed, key, kind, path);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('upstream_error', 'firecrawl: invalid JSON response');
  }

  if (kind === 'status') {
    if (typeof parsed.status !== 'string') {
      throw fail('upstream_error', 'firecrawl: unexpected response');
    }
    // A failed job's error reaches the output, and the key is only in scope here.
    parsed.error = buildSafeMessage(parsed, res.status, key);
    return parsed;
  }

  // oneshot / job
  if (parsed.success !== true) {
    const safe = buildSafeMessage(parsed, res.status, key);
    throw fail('upstream_error', safe ? `firecrawl: ${safe}` : 'firecrawl: unexpected response');
  }
  return parsed;
}

function mapHttpError(res, body, key, kind, path) {
  const status = res.status;
  const safe = buildSafeMessage(body, status, key);
  const safeSuffix = safe ? `: ${safe}` : '';

  if (status === 400 || status === 422) {
    return fail('bad_input', `firecrawl${safeSuffix || ': bad request'}`);
  }
  if (status === 401) {
    return fail(
      'credential_missing',
      'Firecrawl rejected FIRECRAWL_API_KEY — ask the operator to check it in Settings → Plugins',
    );
  }
  if (status === 402) {
    return fail(
      'upstream_error',
      'firecrawl: out of credits or payment required — tell the operator; do not retry',
    );
  }
  if (status === 403) {
    return fail('upstream_error', `firecrawl: request refused${safeSuffix}`);
  }
  if (status === 404 && (kind === 'status' || path.includes('/crawl/') || path.includes('/extract/'))) {
    const isExtract = path.includes('/extract/');
    return fail('bad_input', isExtract ? 'unknown or expired extract id' : 'unknown or expired crawl id');
  }
  if (status === 408) {
    return fail('timeout', 'firecrawl: upstream timed out');
  }
  if (status === 429) {
    let retryAfter = 60;
    const hdr = res.headers?.get?.('Retry-After') ?? res.headers?.get?.('retry-after');
    if (hdr != null) {
      const n = parseInt(String(hdr), 10);
      if (Number.isInteger(n) && n > 0) retryAfter = n;
    }
    return fail('rate_limited', 'firecrawl: rate limited', { retryAfter });
  }
  return fail('upstream_error', `firecrawl: HTTP ${status}${safeSuffix}`);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleScrape(ctx, input) {
  const v = validateScrape(input);
  const body = {
    url: v.url,
    formats: v.formats,
    timeout: v.timeoutMs,
  };
  if (v.onlyMainContent !== undefined) body.onlyMainContent = v.onlyMainContent;
  if (v.includeTags !== undefined) body.includeTags = v.includeTags;
  if (v.excludeTags !== undefined) body.excludeTags = v.excludeTags;
  if (v.waitFor !== undefined) body.waitFor = v.waitFor;
  if (v.mobile !== undefined) body.mobile = v.mobile;
  if (v.maxAge !== undefined) body.maxAge = v.maxAge;
  if (v.proxy !== undefined) body.proxy = v.proxy;
  if (v.location !== undefined) body.location = v.location;

  const resp = await callFirecrawl(ctx, 'POST', '/scrape', body, v.timeoutMs + FETCH_GRACE_MS);
  const data = resp.data;
  if (!data || typeof data !== 'object') {
    throw fail('upstream_error', 'firecrawl: unexpected response');
  }
  const shaped = shapePage(data, v.maxChars);
  const url =
    shaped.metadata && typeof shaped.metadata.sourceURL === 'string'
      ? shaped.metadata.sourceURL
      : v.url;
  const out = { url, truncated: shaped.truncated };
  for (const k of ['markdown', 'html', 'rawHtml', 'links', 'metadata']) {
    if (shaped[k] !== undefined) out[k] = shaped[k];
  }
  if (typeof resp.warning === 'string') out.warning = resp.warning;
  return out;
}

async function handleSearch(ctx, input) {
  const v = validateSearch(input);
  const body = { query: v.query, limit: v.limit, timeout: v.timeoutMs };
  if (v.tbs !== undefined) body.tbs = v.tbs;
  if (v.location !== undefined) body.location = v.location;
  if (v.formats) {
    body.scrapeOptions = { formats: v.formats };
    if (v.onlyMainContent !== undefined) body.scrapeOptions.onlyMainContent = v.onlyMainContent;
  }

  const resp = await callFirecrawl(ctx, 'POST', '/search', body, v.timeoutMs + FETCH_GRACE_MS);
  if (!Array.isArray(resp.data)) {
    throw fail('upstream_error', 'firecrawl: unexpected response');
  }
  const maxChars = v.maxChars ?? 10000;
  let truncated = false;
  const results = resp.data.map((item) => {
    const shaped = shapePage(item, maxChars);
    if (shaped.truncated) truncated = true;
    const row = {
      url: typeof item?.url === 'string' ? item.url : shaped.metadata?.sourceURL ?? '',
      title: typeof item?.title === 'string' ? item.title : '',
      description: typeof item?.description === 'string' ? item.description : '',
    };
    for (const k of ['markdown', 'html', 'rawHtml', 'links', 'metadata', 'truncated']) {
      if (shaped[k] !== undefined) row[k] = shaped[k];
    }
    return row;
  });
  const out = { results, truncated };
  if (typeof resp.warning === 'string') out.warning = resp.warning;
  return out;
}

async function handleCrawl(ctx, input) {
  const v = validateCrawl(input);
  const body = {
    url: v.url,
    limit: v.limit,
    scrapeOptions: { formats: v.formats },
  };
  if (v.maxDepth !== undefined) body.maxDepth = v.maxDepth;
  if (v.includePaths !== undefined) body.includePaths = v.includePaths;
  if (v.excludePaths !== undefined) body.excludePaths = v.excludePaths;
  if (v.ignoreSitemap !== undefined) body.ignoreSitemap = v.ignoreSitemap;
  if (v.ignoreQueryParameters !== undefined) body.ignoreQueryParameters = v.ignoreQueryParameters;
  if (v.crawlEntireDomain !== undefined) body.crawlEntireDomain = v.crawlEntireDomain;
  if (v.allowSubdomains !== undefined) body.allowSubdomains = v.allowSubdomains;
  if (v.onlyMainContent !== undefined) body.scrapeOptions.onlyMainContent = v.onlyMainContent;

  const resp = await callFirecrawl(ctx, 'POST', '/crawl', body, JOB_FETCH_MS, {
    kind: 'job',
    timeoutMessage:
      'firecrawl: timed out starting the crawl; it may still be running — do not blindly retry',
  });
  if (typeof resp.id !== 'string' || !resp.id) {
    throw fail('upstream_error', 'firecrawl: unexpected response');
  }
  return { crawlId: resp.id, url: v.url, limit: v.limit, status: 'scraping' };
}

async function handleCrawlStatus(ctx, input) {
  const v = validateCrawlStatus(input);
  const fetchLimit = v.includeData ? v.limit : 1;
  const path = `/crawl/${v.crawlId}?skip=${v.skip}&limit=${fetchLimit}`;
  const resp = await callFirecrawl(ctx, 'GET', path, undefined, STATUS_FETCH_MS, { kind: 'status' });

  const status = resp.status;
  const done = status !== 'scraping';
  const out = {
    crawlId: v.crawlId,
    status,
    done,
    total: typeof resp.total === 'number' ? resp.total : 0,
    completed: typeof resp.completed === 'number' ? resp.completed : 0,
    creditsUsed: typeof resp.creditsUsed === 'number' ? resp.creditsUsed : 0,
    expiresAt: typeof resp.expiresAt === 'string' ? resp.expiresAt : null,
    pages: [],
    nextSkip: null,
    truncated: false,
  };

  if (!v.includeData) {
    out.nextSkip = v.skip;
    return out;
  }

  const data = Array.isArray(resp.data) ? resp.data : [];
  let chars = 0;
  let truncated = false;
  const pages = [];
  for (const item of data) {
    const shaped = shapePage(item, v.maxChars);
    if (shaped.truncated) truncated = true;
    const page = { truncated: shaped.truncated };
    for (const k of ['markdown', 'html', 'rawHtml', 'links', 'metadata']) {
      if (shaped[k] !== undefined) page[k] = shaped[k];
    }
    page.url =
      shaped.metadata && typeof shaped.metadata.sourceURL === 'string'
        ? shaped.metadata.sourceURL
        : typeof item?.url === 'string'
          ? item.url
          : '';
    const len = pageTextLength(page);
    if (pages.length > 0 && chars + len > CRAWL_RESPONSE_CHARS) {
      truncated = true;
      break;
    }
    pages.push(page);
    chars += len;
  }
  out.pages = pages;
  out.truncated = truncated;

  const leftOutByBudget = pages.length < data.length;
  const upstreamNext = Boolean(resp.next);
  if (leftOutByBudget || upstreamNext) {
    out.nextSkip = v.skip + pages.length;
  } else {
    out.nextSkip = null;
  }
  return out;
}

async function handleMap(ctx, input) {
  const v = validateMap(input);
  const body = { url: v.url, limit: v.limit, timeout: v.timeoutMs };
  if (v.search !== undefined) body.search = v.search;
  if (v.ignoreSitemap !== undefined) body.ignoreSitemap = v.ignoreSitemap;
  if (v.sitemapOnly !== undefined) body.sitemapOnly = v.sitemapOnly;
  if (v.includeSubdomains !== undefined) body.includeSubdomains = v.includeSubdomains;

  const resp = await callFirecrawl(ctx, 'POST', '/map', body, v.timeoutMs + FETCH_GRACE_MS);
  if (!Array.isArray(resp.links)) {
    throw fail('upstream_error', 'firecrawl: unexpected response');
  }
  const links = resp.links.filter((x) => typeof x === 'string');
  return { url: v.url, links, count: links.length };
}

function extractStillRunning(extractId) {
  return {
    extractId,
    status: 'processing',
    note: `Still running. Call web.extract with {"extractId":"${extractId}"} after at least 15 s.`,
  };
}

function shapeExtractResult(resp, extractId) {
  const status = typeof resp.status === 'string' ? resp.status : 'processing';
  if (!EXTRACT_TERMINAL.has(status) && status !== 'processing' && status !== 'scraping') {
    // treat unknown non-terminal as still running shape caller decides
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    if (resp.data !== undefined) {
      const serialized = JSON.stringify(resp.data);
      if (serialized.length > EXTRACT_RESPONSE_CHARS) {
        throw fail(
          'upstream_error',
          'firecrawl: extract result too large; narrow the prompt or schema',
        );
      }
    }
    const out = {
      extractId,
      status,
      data: resp.data ?? null,
    };
    if (resp.sources !== undefined) out.sources = resp.sources;
    if (typeof resp.expiresAt === 'string') out.expiresAt = resp.expiresAt;
    if ((status === 'failed' || status === 'cancelled') && resp.error) out.error = resp.error;
    return out;
  }
  return extractStillRunning(extractId);
}

async function handleExtract(ctx, input) {
  const v = validateExtract(input);

  if (v.mode === 'resume') {
    const resp = await callFirecrawl(
      ctx,
      'GET',
      `/extract/${v.extractId}`,
      undefined,
      EXTRACT_POLL_FETCH_MS,
      { kind: 'status' },
    );
    return shapeExtractResult(resp, v.extractId);
  }

  // Start mode
  const body = { urls: v.urls };
  if (v.prompt !== undefined) body.prompt = v.prompt;
  if (v.schema !== undefined) body.schema = v.schema;
  if (v.enableWebSearch !== undefined) body.enableWebSearch = v.enableWebSearch;
  if (v.includeSubdomains !== undefined) body.includeSubdomains = v.includeSubdomains;
  if (v.showSources !== undefined) body.showSources = v.showSources;

  // From handler start, not after the POST: a slow POST must not push past the manifest timeoutMs.
  const deadline = Date.now() + EXTRACT_WAIT_MS;
  const created = await callFirecrawl(ctx, 'POST', '/extract', body, JOB_FETCH_MS, {
    kind: 'job',
    timeoutMessage:
      'firecrawl: timed out starting the extract; it may still be running — do not blindly retry',
  });

  if (typeof created.id !== 'string' || !created.id) {
    throw fail('upstream_error', 'firecrawl: unexpected response');
  }
  const extractId = created.id;

  while (Date.now() < deadline) {
    await sleep(EXTRACT_POLL_INTERVAL_MS);
    let resp;
    try {
      resp = await callFirecrawl(
        ctx,
        'GET',
        `/extract/${extractId}`,
        undefined,
        EXTRACT_POLL_FETCH_MS,
        { kind: 'status' },
      );
    } catch {
      // Any poll error → still-running form (job is paid; keep the id)
      return extractStillRunning(extractId);
    }
    // Outside the try: an oversized result must throw, not read as still running.
    if (EXTRACT_TERMINAL.has(resp.status)) return shapeExtractResult(resp, extractId);
  }
  return extractStillRunning(extractId);
}

// Fix: pass correct timeout message for extract start — rewrite handleExtract start call cleanly
// Actually looking at the code again, the replace produces a good message. But let me fix the POST call
// to use an explicit message. I'll do a search_replace after.

export default {
  activate(ctx) {
    ctx.capability('web.scrape', (input) => handleScrape(ctx, input));
    ctx.capability('web.search', (input) => handleSearch(ctx, input));
    ctx.capability('web.crawl', (input) => handleCrawl(ctx, input));
    ctx.capability('web.crawl.status', (input) => handleCrawlStatus(ctx, input));
    ctx.capability('web.map', (input) => handleMap(ctx, input));
    ctx.capability('web.extract', (input) => handleExtract(ctx, input));
  },
};
