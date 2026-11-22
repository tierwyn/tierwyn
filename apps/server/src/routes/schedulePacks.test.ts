import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedSchedulePacks } from '../db/seed.js';
import { registerSchedulePackRoutes } from './schedulePacks.js';
import { SHIPPED_PACKS } from '../schedules/packs/index.js';

let server: Server;
let base: string;

beforeEach(async () => {
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedSchedulePacks(db);
  setDb(db);
  const app = express();
  app.use(express.json());
  registerSchedulePackRoutes(app, getDb);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function importDoc(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    title: `Imported ${slug}`,
    description: 'd',
    job: {
      cadence: { kind: 'once', fireInMs: 60_000 },
      promptTemplate: 'do it',
    },
    ...extra,
  };
}

describe('GET /schedule-packs', () => {
  it('lists shipped first then imported, slug ASC', async () => {
    await fetch(`${base}/schedule-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importDoc('zeta')),
    });
    await fetch(`${base}/schedule-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importDoc('alpha')),
    });
    const res = await fetch(`${base}/schedule-packs`);
    expect(res.status).toBe(200);
    const body = await res.json() as { packs: Array<{ slug: string; origin: string }> };
    const shipped = SHIPPED_PACKS.map((p) => p.slug).sort();
    expect(body.packs.map((p) => p.slug)).toEqual([...shipped, 'alpha', 'zeta']);
    expect(body.packs.filter((p) => p.origin === 'shipped').map((p) => p.slug)).toEqual(shipped);
  });
});

describe('POST /schedule-packs', () => {
  it('imports a pack (origin forced imported) and returns 201', async () => {
    const res = await fetch(`${base}/schedule-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...importDoc('ops-pack'), origin: 'shipped' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { pack: { slug: string; origin: string; title: string } };
    expect(body.pack.slug).toBe('ops-pack');
    expect(body.pack.origin).toBe('imported');
    expect(body.pack.title).toBe('Imported ops-pack');
  });

  it('409 when the slug belongs to a shipped pack', async () => {
    const res = await fetch(`${base}/schedule-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importDoc('feature-wave', { title: 'hijack' })),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/shipped/);
  });
});

describe('DELETE /schedule-packs/:slug', () => {
  it('403 for shipped, 204 for imported, 404 for unknown', async () => {
    const shipped = await fetch(`${base}/schedule-packs/verify-after-change`, { method: 'DELETE' });
    expect(shipped.status).toBe(403);

    await fetch(`${base}/schedule-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importDoc('tmp-pack')),
    });
    const imported = await fetch(`${base}/schedule-packs/tmp-pack`, { method: 'DELETE' });
    expect(imported.status).toBe(204);

    const missing = await fetch(`${base}/schedule-packs/nope`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});
