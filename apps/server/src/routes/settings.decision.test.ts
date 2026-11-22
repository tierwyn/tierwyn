import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import Database from 'better-sqlite3';
import { BUILTIN_TAG_CATALOGUE, DECISION_DEFAULTS, TAG_CATALOGUE_DEFAULTS } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { getDecisionSettings, getTagCatalogueSettings, publicDecisionSettings, updateDecisionSettings } from '../repositories/settings.js';
import { decideDeps } from '../decide.js';
import { registerDecisionSettingsRoutes } from './settings.js';

function boot() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerDecisionSettingsRoutes(app, () => db);
  return { db, app };
}

function fetchJson(
  app: express.Express, method: string, path: string, body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const origFetch = decideDeps.fetch;
afterEach(() => {
  decideDeps.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('decision settings repository', () => {
  it('getDecisionSettings returns DECISION_DEFAULTS on fresh DB', () => {
    const { db } = boot();
    expect(getDecisionSettings(db)).toEqual(DECISION_DEFAULTS);
    expect(DECISION_DEFAULTS.enabled).toBe(false);
  });

  it('corrupt JSON falls back to defaults; update round-trips', () => {
    const { db } = boot();
    db.prepare("INSERT INTO settings (key, value) VALUES ('decision', '{nope')").run();
    expect(getDecisionSettings(db)).toEqual(DECISION_DEFAULTS);
    expect(updateDecisionSettings(db, { enabled: true, apiKey: 'k' }).enabled).toBe(true);
    expect(getDecisionSettings(db).apiKey).toBe('k');
  });

  it('publicDecisionSettings strips apiKey', () => {
    const pub = publicDecisionSettings({ ...DECISION_DEFAULTS, apiKey: 'sekret' });
    expect(pub).not.toHaveProperty('apiKey');
    expect(pub.apiKeySet).toBe(true);
    expect(publicDecisionSettings(DECISION_DEFAULTS).apiKeySet).toBe(false);
  });
});

describe('decision settings routes', () => {
  it('GET /settings/decision omits apiKey and reports apiKeySet', async () => {
    const { app, db } = boot();
    updateDecisionSettings(db, { apiKey: 'sekret' });
    const r = await fetchJson(app, 'GET', '/settings/decision');
    expect(r.status).toBe(200);
    const s = r.body.settings as Record<string, unknown>;
    expect(s).not.toHaveProperty('apiKey');
    expect(s.apiKeySet).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('sekret');
  });

  it('POST validates baseUrl/model types', async () => {
    const { app } = boot();
    expect((await fetchJson(app, 'POST', '/settings/decision', { baseUrl: 'ftp://x' })).status).toBe(400);
    expect((await fetchJson(app, 'POST', '/settings/decision', { baseUrl: 'nope' })).status).toBe(400);
    expect((await fetchJson(app, 'POST', '/settings/decision', { model: 5 })).status).toBe(400);
    expect((await fetchJson(app, 'POST', '/settings/decision', { model: 'x'.repeat(65) })).status).toBe(400);
    expect((await fetchJson(app, 'POST', '/settings/decision', { enabled: 'yes' })).status).toBe(400);
    const ok = await fetchJson(app, 'POST', '/settings/decision', { baseUrl: 'https://example.com/', model: ' jev-x ', bogus: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ baseUrl: 'https://example.com', model: 'jev-x' });
  });

  it("POST apiKey '' clears; absent leaves unchanged", async () => {
    const { app, db } = boot();
    await fetchJson(app, 'POST', '/settings/decision', { apiKey: '  abc  ' });
    expect(getDecisionSettings(db).apiKey).toBe('abc');
    await fetchJson(app, 'POST', '/settings/decision', { enabled: true });
    expect(getDecisionSettings(db).apiKey).toBe('abc');
    const r = await fetchJson(app, 'POST', '/settings/decision', { apiKey: '' });
    expect((r.body.settings as Record<string, unknown>).apiKeySet).toBe(false);
    expect(getDecisionSettings(db).apiKey).toBe('');
  });

  it('whitespace-only apiKey keeps the stored key; a redacted GET shape POSTed back keeps it too', async () => {
    const { app, db } = boot();
    await fetchJson(app, 'POST', '/settings/decision', { apiKey: 'abc' });
    const r = await fetchJson(app, 'POST', '/settings/decision', { apiKey: '  ' });
    expect((r.body.settings as Record<string, unknown>).apiKeySet).toBe(true);
    expect(getDecisionSettings(db).apiKey).toBe('abc');
    const got = await fetchJson(app, 'GET', '/settings/decision');
    await fetchJson(app, 'POST', '/settings/decision', got.body.settings);
    expect(getDecisionSettings(db).apiKey).toBe('abc');
  });

  it('POST /settings/decision/test uses callSystemOne with a noul question', async () => {
    const { app, db } = boot();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await fetchJson(app, 'POST', '/settings/decision/test')).status).toBe(400);
    updateDecisionSettings(db, { apiKey: 'k' }); // enabled stays false: test ignores it
    const f = vi.fn(async () => new Response(JSON.stringify({
      answers: { ok: { type: 'noul', noul: 0.9 } }, model: 'jev-1.13.0',
    }), { status: 200 }));
    decideDeps.fetch = f;
    const r = await fetchJson(app, 'POST', '/settings/decision/test');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, model: 'jev-1.13.0', noul: 0.9 });
    const sent = JSON.parse(((f.mock.calls[0] as unknown) as [string, RequestInit])[1].body as string);
    expect(sent.questions.ok.type).toBe('noul');

    decideDeps.fetch = async () => new Response('{}', { status: 401 });
    const bad = await fetchJson(app, 'POST', '/settings/decision/test');
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ ok: false, error: 'http 401' });
  });
  it('settings accept memoryCheckEnabled, reject non-boolean, default false', async () => {
    const { app, db } = boot();
    expect(DECISION_DEFAULTS.memoryCheckEnabled).toBe(false);
    expect((await fetchJson(app, 'POST', '/settings/decision', { memoryCheckEnabled: 'yes' })).status).toBe(400);
    await fetchJson(app, 'POST', '/settings/decision', { apiKey: 'sekret' });
    const r = await fetchJson(app, 'POST', '/settings/decision', { memoryCheckEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ memoryCheckEnabled: true, apiKeySet: true });
    expect(getDecisionSettings(db).memoryCheckEnabled).toBe(true);
    const got = await fetchJson(app, 'GET', '/settings/decision');
    expect((got.body.settings as Record<string, unknown>).memoryCheckEnabled).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain('sekret');
    expect(got.body.settings).not.toHaveProperty('apiKey');
  });

  it('autoTagEnabled round-trips, rejects non-booleans, and never exposes the key', async () => {
    const { app, db } = boot();
    expect(DECISION_DEFAULTS.autoTagEnabled).toBe(false);
    expect((await fetchJson(app, 'POST', '/settings/decision', { autoTagEnabled: 'yes' })).status).toBe(400);
    await fetchJson(app, 'POST', '/settings/decision', { apiKey: 'sekret' });
    const r = await fetchJson(app, 'POST', '/settings/decision', { autoTagEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ autoTagEnabled: true, apiKeySet: true });
    expect(getDecisionSettings(db).autoTagEnabled).toBe(true);
    const got = await fetchJson(app, 'GET', '/settings/decision');
    expect((got.body.settings as Record<string, unknown>).autoTagEnabled).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain('sekret');
    expect(got.body.settings).not.toHaveProperty('apiKey');
  });

  it('tag-catalogue: defaults, 400 on bad input, valid document round-trips', async () => {
    const { app, db } = boot();
    const first = await fetchJson(app, 'GET', '/settings/tag-catalogue');
    expect(first.status).toBe(200);
    expect(first.body.catalogue).toEqual(TAG_CATALOGUE_DEFAULTS);
    expect(first.body.builtins).toEqual(BUILTIN_TAG_CATALOGUE);

    const bad = await fetchJson(app, 'POST', '/settings/tag-catalogue', { custom: [{ tag: 'Bug', hint: 'h' }], disabledBuiltins: [] });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe('string');
    expect((await fetchJson(app, 'POST', '/settings/tag-catalogue', { custom: [], disabledBuiltins: ['nope'] })).status).toBe(400);
    expect((await fetchJson(app, 'POST', '/settings/tag-catalogue', [])).status).toBe(400);
    // a disabledBuiltins entry naming a custom (non-built-in) tag is rejected too
    expect((await fetchJson(app, 'POST', '/settings/tag-catalogue', { custom: [{ tag: 'mine', hint: 'h' }], disabledBuiltins: ['mine'] })).status).toBe(400);
    expect(getTagCatalogueSettings(db)).toEqual(TAG_CATALOGUE_DEFAULTS);

    const doc = { custom: [{ tag: 'mine', hint: 'why' }], disabledBuiltins: ['bug'] };
    const ok = await fetchJson(app, 'POST', '/settings/tag-catalogue', doc);
    expect(ok.status).toBe(200);
    expect(ok.body.catalogue).toEqual(doc);
    expect((await fetchJson(app, 'GET', '/settings/tag-catalogue')).body.catalogue).toEqual(doc);
  });

  it('tag-catalogue: a stored row referencing since-evolved built-ins still loads its customs; strict POST rejects it', async () => {
    const { app, db } = boot();
    const stale = {
      custom: [{ tag: 'mine', hint: 'why' }, { tag: 'Bug', hint: 'now a built-in' }],
      disabledBuiltins: ['removed-builtin', 'ui'],
    };
    db.prepare("INSERT INTO settings (key, value) VALUES ('conversation_tag_catalogue', ?)").run(JSON.stringify(stale));
    const expected = { custom: [{ tag: 'mine', hint: 'why' }], disabledBuiltins: ['ui'] };
    expect(getTagCatalogueSettings(db)).toEqual(expected);
    expect((await fetchJson(app, 'GET', '/settings/tag-catalogue')).body.catalogue).toEqual(expected);
    expect((await fetchJson(app, 'POST', '/settings/tag-catalogue', stale)).status).toBe(400);
    // the defaults path returns a fresh object, never the shared constant
    const fresh = boot().db;
    expect(getTagCatalogueSettings(fresh)).not.toBe(TAG_CATALOGUE_DEFAULTS);
  });

  it('tag-catalogue: a corrupt or invalid row reads as the defaults', async () => {
    const { app, db } = boot();
    db.prepare("INSERT INTO settings (key, value) VALUES ('conversation_tag_catalogue', '{nope')").run();
    expect((await fetchJson(app, 'GET', '/settings/tag-catalogue')).body.catalogue).toEqual(TAG_CATALOGUE_DEFAULTS);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'conversation_tag_catalogue'")
      .run(JSON.stringify({ custom: 'not-an-array', disabledBuiltins: [] }));
    expect((await fetchJson(app, 'GET', '/settings/tag-catalogue')).body.catalogue).toEqual(TAG_CATALOGUE_DEFAULTS);
  });

  it('tag-catalogue routes are registered inside the cookie-only Jev registrar, which index.ts mounts after requireAuth', () => {
    const idx = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8');
    const authIdx = idx.indexOf('app.use(requireAuth(authConfig))');
    const jevIdx = idx.indexOf('registerDecisionSettingsRoutes(app');
    expect(authIdx).toBeGreaterThan(-1);
    expect(jevIdx).toBeGreaterThan(authIdx);
    const src = readFileSync(new URL('./settings.ts', import.meta.url), 'utf-8');
    const registrar = src.slice(src.indexOf('export function registerDecisionSettingsRoutes'), src.indexOf('export function registerRetentionPurgeRoute'));
    expect(registrar).toContain("'/settings/tag-catalogue'");
  });
});
