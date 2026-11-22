import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { SIDECAR_SITE_DEFAULT_PROFILE } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { updateSidecarLlmSettings } from '../repositories/settings.js';
import { directLlmDeps, registerDirectLlmRoutes } from './directLlm.js';

describe('direct LLM routes', () => {
  let db: Database.Database;
  let app: express.Express;
  const origClean = directLlmDeps.clean;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    app = express();
    app.use(express.json());
    registerDirectLlmRoutes(app, () => db);
    directLlmDeps.clean = origClean;
  });

  afterEach(() => {
    directLlmDeps.clean = origClean;
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

  it('GET returns the two built-ins', async () => {
    const { status, body } = await request('GET', '/settings/direct-llm');
    expect(status).toBe(200);
    const profiles = (body as { profiles: { id: string }[] }).profiles;
    expect(profiles.map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
  });

  it('POST /settings/direct-llm returns createdId and a following GET shows 3', async () => {
    const created = await request('POST', '/settings/direct-llm', {});
    expect(created.status).toBe(200);
    const createdId = (created.body as { createdId: string }).createdId;
    expect(createdId).toBeTruthy();
    const { body } = await request('GET', '/settings/direct-llm');
    expect((body as { profiles: { id: string }[] }).profiles.map((p) => p.id))
      .toEqual(['cleanup', 'enhancer', createdId]);
  });

  it('POST /settings/direct-llm/:id with { model } is visible in the response profiles', async () => {
    const createdId = ((await request('POST', '/settings/direct-llm', {})).body as { createdId: string }).createdId;
    const { status, body } = await request('POST', `/settings/direct-llm/${createdId}`, { model: 'm' });
    expect(status).toBe(200);
    const updated = (body as { profiles: { id: string; model: string }[] }).profiles.find((p) => p.id === createdId);
    expect(updated?.model).toBe('m');
  });

  it('POST /settings/direct-llm/nope → 400 with unknown direct llm profile text', async () => {
    const { status, body } = await request('POST', '/settings/direct-llm/nope', { model: 'x' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/unknown direct llm profile: nope/);
  });

  it('DELETE an extra → 200, profiles has 2, sidecar reflects reassignment', async () => {
    const createdId = ((await request('POST', '/settings/direct-llm', {})).body as { createdId: string }).createdId;
    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: createdId },
    }, []);
    const { status, body } = await request('DELETE', `/settings/direct-llm/${createdId}`);
    expect(status).toBe(200);
    const res = body as { profiles: { id: string }[]; sidecar: { describe: { profile?: string } } };
    expect(res.profiles.map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
    expect(res.sidecar.describe.profile).toBe('cleanup');
    expect(res.sidecar.describe.profile).not.toBe(SIDECAR_SITE_DEFAULT_PROFILE.describe);
  });

  it('DELETE /settings/direct-llm/cleanup → 200 and drops it from the list', async () => {
    const { status, body } = await request('DELETE', '/settings/direct-llm/cleanup');
    expect(status).toBe(200);
    const res = body as { profiles: { id: string }[] };
    expect(res.profiles.map((p) => p.id)).toEqual(['enhancer']);
  });

  it('POST …/test on an unconfigured profile → 400 and clean was not called', async () => {
    const clean = vi.fn(async () => 'OK');
    directLlmDeps.clean = clean as never;
    const { status, body } = await request('POST', '/settings/direct-llm/cleanup/test', {});
    expect(status).toBe(400);
    expect((body as { ok: boolean; error: string }).ok).toBe(false);
    expect((body as { error: string }).error).toMatch(/not configured/);
    expect(clean).not.toHaveBeenCalled();
  });

  it('POST …/test happy path → 200 with reply and latencyMs; clean gets systemPrompt and test text', async () => {
    await request('POST', '/settings/direct-llm/cleanup', {
      model: 'm', baseUrl: 'http://127.0.0.1:1234/v1',
    });
    const clean = vi.fn(async () => 'OK');
    directLlmDeps.clean = clean as never;
    const { status, body } = await request('POST', '/settings/direct-llm/cleanup/test', {});
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      reply: 'OK',
      latencyMs: expect.any(Number),
    });
    expect(clean).toHaveBeenCalledTimes(1);
    expect(clean.mock.calls[0]![0]).toMatchObject({ systemPrompt: 'Reply with the single word OK.' });
    expect(clean.mock.calls[0]![1]).toBe('test');
  });

  it('POST …/test when clean rejects → 502 { ok:false, error }', async () => {
    await request('POST', '/settings/direct-llm/cleanup', {
      model: 'm', baseUrl: 'http://127.0.0.1:1234/v1',
    });
    directLlmDeps.clean = vi.fn(async () => { throw new Error('boom'); }) as never;
    const { status, body } = await request('POST', '/settings/direct-llm/cleanup/test', {});
    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, error: 'boom' });
  });

  it('POST /settings/direct-llm with invalid provider → 400', async () => {
    const { status, body } = await request('POST', '/settings/direct-llm', { provider: 'bogus' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/invalid provider: bogus/);
  });

  it('POST /settings/direct-llm/:id with invalid provider → 400', async () => {
    const { status, body } = await request('POST', '/settings/direct-llm/cleanup', { provider: 'bogus' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/invalid provider: bogus/);
  });

  it('POST /settings/direct-llm/:id with non-string label → 400', async () => {
    const { status, body } = await request('POST', '/settings/direct-llm/cleanup', { label: 42 });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/label must be a string/);
  });

  it('POST /settings/direct-llm/ghost/test → 400 unknown profile', async () => {
    const { status, body } = await request('POST', '/settings/direct-llm/ghost/test', {});
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/unknown direct llm profile: ghost/);
  });
});
