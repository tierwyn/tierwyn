import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import {
  createConversation, listConversations, getConversation, forkConversation,
  setConversationDescription,
} from './conversations.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('conversation description', () => {
  it('createConversation yields no description or source', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'First' });
    expect(c.description).toBeUndefined();
    expect(c.descriptionSource).toBeUndefined();
  });

  it('setConversationDescription writes text as operator-owned and advances updatedAt', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'First' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(c.updatedAt - 1000, c.id);

    const updated = setConversationDescription(db, c.id, 'x');
    expect(updated?.description).toBe('x');
    expect(updated?.descriptionSource).toBe('user');
    expect(getConversation(db, c.id)?.description).toBe('x');
    expect(getConversation(db, c.id)?.descriptionSource).toBe('user');
    expect(getConversation(db, c.id)!.updatedAt).toBeGreaterThan(c.updatedAt - 1000);
  });

  it('setConversationDescription(null) on a never-described row is a no-op', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'First' });

    const updated = setConversationDescription(db, c.id, null);
    expect(updated?.description).toBeUndefined();
    expect(updated?.descriptionSource).toBeUndefined();
  });

  it('setConversationDescription(null) clears text but keeps source user', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'First' });
    setConversationDescription(db, c.id, 'x');

    const cleared = setConversationDescription(db, c.id, null);
    expect(cleared?.description).toBeUndefined();
    expect(cleared?.descriptionSource).toBe('user');
    expect(getConversation(db, c.id)?.description).toBeUndefined();
    expect(getConversation(db, c.id)?.descriptionSource).toBe('user');
  });

  it('setConversationDescription on an unknown id returns undefined', () => {
    const db = freshDb();
    expect(setConversationDescription(db, 'nope', 'x')).toBeUndefined();
  });

  it('listConversations returns the description on the row', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'First' });
    setConversationDescription(db, c.id, 'listed');
    const list = listConversations(db, p.id);
    expect(list).toHaveLength(1);
    expect(list[0].description).toBe('listed');
    expect(list[0].descriptionSource).toBe('user');
  });

  it('forkConversation copies description and descriptionSource', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'Original' });
    setConversationDescription(db, c.id, 'D');

    db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)')
      .run('s1', c.id, Date.now(), Date.now());
    db.prepare("INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)")
      .run('e1', 's1', 'prompt', '{"text":"first question"}', 'user', 1, 100);

    const forked = forkConversation(db, c.id, 'e1');
    expect(forked.description).toBe('D');
    expect(forked.descriptionSource).toBe('user');
  });
});
