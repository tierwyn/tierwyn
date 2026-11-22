import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createConversation, renameConversation, deleteConversation, getConversation } from './conversations.js';
import { createProject, deleteProject } from './projects.js';

function seeded() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  db.prepare('INSERT INTO projects (id,name,root_path,created_at) VALUES (?,?,?,?)').run('p', 'p', '/tmp', Date.now());
  return db;
}

describe('conversation rename/delete', () => {
  it('renames the title and bumps updated_at', () => {
    const db = seeded();
    const c = createConversation(db, { projectId: 'p', title: 'old' });
    const renamed = renameConversation(db, c.id, 'new');
    expect(renamed?.title).toBe('new');
    expect(getConversation(db, c.id)?.title).toBe('new');
  });

  it('deletes the conversation and cascades to sessions + events', () => {
    const db = seeded();
    const c = createConversation(db, { projectId: 'p', title: 't' });
    db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)').run('s', c.id, Date.now(), Date.now());
    db.prepare("INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)").run('e', 's', 'message', '{}', 'agent', 1, Date.now());

    const result = deleteConversation(db, c.id);
    expect(result.ok).toBe(true);
    expect(result.nativeSessions).toEqual([]);
    expect(getConversation(db, c.id)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) c FROM sessions WHERE id='s'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM events WHERE id='e'").get() as { c: number }).c).toBe(0);
  });

  it('returns false when deleting a non-existent conversation', () => {
    const db = seeded();
    expect(deleteConversation(db, 'nope').ok).toBe(false);
  });

  // v1.5: deleteConversation must capture (agentId, nativeSessionId) pairs BEFORE
  // the cascade deletes the sessions rows, so the route can best-effort unlink
  // each native file post-commit.
  it('captures native session descriptors before cascading', () => {
    const db = seeded();
    // The seeded() helper doesn't run seedCatalogue, so insert synthetic agent
    // rows to satisfy sessions.agent_id FK.
    for (const a of ['claude-code', 'hermes', 'pi']) {
      db.prepare(`INSERT INTO agents (id,type,label,description,env_vars,created_at) VALUES (?,?,?,?,?,?)`).run(a, a, a, '', '{}', Date.now());
    }
    const c = createConversation(db, { projectId: 'p', title: 't' });
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s1', c.id, 'claude-code', 'native-abc', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s2', c.id, 'hermes', 'native-def', Date.now(), Date.now());
    // A session with no native_session_id must NOT appear in the capture.
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s3', c.id, 'pi', null, Date.now(), Date.now());

    const result = deleteConversation(db, c.id);
    expect(result.ok).toBe(true);
    expect(result.nativeSessions).toContainEqual({ agentId: 'claude-code', nativeSessionId: 'native-abc', projectId: 'p' });
    expect(result.nativeSessions).toContainEqual({ agentId: 'hermes', nativeSessionId: 'native-def', projectId: 'p' });
    expect(result.nativeSessions).toHaveLength(2);
  });

  // P2c: the route must know WHICH project each native session belonged to, so
  // createAdapterFor can route the unlink to the right host. Subtree children
  // (spawn/BTW) must be captured too, not just the root conversation.
  it('captures projectId per native row, including subtree children', () => {
    const db = seeded();
    for (const a of ['claude-code', 'pi']) {
      db.prepare(`INSERT INTO agents (id,type,label,description,env_vars,created_at) VALUES (?,?,?,?,?,?)`).run(a, a, a, '', '{}', Date.now());
    }
    const parent = createConversation(db, { projectId: 'p', title: 'parent' });
    const child = createConversation(db, {
      projectId: 'p', title: 'child', parentConversationId: parent.id,
    });
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s1', parent.id, 'claude-code', 'native-abc', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s2', child.id, 'pi', 'native-def', Date.now(), Date.now());

    const result = deleteConversation(db, parent.id);
    expect(result.ok).toBe(true);
    expect(result.nativeSessions).toContainEqual({ agentId: 'claude-code', nativeSessionId: 'native-abc', projectId: 'p' });
    expect(result.nativeSessions).toContainEqual({ agentId: 'pi', nativeSessionId: 'native-def', projectId: 'p' });
  });

  it('returns an empty nativeSessions array when deleting a non-existent conversation', () => {
    const db = seeded();
    const result = deleteConversation(db, 'nope');
    expect(result.ok).toBe(false);
    expect(result.nativeSessions).toEqual([]);
  });

  // Regression: spawn_requests.parent_conversation_id had no ON DELETE clause
  // in the original schema (migration 025). deleteConversation must clear
  // spawn_requests explicitly or the conversation DELETE FK-fails.
  it('deletes a conversation that has spawn_requests history without FK-failing', () => {
    const db = seeded();
    const parent = createConversation(db, { projectId: 'p', title: 'parent' });
    const child = createConversation(db, {
      projectId: 'p', title: 'child', parentConversationId: parent.id,
    });
    db.prepare(
      `INSERT INTO spawn_requests
         (id, parent_conversation_id, parent_session_id, role, prompt,
          status, child_conversation_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run('sr1', parent.id, 'sess-parent', 'investigator', 'do thing', 'dispatched', child.id, Date.now());

    const ok = deleteConversation(db, parent.id);
    expect(ok.ok).toBe(true);
    expect(getConversation(db, parent.id)).toBeUndefined();
    // The spawn_request pointing at the deleted parent must be gone.
    expect((db.prepare("SELECT COUNT(*) c FROM spawn_requests WHERE id='sr1'").get() as { c: number }).c).toBe(0);
    // Cascade: spawn subtree (child) is deleted with the parent.
    expect(getConversation(db, child.id)).toBeUndefined();
    expect(ok.deletedIds).toEqual(expect.arrayContaining([parent.id, child.id]));
  });

  it('deleteProject removes the project, its conversations, and spawn history', () => {
    const db = seeded();
    const proj = createProject(db, { name: 'ToDelete', rootPath: '/tmp/to-delete' });
    const c1 = createConversation(db, { projectId: proj.id, title: 'c1' });
    const c2 = createConversation(db, { projectId: proj.id, title: 'c2' });
    db.prepare(
      `INSERT INTO spawn_requests
         (id, parent_conversation_id, parent_session_id, prompt, status, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run('sr-p', c1.id, 'sess-1', 'x', 'pending', Date.now());

    const result = deleteProject(db, proj.id);
    expect(result.ok).toBe(true);
    expect(getConversation(db, c1.id)).toBeUndefined();
    expect(getConversation(db, c2.id)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) c FROM spawn_requests WHERE parent_conversation_id IN (SELECT id FROM conversations WHERE project_id=?)").get(proj.id) as { c: number }).c).toBe(0);
    // Second delete returns false — already gone.
    expect(deleteProject(db, proj.id).ok).toBe(false);
  });
});
