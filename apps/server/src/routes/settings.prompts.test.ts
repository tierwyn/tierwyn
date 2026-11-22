import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { PROMPT_BODY_MAX } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { registerGeneralSettingsRoutes } from './settings.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  const app = express();
  app.use(express.json());
  registerGeneralSettingsRoutes(app, () => db);
  return { db, app };
}

function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (r) => {
          const text = await r.text();
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          return { status: r.status, body: parsed };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('GET /settings/prompts', () => {
  it('returns an empty array on a fresh DB', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'GET', '/settings/prompts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prompts: [] });
  });

  it('returns [] on a corrupt blob (unparseable or non-array)', async () => {
    const { db, app } = boot();
    const writeBlob = (v: string) =>
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('prompt_collection', ?)").run(v);
    writeBlob('{not json');
    const unparseable = await fetchJson(app, 'GET', '/settings/prompts');
    expect(unparseable.status).toBe(200);
    expect(unparseable.body).toEqual({ prompts: [] });
    writeBlob('{"x":1}');
    const nonArray = await fetchJson(app, 'GET', '/settings/prompts');
    expect(nonArray.status).toBe(200);
    expect(nonArray.body).toEqual({ prompts: [] });
  });
});

describe('POST /settings/prompts', () => {
  it('round-trips create → list → edit (no duplicate, createdAt preserved) → delete', async () => {
    const { app } = boot();

    const create = await fetchJson(app, 'POST', '/settings/prompts', {
      name: 'First',
      description: 'A custom prompt',
      body: 'Do something useful.',
    });
    expect(create.status).toBe(200);
    const created = (create.body as { prompts: Array<{ id: string; createdAt: number }> }).prompts;
    expect(created).toHaveLength(1);
    const id = created[0].id;
    const createdAt = created[0].createdAt;

    const list = await fetchJson(app, 'GET', '/settings/prompts');
    expect(list.status).toBe(200);
    expect((list.body as { prompts: unknown[] }).prompts).toHaveLength(1);

    const edit = await fetchJson(app, 'POST', '/settings/prompts', {
      id,
      name: 'First (edited)',
      description: 'Updated',
      body: 'Updated body.',
      createdAt,
    });
    expect(edit.status).toBe(200);
    const edited = (edit.body as { prompts: Array<{ id: string; name: string; createdAt: number }> }).prompts;
    expect(edited).toHaveLength(1);
    expect(edited[0].id).toBe(id);
    expect(edited[0].name).toBe('First (edited)');
    expect(edited[0].createdAt).toBe(createdAt);

    const del = await fetchJson(app, 'DELETE', `/settings/prompts/${encodeURIComponent(id)}`);
    expect(del.status).toBe(200);
    expect((del.body as { prompts: unknown[] }).prompts).toHaveLength(0);

    const listAfter = await fetchJson(app, 'GET', '/settings/prompts');
    expect((listAfter.body as { prompts: unknown[] }).prompts).toHaveLength(0);
  });

  it('returns 400 on empty name', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/prompts', {
      name: '  ',
      description: 'd',
      body: 'b',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name is required' });
  });

  it('returns 400 on a body over PROMPT_BODY_MAX', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/prompts', {
      name: 'n',
      description: 'd',
      body: 'x'.repeat(PROMPT_BODY_MAX + 1),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/body must be/) }));
  });

  it('returns 400 on an id starting with preset-', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/prompts', {
      id: 'preset-fake',
      name: 'n',
      description: 'd',
      body: 'b',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'id cannot start with preset-' });
  });
});

describe('DELETE /settings/prompts/:id', () => {
  it('is idempotent 200 for an unknown id', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'DELETE', '/settings/prompts/does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prompts: [] });
  });
});

const PACK_KIND = 'tierwyn-prompt-pack';

function packDoc(prompts: unknown[], extra: Record<string, unknown> = {}) {
  return { kind: PACK_KIND, version: 1, prompts, ...extra };
}

