import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation, deleteConversation } from './conversations.js';
import { getDraft, upsertDraft, deleteDraft, appendDraft } from './drafts.js';

let db: Database;
let conversationId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  conversationId = createConversation(db, { projectId, title: 'c' }).id;
});

describe('drafts repository', () => {
  it('upserts, updates in place, and deletes', () => {
    expect(getDraft(db, conversationId)).toBeNull();

    const t1 = upsertDraft(db, conversationId, 'hello');
    expect(getDraft(db, conversationId)).toMatchObject({ text: 'hello', attachments: '[]', updatedAt: t1 });

    const t2 = upsertDraft(db, conversationId, 'world');
    expect(getDraft(db, conversationId)).toMatchObject({ text: 'world', attachments: '[]', updatedAt: t2 });
    const count = db.prepare(
      'SELECT count(*) AS n FROM draft_prompts WHERE conversation_id = ?',
    ).get(conversationId) as { n: number };
    expect(count.n).toBe(1);

    deleteDraft(db, conversationId);
    expect(getDraft(db, conversationId)).toBeNull();
  });

  it('is removed when conversation is deleted', () => {
    upsertDraft(db, conversationId, 'bye');
    deleteConversation(db, conversationId);
    const count = db.prepare(
      'SELECT count(*) AS n FROM draft_prompts WHERE conversation_id = ?',
    ).get(conversationId) as { n: number };
    expect(count.n).toBe(0);
  });

  it('appendDraft creates, appends with space, and skips leading space on empty', () => {
    appendDraft(db, conversationId, 'hello');
    expect(getDraft(db, conversationId)!.text).toBe('hello');

    appendDraft(db, conversationId, 'world');
    expect(getDraft(db, conversationId)!.text).toBe('hello world');

    upsertDraft(db, conversationId, '');
    appendDraft(db, conversationId, 'x');
    expect(getDraft(db, conversationId)!.text).toBe('x');

    const count = db.prepare(
      'SELECT count(*) AS n FROM draft_prompts WHERE conversation_id = ?',
    ).get(conversationId) as { n: number };
    expect(count.n).toBe(1);
  });

  it('upsertDraft writes and getDraft reads attachments JSON', () => {
    const json = JSON.stringify([{ base64: 'aGVsbG8=', mediaType: 'image/png', name: 't.png' }]);
    upsertDraft(db, conversationId, 'with pic', json);
    expect(getDraft(db, conversationId)!.attachments).toBe(json);
  });

  it('appendDraft on existing row with attachments leaves attachments intact', () => {
    const json = JSON.stringify([{ base64: 'aQ==', mediaType: 'image/png' }]);
    upsertDraft(db, conversationId, 'hello', json);
    appendDraft(db, conversationId, 'world');
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('hello world');
    expect(row.attachments).toBe(json);
  });

  it('appendDraft on new row yields empty attachments', () => {
    appendDraft(db, conversationId, 'dictated');
    expect(getDraft(db, conversationId)).toMatchObject({ text: 'dictated', attachments: '[]' });
  });

  it('persists profileId on upsertDraft and setDraftProfile', () => {
    upsertDraft(db, conversationId, 'test text', '[]', 'claude-code:opus-4.8');
    expect(getDraft(db, conversationId)!.profileId).toBe('claude-code:opus-4.8');

    // Text update without specifying profileId preserves existing profileId
    upsertDraft(db, conversationId, 'updated text');
    expect(getDraft(db, conversationId)!.profileId).toBe('claude-code:opus-4.8');
    expect(getDraft(db, conversationId)!.text).toBe('updated text');
  });
});
