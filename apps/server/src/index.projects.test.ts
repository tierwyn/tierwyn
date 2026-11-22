import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { createProject, getProject, deleteProject } from './repositories/projects.js';
import { ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from './db/seed.js';

/**
 * Mirrors `DELETE /projects/:id` in index.ts (404 → system 409 → session-stop →
 * cascade). Kept here so the 409 ordering can be asserted without booting the
 * whole server / SessionManager.
 */
function registerDelete(
  app: express.Express,
  getDb: () => Database.Database,
  stopSessions: (projectId: string) => Promise<void>,
): void {
  app.delete('/projects/:id', async (req, res) => {
    const id = req.params.id;
    const project = getProject(getDb(), id);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    if (project.system) { res.status(409).json({ error: 'system project cannot be deleted' }); return; }
    await stopSessions(id);
    const result = deleteProject(getDb(), id);
    if (!result.ok) { res.status(404).json({ error: 'no such project' }); return; }
    res.json({ ok: true });
  });
}

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const stopped: string[] = [];
  const app = express();
  app.use(express.json());
  registerDelete(app, () => db, async (id) => { stopped.push(id); });
  const project = createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
  return { db, app, project, stopped };
}

function del(app: express.Express, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' })
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('DELETE /projects/:id', () => {
  it('409s a system project, leaves the row, and does not stop sessions', async () => {
    const { db, app, stopped } = boot();
    ensureRemoteAgentsProject(db);
    const res = await del(app, `/projects/${REMOTE_AGENTS_PROJECT_ID}`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('system project cannot be deleted');
    expect(getProject(db, REMOTE_AGENTS_PROJECT_ID)?.system).toBe(true);
    expect(stopped).toEqual([]);
  });

  it('200s a normal project delete', async () => {
    const { db, app, project, stopped } = boot();
    const res = await del(app, `/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(getProject(db, project.id)).toBeUndefined();
    expect(stopped).toEqual([project.id]);
  });
});
