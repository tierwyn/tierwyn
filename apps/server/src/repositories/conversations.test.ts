import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import {
  createConversation, createScheduleHomeConversation, listConversations,
  listConversationWorkdirs, getConversation, touchConversation, forkConversation,
  markConversationViewed, markConversationsViewed,
} from './conversations.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('conversations repository', () => {
  it('creates and lists conversations under a project', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'First' });
    expect(c.projectId).toBe(p.id);
    expect(listConversations(db, p.id)).toHaveLength(1);
    expect(getConversation(db, c.id)?.title).toBe('First');
  });

  it('listConversationWorkdirs returns schedule_home workdir rows', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'nightly' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run('/tmp/wt', home.id);
    const rows = listConversationWorkdirs(db, p.id);
    expect(rows.some((r) => r.id === home.id && r.workdirPath === '/tmp/wt')).toBe(true);
  });

  it('listConversations excludes schedule_home conversations', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    createConversation(db, { projectId: p.id, title: 'normal chat' });
    createConversation(db, { projectId: p.id, title: '⏱ home', kind: 'schedule_home' });
    const list = listConversations(db, p.id);
    expect(list.map((c) => c.title)).toEqual(['normal chat']);
    expect(list.every((c) => c.kind !== 'schedule_home')).toBe(true);
  });

  it('listConversations excludes schedule run conversations and their spawn descendants', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const normal = createConversation(db, { projectId: p.id, title: 'normal chat' });
    createConversation(db, { projectId: p.id, title: 'normal spawn', parentConversationId: normal.id });
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'nightly' });
    const run = createConversation(db, {
      projectId: p.id, title: '⏱ nightly @ 2026-09-04', parentConversationId: home.id,
    });
    const child = createConversation(db, {
      projectId: p.id, title: '↳ planner', parentConversationId: run.id,
    });
    createConversation(db, {
      projectId: p.id, title: '↳ implementer', parentConversationId: child.id,
    });
    const list = listConversations(db, p.id);
    expect(list.map((c) => c.title).sort()).toEqual(['normal chat', 'normal spawn']);
  });

  it('createScheduleHomeConversation sets title and kind', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'weekday morning' });
    expect(home.title).toBe('⏱ weekday morning');
    expect(home.kind).toBe('schedule_home');
    expect(listConversations(db, p.id)).toHaveLength(0);
    expect(getConversation(db, home.id)?.kind).toBe('schedule_home');
  });

  it('touchConversation bumps updated_at', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'X' });
    touchConversation(db, c.id, c.updatedAt + 1000);
    expect(getConversation(db, c.id)!.updatedAt).toBe(c.updatedAt + 1000);
  });

  it('forks conversation up to a target event ID', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, {
      projectId: p.id,
      title: 'Original',
      templateName: 'Mixed',
      spawnWorkdir: 'worktree',
      designation: 'orchestrator',
    });

    db.prepare('INSERT INTO sessions (id,conversation_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('s1', c.id, 'native-123', Date.now(), Date.now());
    db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)').run('s2', c.id, Date.now(), Date.now());

    // Insert events with specific timestamps and sequences
    db.prepare("INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)")
      .run('e1', 's1', 'prompt', '{"text":"first question"}', 'user', 1, 100);
    db.prepare("INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)")
      .run('e2', 's1', 'message', '{"chunk":"first response"}', 'agent', 2, 110);
    db.prepare("INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)")
      .run('e3', 's2', 'prompt', '{"text":"second question"}', 'user', 1, 200);
    db.prepare("INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)")
      .run('e4', 's2', 'message', '{"chunk":"second response"}', 'agent', 2, 210);

    // Fork at the first response event ('e2')
    const forked = forkConversation(db, c.id, 'e2');
    expect(forked.title).toBe('Fork of Original');
    expect(forked.projectId).toBe(p.id);
    expect(forked.templateName).toBe('Mixed');
    expect(forked.spawnWorkdir).toBe('worktree');
    expect(forked.designation).toBe('orchestrator');

    // Check sessions and events in the new conversation
    const newSessions = db.prepare('SELECT * FROM sessions WHERE conversation_id = ?').all(forked.id) as any[];
    expect(newSessions).toHaveLength(1); // Only s1's clone should be here
    expect(newSessions[0].native_session_id).toBeNull(); // native_session_id must NOT be copied

    const newEvents = db.prepare(`
      SELECT e.* FROM events e
      JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
      ORDER BY e.ts ASC, e.seq ASC
    `).all(forked.id) as any[];

    expect(newEvents).toHaveLength(2);
    expect(JSON.parse(newEvents[0].payload).text).toBe('first question');
    expect(JSON.parse(newEvents[1].payload).chunk).toBe('first response');
  });

  it('marks specific or all conversations as viewed', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c1 = createConversation(db, { projectId: p.id, title: 'C1' });
    const c2 = createConversation(db, { projectId: p.id, title: 'C2' });
    const c3 = createConversation(db, { projectId: p.id, title: 'C3' });

    markConversationViewed(db, c1.id, 500);
    const row1 = db.prepare('SELECT last_viewed_at FROM conversations WHERE id = ?').get(c1.id) as { last_viewed_at: number };
    expect(row1.last_viewed_at).toBe(500);

    markConversationsViewed(db, [c2.id], 1000);
    const row2 = db.prepare('SELECT last_viewed_at FROM conversations WHERE id = ?').get(c2.id) as { last_viewed_at: number };
    expect(row2.last_viewed_at).toBe(1000);

    markConversationsViewed(db, undefined, 2000);
    const all = db.prepare('SELECT last_viewed_at FROM conversations').all() as { last_viewed_at: number }[];
    expect(all.every((r) => r.last_viewed_at === 2000)).toBe(true);
  });
});
