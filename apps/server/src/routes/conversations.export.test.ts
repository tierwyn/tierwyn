import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, () => db);
  const p = createProject(db, { name: 'Tierwyn', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'Export me' });
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)')
    .run('s-1', c.id, now, now);
  let seq = 0;
  const addEvent = (type: string, payload: unknown, sender: 'user' | 'agent' | 'system' = 'agent') => {
    seq += 1;
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run(`e-${seq}`, 's-1', type, JSON.stringify(payload), sender, seq, now + seq);
  };
  return { db, app, projectId: p.id, conversationId: c.id, addEvent };
}

function fetchRaw(
  app: express.Express,
  path: string,
): Promise<{ status: number; text: string; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('GET /conversations/:id/export', () => {
  it('returns 404 for an unknown id', async () => {
    const { app } = boot();
    const res = await fetchRaw(app, '/conversations/nope/export');
    expect(res.status).toBe(404);
    expect(res.text).toContain('no such conversation');
  });

  it('serves markdown as an attachment with a .md filename', async () => {
    const { app, conversationId } = boot();
    const res = await fetchRaw(app, `/conversations/${conversationId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment;');
    expect(cd).toContain(`filename="export-me-${conversationId.slice(0, 8)}.md"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('puts the title and ids in the metadata header', async () => {
    const { app, conversationId, projectId } = boot();
    const res = await fetchRaw(app, `/conversations/${conversationId}/export`);
    expect(res.text).toContain('# Export me');
    expect(res.text).toContain(`- **Conversation:** \`${conversationId}\``);
    expect(res.text).toContain(`- **Project:** Tierwyn (\`${projectId}\`)`);
  });

  it('returns 200 with a header-only body for an empty transcript', async () => {
    const { app, conversationId } = boot();
    const res = await fetchRaw(app, `/conversations/${conversationId}/export`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# Export me');
    expect(res.text).not.toContain('## User');
  });

  it('renders stored events in ts/seq order with role labels', async () => {
    const { app, conversationId, addEvent } = boot();
    addEvent('prompt', { text: 'do the thing' }, 'user');
    addEvent('message', { chunk: 'on ' });
    addEvent('message', { chunk: 'it' });
    addEvent('tool_call', { name: 'Bash', input: { command: 'ls -la' } });
    addEvent('message', { chunk: 'finished' });

    const res = await fetchRaw(app, `/conversations/${conversationId}/export`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('## User\n\ndo the thing');
    expect(res.text).toContain('## Agent\n\non it');
    expect(res.text).toContain('- **Tool** `Bash` — `ls -la`');
    expect(res.text.indexOf('do the thing')).toBeLessThan(res.text.indexOf('on it'));
    expect(res.text.indexOf('on it')).toBeLessThan(res.text.indexOf('ls -la'));
    expect(res.text.indexOf('ls -la')).toBeLessThan(res.text.indexOf('finished'));
  });

  it('summarises the tool call rather than dumping the whole input object', async () => {
    const { app, conversationId, addEvent } = boot();
    addEvent('tool_call', { name: 'Bash', input: { command: 'ls', timeout: 987654321, secretish: 'zzz' } });
    const res = await fetchRaw(app, `/conversations/${conversationId}/export`);
    expect(res.text).toContain('- **Tool** `Bash` — `ls`');
    expect(res.text).not.toContain('987654321');
    expect(res.text).not.toContain('zzz');
  });

  it('serves stored payload text verbatim — redaction stays redacted, no token is synthesised', async () => {
    const { app, conversationId, addEvent } = boot();
    addEvent('prompt', { text: 'Authorization: Bearer [REDACTED]' }, 'user');
    const res = await fetchRaw(app, `/conversations/${conversationId}/export`);
    expect(res.text).toContain('[REDACTED]');
    expect(res.text).not.toMatch(/Bearer [0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
