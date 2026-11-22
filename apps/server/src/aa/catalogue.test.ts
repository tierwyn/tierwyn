import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentProfile } from '@tierwyn/shared';
import {
  aaDeps,
  AaError,
  captureAaEnv,
  ensureCatalogue,
  formatTemplateDraft,
  matchAaSlug,
  _resetAaCache,
  _resetCapturedAaEnv,
} from './catalogue.js';

function prof(partial: Partial<AgentProfile> & Pick<AgentProfile, 'model'>): AgentProfile {
  return {
    id: 'p',
    agentType: 'claude-code',
    label: 'P',
    description: '',
    vision: false,
    steer: false,
    enabled: true,
    ...partial,
  };
}

function row(
  slug: string,
  name: string,
  extra: { intel?: number | null; eng?: number | null } = {},
) {
  return {
    slug,
    name,
    intel: extra.intel ?? null,
    eng: extra.eng ?? null,
    priceIn: null as number | null,
    priceOut: null as number | null,
    tps: null as number | null,
    releaseDate: null as string | null,
  };
}

function aaJson(
  models: Array<{ slug: string; name: string }>,
  opts: { page?: number; hasMore?: boolean; tier?: string } = {},
) {
  const page = opts.page ?? 1;
  const hasMore = opts.hasMore ?? false;
  const tier = opts.tier ?? 'free';
  return {
    tier,
    pagination: { page, page_size: 200, total_pages: hasMore ? 2 : page, has_more: hasMore },
    data: models.map((m) => ({
      slug: m.slug,
      name: m.name,
      evaluations: {
        artificial_analysis_intelligence_index: null,
        artificial_analysis_engineering_index: null,
      },
      pricing: { price_1m_input_tokens: null, price_1m_output_tokens: null },
      performance_v3: { mean_output_tokens_per_second: null },
    })),
  };
}

describe('matchAaSlug', () => {
  it('claude-opus-5.5 matches exact claude-opus-5-5', () => {
    const rows = [row('claude-opus-5-5', 'Claude Opus 5.5', { intel: 59 })];
    const r = matchAaSlug(prof({ model: 'claude-opus-5.5' }), rows);
    expect(r.match).toBe('exact');
    expect(r.row?.slug).toBe('claude-opus-5-5');
  });

  it('claude-haiku-4-5 aliases claude-4-5-haiku (word-order-insensitive)', () => {
    const rows = [row('claude-4-5-haiku', 'Claude Haiku 4.5')];
    const r = matchAaSlug(prof({ model: 'claude-haiku-4-5' }), rows);
    expect(r.match).toBe('alias');
    expect(r.row?.slug).toBe('claude-4-5-haiku');
  });

  it('cursor-grok-4.7-medium is a base match on grok-4-7, never exact; candidates include grok-4-7-high', () => {
    const rows = [
      row('grok-4-7', 'Grok 4.7'),
      row('grok-4-7-high', 'Grok 4.7 High', { intel: 30 }),
    ];
    const r = matchAaSlug(prof({ agentType: 'cursor', model: 'cursor-grok-4.7-medium' }), rows);
    expect(r.match).toBe('base');
    expect(r.row?.slug).toBe('grok-4-7');
    expect(r.candidates.map((c) => c.slug)).toContain('grok-4-7-high');
  });

  it('zai:glm-5.3 matches exact glm-5-3', () => {
    const rows = [row('glm-5-3', 'GLM 5.3')];
    const r = matchAaSlug(prof({ agentType: 'hermes', model: 'zai:glm-5.3' }), rows);
    expect(r.match).toBe('exact');
    expect(r.row?.slug).toBe('glm-5-3');
  });

  it('composer-2.5 never matches', () => {
    const rows = [row('composer-2-5', 'Composer 2.5'), row('claude-opus-5-5', 'Opus')];
    const r = matchAaSlug(prof({ agentType: 'cursor', model: 'composer-2.5' }), rows);
    expect(r.match).toBe('none');
    expect(r.row).toBeNull();
  });

  it('grok-bot never matches', () => {
    const rows = [row('grok-4-6', 'Grok 4.6')];
    const r = matchAaSlug(prof({ agentType: 'grok-bot', model: 'grok-4.6' }), rows);
    expect(r.match).toBe('none');
    expect(r.row).toBeNull();
  });

  it('grok-4.6 matches exact grok-4-6 and candidates contain grok-4-6-xhigh', () => {
    const rows = [
      row('grok-4-6', 'Grok 4.6'),
      row('grok-4-6-xhigh', 'Grok 4.6 xhigh', { intel: 31 }),
    ];
    const r = matchAaSlug(prof({ agentType: 'grok-build', model: 'grok-4.6' }), rows);
    expect(r.match).toBe('exact');
    expect(r.row?.slug).toBe('grok-4-6');
    expect(r.candidates.map((c) => c.slug)).toContain('grok-4-6-xhigh');
  });
});