describe('POST /settings/prompts/import', () => {
  it('imports into an empty collection', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/prompts/import', {
      pack: packDoc([
        { name: 'One', description: 'First', body: 'Do one.' },
        { name: 'Two', description: 'Second', body: 'Do two.' },
      ]),
    });
    expect(res.status).toBe(200);
    const body = res.body as { prompts: unknown[]; imported: string[]; skipped: unknown[] };
    expect(body.imported).toHaveLength(2);
    expect(body.skipped).toHaveLength(0);
    expect(body.prompts).toHaveLength(2);

    const list = await fetchJson(app, 'GET', '/settings/prompts');
    expect((list.body as { prompts: unknown[] }).prompts).toHaveLength(2);
  });

  it('returns 400 on one invalid entry and leaves the collection unchanged', async () => {
    const { app } = boot();
    const seed = await fetchJson(app, 'POST', '/settings/prompts', {
      name: 'Existing',
      description: 'Already here',
      body: 'Stay.',
    });
    expect(seed.status).toBe(200);

    const res = await fetchJson(app, 'POST', '/settings/prompts/import', {
      pack: packDoc([
        { name: 'Good', description: 'ok', body: 'ok' },
        { name: '', description: 'bad', body: 'bad' },
      ]),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/^prompts\[1\]:/) }));

    const list = await fetchJson(app, 'GET', '/settings/prompts');
    const prompts = (list.body as { prompts: Array<{ name: string }> }).prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe('Existing');
  });

  it('skips colliding ids when overwrite is absent', async () => {
    const { app } = boot();
    const create = await fetchJson(app, 'POST', '/settings/prompts', {
      name: 'First',
      description: 'A custom prompt',
      body: 'Original body.',
    });
    const created = (create.body as { prompts: Array<{ id: string; name: string; body: string }> }).prompts[0];

    const res = await fetchJson(app, 'POST', '/settings/prompts/import', {
      pack: packDoc([{
        id: created.id,
        name: created.name,
        description: 'A custom prompt',
        body: 'Changed body.',
      }]),
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      imported: string[];
      skipped: Array<{ id: string; name: string }>;
      prompts: Array<{ id: string; body: string }>;
    };
    expect(body.imported).toEqual([]);
    expect(body.skipped).toEqual([{ id: created.id, name: created.name }]);
    expect(body.prompts[0].body).toBe('Original body.');
  });

  it('replaces colliding ids when overwrite is true, preserving createdAt', async () => {
    const { app } = boot();
    const create = await fetchJson(app, 'POST', '/settings/prompts', {
      name: 'First',
      description: 'A custom prompt',
      body: 'Original body.',
    });
    const created = (create.body as {
      prompts: Array<{ id: string; name: string; createdAt: number; updatedAt: number }>;
    }).prompts[0];

    await new Promise((r) => setTimeout(r, 5));

    const res = await fetchJson(app, 'POST', '/settings/prompts/import', {
      pack: packDoc([{
        id: created.id,
        name: created.name,
        description: 'A custom prompt',
        body: 'Changed body.',
      }]),
      overwrite: true,
    });
    expect(res.status).toBe(200);
    const row = (res.body as {
      imported: string[];
      prompts: Array<{ id: string; body: string; createdAt: number; updatedAt: number }>;
    });
    expect(row.imported).toEqual([created.id]);
    expect(row.prompts[0].body).toBe('Changed body.');
    expect(row.prompts[0].createdAt).toBe(created.createdAt);
    expect(row.prompts[0].updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it('imports a pack with no ids twice as two distinct sets', async () => {
    const { app } = boot();
    const pack = packDoc([{ name: 'Anon', description: 'no id', body: 'hello' }]);
    const first = await fetchJson(app, 'POST', '/settings/prompts/import', { pack });
    const second = await fetchJson(app, 'POST', '/settings/prompts/import', { pack });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const list = await fetchJson(app, 'GET', '/settings/prompts');
    const prompts = (list.body as { prompts: Array<{ id: string }> }).prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).not.toBe(prompts[1].id);
  });

  it('returns 400 when overwrite is a string', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/prompts/import', {
      pack: packDoc([{ name: 'n', description: 'd', body: 'b' }]),
      overwrite: 'yes',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'overwrite must be a boolean' });
  });

  it('stores variables carried on imported prompts', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/prompts/import', {
      pack: packDoc([{
        name: 'Scoped',
        description: 'Has a variable',
        body: 'Review {{scope}}',
        variables: [{ name: 'scope', label: 'Scope', default: 'src/' }],
      }]),
    });
    expect(res.status).toBe(200);
    const prompts = (res.body as {
      prompts: Array<{ variables?: Array<{ name: string; label?: string; default?: string }> }>;
    }).prompts;
    expect(prompts[0].variables).toEqual([{ name: 'scope', label: 'Scope', default: 'src/' }]);
  });
});
