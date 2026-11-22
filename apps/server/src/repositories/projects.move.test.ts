import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, getProject, moveProjectRoot } from './projects.js';
import { createConversation } from './conversations.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('moveProjectRoot', () => {
  it('updates root_path and returns the updated project', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Tierwyn', rootPath: '/home/u/Projects/Tierwyn' });

    const updated = moveProjectRoot(db, p.id, '/home/u/Projects/Tierwyn', '/home/u/New/Tierwyn');
    expect(updated).toBeDefined();
    expect(updated?.rootPath).toBe('/home/u/New/Tierwyn');
    expect(getProject(db, p.id)?.rootPath).toBe('/home/u/New/Tierwyn');
  });

  it('rewrites conversation workdir_path under from, leaving sibling prefixes untouched', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'App', rootPath: '/r/app' });

    const c1 = createConversation(db, { projectId: p.id, title: 'c1' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/r/app/sub', c1.id);

    const c2 = createConversation(db, { projectId: p.id, title: 'c2' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/r/app-spawn-1', c2.id);

    const c3 = createConversation(db, { projectId: p.id, title: 'c3' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/r/apple', c3.id);

    const c4 = createConversation(db, { projectId: p.id, title: 'c4' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/r/app', c4.id);

    moveProjectRoot(db, p.id, '/r/app', '/r/target');

    const getCwd = (id: string) =>
      db.prepare('SELECT workdir_path FROM conversations WHERE id = ?').pluck().get(id) as string;

    expect(getCwd(c1.id)).toBe('/r/target/sub');
    expect(getCwd(c2.id)).toBe('/r/app-spawn-1');
    expect(getCwd(c3.id)).toBe('/r/apple');
    expect(getCwd(c4.id)).toBe('/r/target');
  });

  it('treats _ in path as literal, not SQL LIKE wildcard', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Under', rootPath: '/r/a_b' });

    const c1 = createConversation(db, { projectId: p.id, title: 'c1' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/r/a_b/nested', c1.id);

    const c2 = createConversation(db, { projectId: p.id, title: 'c2' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/r/aXb/x', c2.id);

    moveProjectRoot(db, p.id, '/r/a_b', '/r/new_ab');

    const getCwd = (id: string) =>
      db.prepare('SELECT workdir_path FROM conversations WHERE id = ?').pluck().get(id) as string;

    expect(getCwd(c1.id)).toBe('/r/new_ab/nested');
    expect(getCwd(c2.id)).toBe('/r/aXb/x');
  });

  it('rewrites git_commit_drafts keys for local and remote projects', () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare("INSERT INTO remote_hosts (id, name, status, created_at, updated_at) VALUES (?, ?, 'trusted', ?, ?)")
      .run('H1', 'host1', now, now);
    db.prepare("INSERT INTO remote_hosts (id, name, status, created_at, updated_at) VALUES (?, ?, 'trusted', ?, ?)")
      .run('H2', 'host2', now, now);

    const local = createProject(db, { name: 'Local', rootPath: '/r/local' });
    const remote = createProject(db, { name: 'Remote', rootPath: '/r/remote', remoteHostId: 'H1' });
    db.prepare('INSERT INTO git_commit_drafts (cwd, message, updated_at) VALUES (?, ?, ?)')
      .run('/r/local', 'local root draft', now);
    db.prepare('INSERT INTO git_commit_drafts (cwd, message, updated_at) VALUES (?, ?, ?)')
      .run('/r/local/sub', 'local sub draft', now);
    db.prepare('INSERT INTO git_commit_drafts (cwd, message, updated_at) VALUES (?, ?, ?)')
      .run('remote:H1:/r/remote/x', 'remote draft', now);
    db.prepare('INSERT INTO git_commit_drafts (cwd, message, updated_at) VALUES (?, ?, ?)')
      .run('remote:H2:/r/remote/x', 'other host draft', now);

    moveProjectRoot(db, local.id, '/r/local', '/r/new_local');
    moveProjectRoot(db, remote.id, '/r/remote', '/r/new_remote');

    const rows = db.prepare('SELECT cwd, message FROM git_commit_drafts ORDER BY cwd ASC').all() as Array<{ cwd: string; message: string }>;
    const map = new Map(rows.map(r => [r.cwd, r.message]));

    expect(map.get('/r/new_local')).toBe('local root draft');
    expect(map.get('/r/new_local/sub')).toBe('local sub draft');
    expect(map.get('/r/local')).toBeUndefined();
    expect(map.get('remote:H1:/r/new_remote/x')).toBe('remote draft');
    expect(map.get('remote:H2:/r/remote/x')).toBe('other host draft');
  });

  it('throws and rolls back when from does not match current root_path', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Test', rootPath: '/r/actual' });

    expect(() => moveProjectRoot(db, p.id, '/r/stale', '/r/new'))
      .toThrow('root_path changed concurrently');

    expect(getProject(db, p.id)?.rootPath).toBe('/r/actual');
  });
});
