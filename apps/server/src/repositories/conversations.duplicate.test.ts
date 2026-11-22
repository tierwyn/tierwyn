import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import {
  createConversation, createScheduleHomeConversation, getConversation,
  duplicateConversation, ConversationNotFound,
} from './conversations.js';
import { appendEvent, listEventsForConversation } from './events.js';
import { upsertDraft, getDraft } from './drafts.js';

/** In-memory DB, two projects, and a source conversation with a mixed transcript. */
function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const projectA = createProject(db, { name: 'A', rootPath: '/a' });
  const projectB = createProject(db, { name: 'B', rootPath: '/b' });
  const source = createConversation(db, { projectId: projectA.id, title: 'Source chat' });

  const sessionId = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, agent_model_id, native_session_id, created_at, updated_at)
     VALUES (?,?,NULL,NULL,'native-abc',?,?)`,
  ).run(sessionId, source.id, now, now);

  let seq = 0;
  const add = (type: string, payload: unknown, sender: 'user' | 'agent' | 'system' = 'agent') => {
    seq += 1;
    return appendEvent(db, { sessionId, type, payload, sender, seq, ts: now + seq });
  };

  add('prompt', { text: 'first question' }, 'user');
  add('tool_call', { name: 'Read', toolUseId: 't1' });
  add('tool_result', { toolUseId: 't1', output: 'file body' });
  add('message', { chunk: 'first answer', final: 1 });
  add('status', { status: 'done' }, 'system');
  add('prompt', { text: 'second question' }, 'user');
  add('message', { chunk: 'second answer', final: 1 });

  return { db, projectA: projectA.id, projectB: projectB.id, source, sessionId };
}

const typesOf = (db: Database.Database, convId: string) =>
  listEventsForConversation(db, convId).map((e) => e.type);

describe('duplicateConversation', () => {
  it('copies only prompt and message events by default, in order', () => {
    const { db, source } = boot();
    const copy = duplicateConversation(db, source.id);
    expect(typesOf(db, copy.id)).toEqual(['prompt', 'message', 'prompt', 'message']);
    const texts = listEventsForConversation(db, copy.id)
      .map((e) => (e.payload as { text?: string; chunk?: string }).text
        ?? (e.payload as { chunk?: string }).chunk);
    expect(texts).toEqual(['first question', 'first answer', 'second question', 'second answer']);
  });

  it('includes tool and file/error events when includeTools is true, still excluding status', () => {
    const { db, source } = boot();
    const copy = duplicateConversation(db, source.id, { includeTools: true });
    expect(typesOf(db, copy.id))
      .toEqual(['prompt', 'tool_call', 'tool_result', 'message', 'prompt', 'message']);
    expect(typesOf(db, copy.id)).not.toContain('status');
  });

  it('mints fresh ids for the conversation and every event, leaving the source untouched', () => {
    const { db, source } = boot();
    const sourceEventIdsBefore = listEventsForConversation(db, source.id).map((e) => e.id);
    const copy = duplicateConversation(db, source.id);

    expect(copy.id).not.toBe(source.id);
    const copyEventIds = listEventsForConversation(db, copy.id).map((e) => e.id);
    expect(copyEventIds).toHaveLength(4);
    expect(new Set(copyEventIds).size).toBe(4);
    for (const id of copyEventIds) expect(sourceEventIdsBefore).not.toContain(id);

    // Source transcript is byte-for-byte unchanged.
    expect(listEventsForConversation(db, source.id).map((e) => e.id))
      .toEqual(sourceEventIdsBefore);
  });

  it('creates exactly one stub session with a NULL native_session_id and no spawn edges', () => {
    const { db, source } = boot();
    const copy = duplicateConversation(db, source.id);
    const sessions = db.prepare('SELECT * FROM sessions WHERE conversation_id = ?')
      .all(copy.id) as { id: string; agent_id: string | null; agent_model_id: string | null; native_session_id: string | null }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].native_session_id).toBeNull();
    expect(sessions[0].agent_id).toBeNull();
    expect(sessions[0].agent_model_id).toBeNull();

    const edges = db.prepare(
      'SELECT COUNT(*) AS n FROM spawn_edges WHERE child_conversation_id = ? OR parent_conversation_id = ?',
    ).get(copy.id, copy.id) as { n: number };
    expect(edges.n).toBe(0);
  });

  it('creates no session at all when the source has no copyable events', () => {
    const { db, projectA } = boot();
    const empty = createConversation(db, { projectId: projectA, title: 'Empty' });
    const copy = duplicateConversation(db, empty.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE conversation_id = ?').get(copy.id))
      .toEqual({ n: 0 });
    expect(listEventsForConversation(db, copy.id)).toEqual([]);
  });

  it('does not copy the source draft', () => {
    const { db, source } = boot();
    upsertDraft(db, source.id, 'half-typed prompt');
    const copy = duplicateConversation(db, source.id);
    expect(getDraft(db, copy.id)).toBeNull();
    expect(getDraft(db, source.id)?.text).toBe('half-typed prompt');
  });

  it('throws ConversationNotFound for an unknown source id', () => {
    const { db } = boot();
    expect(() => duplicateConversation(db, 'nope')).toThrow(ConversationNotFound);
  });

  it('places the copy in the target project when projectId is given', () => {
    const { db, source, projectA, projectB } = boot();
    const copy = duplicateConversation(db, source.id, { projectId: projectB });
    expect(copy.projectId).toBe(projectB);
    expect(getConversation(db, source.id)?.projectId).toBe(projectA);
  });

  it('defaults to the source project when projectId is omitted', () => {
    const { db, source, projectA } = boot();
    expect(duplicateConversation(db, source.id).projectId).toBe(projectA);
  });

  it('produces a root chat when duplicating a spawn child', () => {
    const { db, source, projectA } = boot();
    const child = createConversation(db, {
      projectId: projectA, title: 'delegate', parentConversationId: source.id,
    });
    const copy = duplicateConversation(db, child.id);
    expect(copy.parentConversationId).toBeUndefined();
    expect(copy.kind).toBe('chat');
  });

  it('produces a root chat when duplicating a schedule run chat', () => {
    const { db, projectA } = boot();
    const home = createScheduleHomeConversation(db, { projectId: projectA, jobName: 'nightly' });
    const run = createConversation(db, {
      projectId: projectA, title: 'run 1', parentConversationId: home.id,
    });
    const copy = duplicateConversation(db, run.id);
    expect(copy.parentConversationId).toBeUndefined();
    expect(copy.kind).toBe('chat');
  });

  it('carries tags, description, descriptionSource, templateName and spawnWorkdir onto the copy', () => {
    const { db, source } = boot();
    db.prepare(
      `UPDATE conversations
          SET tags = ?, description = ?, description_source = ?,
              template_name = ?, spawn_workdir = ?, workdir_path = ?, pinned = 1
        WHERE id = ?`,
    ).run(
      JSON.stringify(['alpha', 'beta']), 'a one-line summary', 'user',
      'Review template', 'worktree', '/tmp/wd', source.id,
    );
    const copy = duplicateConversation(db, source.id);
    expect(copy.tags).toEqual(['alpha', 'beta']);
    expect(copy.description).toBe('a one-line summary');
    expect(copy.descriptionSource).toBe('user');
    expect(copy.templateName).toBe('Review template');
    expect(copy.spawnWorkdir).toBe('worktree');
    expect(copy.workdirPath).toBe('/tmp/wd');
  });

  it('carries capability_profile onto the copy so forks stay scoped', () => {
    const { db, source } = boot();
    db.prepare('UPDATE conversations SET capability_profile = ? WHERE id = ?').run('media', source.id);
    const copy = duplicateConversation(db, source.id);
    expect(copy.capabilityProfile).toBe('media');
    expect(getConversation(db, source.id)?.capabilityProfile).toBe('media');
  });

  it('does not copy pinned or scheduleJobId', () => {
    const { db, source } = boot();
    db.prepare('UPDATE conversations SET pinned = 1, schedule_job_id = ? WHERE id = ?')
      .run('job-1', source.id);
    const copy = duplicateConversation(db, source.id);
    expect(copy.pinned).toBeUndefined();
    expect(copy.scheduleJobId).toBeUndefined();
  });

  it('titles the copy "Copy of <source title>" by default and honours an explicit title', () => {
    const { db, source } = boot();
    expect(duplicateConversation(db, source.id).title).toBe('Copy of Source chat');
    expect(duplicateConversation(db, source.id, { title: '  Retry on Opus  ' }).title)
      .toBe('Retry on Opus');
    expect(duplicateConversation(db, source.id, { title: '   ' }).title).toBe('Copy of Source chat');
  });

  it('indexes the copied prompts in event_fts so sidebar content search finds them', () => {
    const { db, source } = boot();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM event_fts WHERE event_fts MATCH ?')
      .get('question') as { n: number }).n;
    duplicateConversation(db, source.id);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM event_fts WHERE event_fts MATCH ?')
      .get('question') as { n: number }).n;
    expect(after).toBe(before + 2);
  });

  it('copies rules and rulePresetIds', () => {
    const { db, source } = boot();
    db.prepare('UPDATE conversations SET rules = ?, rule_preset_ids = ? WHERE id = ?')
      .run('copied-rules', JSON.stringify(['preset-1']), source.id);
    const copy = duplicateConversation(db, source.id);
    expect(copy.rules).toBe('copied-rules');
    expect(copy.rulePresetIds).toEqual(['preset-1']);
  });
});