describe('formatTemplateDraft', () => {
  it('omits null fields and keeps the edit placeholder', () => {
    expect(formatTemplateDraft({
      intel: 59, eng: 65, priceIn: 4, priceOut: 20, tps: 117,
    })).toBe('Intel 59 · eng 65 · $4/$20 per Mtok · 117 tok/s — <edit: when to use>');
    expect(formatTemplateDraft({
      intel: null, eng: null, priceIn: 2, priceOut: 6, tps: null,
    })).toBe('$2/$6 per Mtok — <edit: when to use>');
    expect(formatTemplateDraft({
      intel: null, eng: null, priceIn: null, priceOut: null, tps: null,
    })).toBe('<edit: when to use>');
  });
});

describe('ensureCatalogue', () => {
  const origFetch = aaDeps.fetch;
  const origNow = aaDeps.now;
  let calls: string[] = [];
  let now = 1_000_000;

  beforeEach(() => {
    _resetAaCache();
    _resetCapturedAaEnv();
    calls = [];
    now = 1_000_000;
    aaDeps.now = () => now;
  });

  afterEach(() => {
    aaDeps.fetch = origFetch;
    aaDeps.now = origNow;
    _resetAaCache();
    _resetCapturedAaEnv();
  });

  function stubPages(handler: (page: number) => Response): void {
    aaDeps.fetch = (async (url: string) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('page') || '1');
      return handler(page);
    }) as typeof aaDeps.fetch;
  }

  it('pulls until has_more is false', async () => {
    stubPages((page) => new Response(
      JSON.stringify(aaJson(
        page === 1 ? [{ slug: 'a', name: 'A' }] : [{ slug: 'b', name: 'B' }],
        { page, hasMore: page === 1 },
      )),
      { status: 200, headers: { 'X-AA-Tier': 'free' } },
    ));
    const r = await ensureCatalogue('k'.repeat(8));
    expect(r.rows.map((x) => x.slug)).toEqual(['a', 'b']);
    expect(r.tier).toBe('free');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('page=1');
    expect(calls[1]).toContain('page=2');
  });

  it('a second call within TTL makes no fetch', async () => {
    stubPages(() => new Response(
      JSON.stringify(aaJson([{ slug: 'a', name: 'A' }])),
      { status: 200 },
    ));
    await ensureCatalogue('k'.repeat(8));
    await ensureCatalogue('k'.repeat(8));
    expect(calls).toHaveLength(1);
  });

  it('past TTL + 429 returns the old rows with stale', async () => {
    stubPages(() => new Response(
      JSON.stringify(aaJson([{ slug: 'a', name: 'A' }])),
      { status: 200 },
    ));
    await ensureCatalogue('k'.repeat(8));
    now += 24 * 60 * 60 * 1000 + 1;
    aaDeps.fetch = (async () => new Response('{"error":"quota"}', {
      status: 429,
      headers: { 'Retry-After': '3600' },
    })) as typeof aaDeps.fetch;
    const r = await ensureCatalogue('k'.repeat(8));
    expect(r.stale).toBe(true);
    expect(r.rows.map((x) => x.slug)).toEqual(['a']);
  });

  it('429 with no cache throws aa_quota with retryAfter', async () => {
    aaDeps.fetch = (async () => new Response('{"error":"quota"}', {
      status: 429,
      headers: { 'Retry-After': '120' },
    })) as typeof aaDeps.fetch;
    await expect(ensureCatalogue('k'.repeat(8))).rejects.toBeInstanceOf(AaError);
    await expect(ensureCatalogue('k'.repeat(8))).rejects.toMatchObject({
      code: 'aa_quota',
      retryAfter: '120',
    });
  });

  it('401 throws and clears the cache', async () => {
    stubPages(() => new Response(
      JSON.stringify(aaJson([{ slug: 'a', name: 'A' }])),
      { status: 200 },
    ));
    await ensureCatalogue('k'.repeat(8));
    now += 24 * 60 * 60 * 1000 + 1;
    aaDeps.fetch = (async () => new Response('{"error":"no"}', { status: 401 })) as typeof aaDeps.fetch;
    await expect(ensureCatalogue('k'.repeat(8))).rejects.toMatchObject({ code: 'aa_unauthorized' });
    aaDeps.fetch = (async () => new Response('{"error":"quota"}', { status: 429 })) as typeof aaDeps.fetch;
    await expect(ensureCatalogue('k'.repeat(8))).rejects.toMatchObject({ code: 'aa_quota' });
  });
});

describe('captureAaEnv', () => {
  afterEach(() => _resetCapturedAaEnv());

  it('copies the key off the given env object', () => {
    const env = { TIERWYN_AA_API_KEY: 'test-key-123456' };
    captureAaEnv(env);
    expect(env.TIERWYN_AA_API_KEY).toBeUndefined();
  });
});
