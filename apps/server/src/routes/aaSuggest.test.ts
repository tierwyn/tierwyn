import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import {
  aaDeps as catalogueDeps,
  captureAaEnv,
  _resetAaCache,
  _resetCapturedAaEnv,
} from '../aa/catalogue.js';
import { aaDeps, registerAaRoutes, SUGGEST_SYSTEM } from './aaSuggest.js';

const KEY = 'test-key-123456';
const NOW = 1_700_000_000_000;

function aaPayload(models: Array<{ slug: string; name: string; intel?: number | null }>) {
  return {
    tier: 'free',
    pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
    data: models.map((m) => ({
      slug: m.slug,
      name: m.name,
      evaluations: {
        artificial_analysis_intelligence_index: m.intel ?? 59,
        artificial_analysis_engineering_index: 65,
      },
      pricing: { price_1m_input_tokens: 4, price_1m_output_tokens: 20 },
      performance_v3: { mean_output_tokens_per_second: 117 },
    })),
  };
}

describe('aa suggest routes', () => {
  let db: Database.Database;
  let app: express.Express;
  const origFetch = catalogueDeps.fetch;
  const origNow = catalogueDeps.now;
  const origComplete = aaDeps.sidecarComplete;
  const origReady = aaDeps.sidecarSiteReady;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    db.prepare(`INSERT INTO agents (id, type, label, created_at) VALUES ('claude-code', 'claude-code', 'Claude Code', ?)`)
      .run(NOW);
    db.prepare(`INSERT INTO agents (id, type, label, created_at) VALUES ('cursor', 'cursor', 'Cursor', ?)`)
      .run(NOW);
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
       VALUES ('claude-code:opus-5.5', 'claude-code', 'claude-opus-5.5', 'Claude Code · Opus 5.5', 1, ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
       VALUES ('cursor:composer-2.5', 'cursor', 'composer-2.5', 'Cursor · Composer 2.5', 1, ?)`,
    ).run(NOW);
    catalogue.load(db);

    app = express();
    registerAaRoutes(app, { getDb: () => db });

    _resetAaCache();
    _resetCapturedAaEnv();
    captureAaEnv({ TIERWYN_AA_API_KEY: KEY });
    catalogueDeps.now = () => NOW;
    catalogueDeps.fetch = (async () => new Response(
      JSON.stringify(aaPayload([
        { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { slug: 'grok-4-6-xhigh', name: 'Grok 4.6 xhigh', intel: 31 },
        { slug: 'grok-4-6', name: 'Grok 4.6', intel: null },
        { slug: 'glm-5-3', name: 'GLM 5.3', intel: 32 },
      ])),
      { status: 200, headers: { 'X-AA-Tier': 'free' } },
    )) as typeof catalogueDeps.fetch;
    aaDeps.sidecarSiteReady = () => true;
    aaDeps.sidecarComplete = origComplete;
  });

  afterEach(() => {
    catalogueDeps.fetch = origFetch;
    catalogueDeps.now = origNow;
    aaDeps.sidecarComplete = origComplete;
    aaDeps.sidecarSiteReady = origReady;
    _resetAaCache();
    _resetCapturedAaEnv();
    db.close();
  });

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    } finally {
      server.close();
    }
  }

  it('POST suggest success uses enhance + SUGGEST_SYSTEM and returns llm draft', async () => {
    const complete = vi.fn(async () => 'Use for hard planning — intel 59, $4/$20');
    aaDeps.sidecarComplete = complete as typeof aaDeps.sidecarComplete;
    const { status, body } = await request('POST', '/settings/aa/suggest', {
      profileId: 'claude-code:opus-5.5',
      role: 'planner',
      siblingWhens: ['use for UI polish'],
    });
    expect(status).toBe(200);
    const res = body as { source: string; match: string; draft: string; metrics: { intel: number } };
    expect(res.source).toBe('llm');
    expect(res.match).toBe('exact');
    expect(res.draft).toBe('Use for hard planning — intel 59, $4/$20');
    expect(res.metrics.intel).toBe(59);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![1]).toBe('enhance');
    expect(complete.mock.calls[0]![3]).toMatchObject({ systemPrompt: SUGGEST_SYSTEM, oneShotMode: 'none' });
    expect(complete.mock.calls[0]![3]).not.toHaveProperty('cwd');
    const prompt = complete.mock.calls[0]![2] as string;
    expect(prompt).toContain('use for UI polish');
    expect(prompt).not.toContain(KEY);
  });

  it('429 with a primed cache returns stale:true', async () => {
    aaDeps.sidecarComplete = vi.fn(async () => 'ok') as typeof aaDeps.sidecarComplete;
    await request('POST', '/settings/aa/suggest', { profileId: 'claude-code:opus-5.5' });
    catalogueDeps.now = () => NOW + 24 * 60 * 60 * 1000 + 1;
    catalogueDeps.fetch = (async () => new Response('{"error":"quota"}', {
      status: 429,
      headers: { 'Retry-After': '3600' },
    })) as typeof catalogueDeps.fetch;
    const { status, body } = await request('POST', '/settings/aa/suggest', { profileId: 'claude-code:opus-5.5' });
    expect(status).toBe(200);
    expect((body as { stale?: true }).stale).toBe(true);
  });

  it('composer profile is match none, no LLM call', async () => {
    const complete = vi.fn(async () => 'nope');
    aaDeps.sidecarComplete = complete as typeof aaDeps.sidecarComplete;
    const { status, body } = await request('POST', '/settings/aa/suggest', {
      profileId: 'cursor:composer-2.5',
    });
    expect(status).toBe(200);
    const res = body as { draft: string | null; match: string; candidates: unknown[] };
    expect(res.draft).toBeNull();
    expect(res.match).toBe('none');
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('LLM failure falls back to the Intel template draft', async () => {
    aaDeps.sidecarComplete = vi.fn(async () => { throw new Error('boom'); }) as typeof aaDeps.sidecarComplete;
    const { status, body } = await request('POST', '/settings/aa/suggest', {
      profileId: 'claude-code:opus-5.5',
    });
    expect(status).toBe(200);
    const res = body as { source: string; llmError: string; draft: string };
    expect(res.source).toBe('template');
    expect(res.llmError).toBeTruthy();
    expect(res.draft.startsWith('Intel')).toBe(true);
  });

  it('aaSlug override wins; unknown slug is 400', async () => {
    aaDeps.sidecarComplete = vi.fn(async () => 'x') as typeof aaDeps.sidecarComplete;
    const ok = await request('POST', '/settings/aa/suggest', {
      profileId: 'claude-code:opus-5.5',
      aaSlug: 'grok-4-6-xhigh',
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { match: string }).match).toBe('override');
    const bad = await request('POST', '/settings/aa/suggest', {
      profileId: 'claude-code:opus-5.5',
      aaSlug: 'not-a-real-slug',
    });
    expect(bad.status).toBe(400);
  });

  it('no key → 409; PUT key with vault off → 503', async () => {
    _resetCapturedAaEnv();
    const missing = await request('POST', '/settings/aa/suggest', { profileId: 'claude-code:opus-5.5' });
    expect(missing.status).toBe(409);
    expect((missing.body as { error: string }).error).toMatch(/Artificial Analysis API key/i);
    const put = await request('PUT', '/settings/aa/key', { value: 'a-real-looking-key' });
    expect(put.status).toBe(503);
  });

  it('GET /settings/aa never contains the key string', async () => {
    const { status, body } = await request('GET', '/settings/aa');
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect((body as { configured: boolean; source: string }).configured).toBe(true);
    expect((body as { source: string }).source).toBe('env');
  });
});
