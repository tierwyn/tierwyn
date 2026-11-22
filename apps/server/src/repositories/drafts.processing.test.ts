import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import {
  getDraft,
  upsertDraft,
  appendDraft,
  beginProcessing,
  endProcessing,
  effectiveProcessing,
  undoEnhance,
  PROCESSING_STALE_MS,
} from './drafts.js';

let db: Database;
let conversationId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  conversationId = createConversation(db, { projectId, title: 'c' }).id;
});

describe('draft processing lock', () => {
  it('beginProcessing on a conversation with no draft row creates it', () => {
    expect(getDraft(db, conversationId)).toBeNull();
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-1')).toBe(true);
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('');
    expect(row.processing).toBe('enhancing');
    expect(row.processingId).toBe('job-1');
    expect(row.processingStartedAt).toEqual(expect.any(Number));
  });

  it('beginProcessing twice with different jobIds rejects the second', () => {
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-a')).toBe(true);
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-b')).toBe(false);
    expect(getDraft(db, conversationId)!.processingId).toBe('job-a');
  });

  it('beginProcessing with stashPreText snapshots current text', () => {
    upsertDraft(db, conversationId, 'original draft');
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-1', { stashPreText: true })).toBe(true);
    expect(getDraft(db, conversationId)!.preText).toBe('original draft');
  });

  it('beginProcessing steals a lock older than PROCESSING_STALE_MS', () => {
    expect(beginProcessing(db, conversationId, 'enhancing', 'old-job')).toBe(true);
    db.prepare('UPDATE draft_prompts SET processing_started_at = ? WHERE conversation_id = ?')
      .run(Date.now() - PROCESSING_STALE_MS - 1, conversationId);
    expect(beginProcessing(db, conversationId, 'transcribing', 'new-job')).toBe(true);
    expect(getDraft(db, conversationId)!.processingId).toBe('new-job');
    expect(getDraft(db, conversationId)!.processing).toBe('transcribing');
  });

  it('effectiveProcessing on a lock older than TTL returns idle', () => {
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-1')).toBe(true);
    const row = getDraft(db, conversationId)!;
    expect(effectiveProcessing(row)).toBe('enhancing');
    expect(effectiveProcessing(row, (row.processingStartedAt ?? 0) + PROCESSING_STALE_MS + 1)).toBe('idle');
  });

  it('endProcessing with the owning jobId writes text and clears the lock', () => {
    upsertDraft(db, conversationId, 'before');
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-1', { stashPreText: true })).toBe(true);
    expect(endProcessing(db, conversationId, 'job-1', { text: 'after' })).toBe(true);
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('after');
    expect(row.processing).toBe('');
    expect(row.processingId).toBeNull();
    expect(row.processingStartedAt).toBeNull();
    expect(row.preText).toBe('before');
    expect(effectiveProcessing(row)).toBe('idle');
  });

  it('endProcessing without text (failed job) clears the pre_text stash', () => {
    upsertDraft(db, conversationId, 'before');
    expect(beginProcessing(db, conversationId, 'enhancing', 'job-1', { stashPreText: true })).toBe(true);
    expect(endProcessing(db, conversationId, 'job-1')).toBe(true);
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('before');
    expect(row.preText).toBeNull();
    expect(effectiveProcessing(row)).toBe('idle');
  });

  it('endProcessing with a foreign jobId leaves lock and text untouched', () => {
    upsertDraft(db, conversationId, 'before');
    expect(beginProcessing(db, conversationId, 'enhancing', 'owner', { stashPreText: true })).toBe(true);
    expect(endProcessing(db, conversationId, 'intruder', { text: 'stolen' })).toBe(false);
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('before');
    expect(row.processingId).toBe('owner');
    expect(row.processing).toBe('enhancing');
  });

  it('upsertDraft after a stash clears pre_text', () => {
    upsertDraft(db, conversationId, 'original');
    beginProcessing(db, conversationId, 'enhancing', 'job-1', { stashPreText: true });
    endProcessing(db, conversationId, 'job-1', { text: 'enhanced' });
    expect(getDraft(db, conversationId)!.preText).toBe('original');
    upsertDraft(db, conversationId, 'user edit');
    expect(getDraft(db, conversationId)!.preText).toBeNull();
  });

  it('appendDraft after a stash preserves pre_text', () => {
    upsertDraft(db, conversationId, 'original');
    beginProcessing(db, conversationId, 'enhancing', 'job-1', { stashPreText: true });
    endProcessing(db, conversationId, 'job-1', { text: 'enhanced' });
    appendDraft(db, conversationId, 'chunk');
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('enhanced chunk');
    expect(row.preText).toBe('original');
  });

  it('undoEnhance with a stash restores text and clears pre_text', () => {
    upsertDraft(db, conversationId, 'original');
    beginProcessing(db, conversationId, 'enhancing', 'job-1', { stashPreText: true });
    endProcessing(db, conversationId, 'job-1', { text: 'enhanced' });
    const restored = undoEnhance(db, conversationId);
    expect(restored?.text).toBe('original');
    const row = getDraft(db, conversationId)!;
    expect(row.text).toBe('original');
    expect(row.preText).toBeNull();
  });

  it('undoEnhance with no stash returns null', () => {
    upsertDraft(db, conversationId, 'plain');
    expect(undoEnhance(db, conversationId)).toBeNull();
    expect(getDraft(db, conversationId)!.text).toBe('plain');
  });
});
