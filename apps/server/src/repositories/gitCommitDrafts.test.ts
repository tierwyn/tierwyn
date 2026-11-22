import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  getCommitDraft,
  setCommitDraft,
  clearCommitDraft,
  beginCommitGeneration,
  cancelCommitGeneration,
  endCommitGeneration,
  COMMIT_GENERATION_STALE_MS,
} from './gitCommitDrafts.js';

let db: Database;
const cwd = '/tmp/repo';

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
});

describe('gitCommitDrafts', () => {
  it('getCommitDraft on an unknown cwd returns empty idle draft', () => {
    expect(getCommitDraft(db, cwd)).toEqual({ message: '', generating: false });
  });

  it('setCommitDraft upserts and bumps updatedAt on replace', () => {
    const t1 = setCommitDraft(db, cwd, 'first');
    expect(getCommitDraft(db, cwd)).toEqual({ message: 'first', generating: false });
    const row1 = db.prepare('SELECT updated_at AS updatedAt FROM git_commit_drafts WHERE cwd = ?')
      .get(cwd) as { updatedAt: number };
    expect(row1.updatedAt).toBe(t1);

    const t2 = setCommitDraft(db, cwd, 'second');
    expect(t2).toBeGreaterThanOrEqual(t1);
    expect(getCommitDraft(db, cwd)).toEqual({ message: 'second', generating: false });
    const row2 = db.prepare('SELECT updated_at AS updatedAt FROM git_commit_drafts WHERE cwd = ?')
      .get(cwd) as { updatedAt: number };
    expect(row2.updatedAt).toBe(t2);
  });

  it('beginCommitGeneration returns true on a fresh/absent row and creates it', () => {
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    expect(getCommitDraft(db, cwd)).toEqual({ message: '', generating: true });
  });

  it('beginCommitGeneration returns false while a live lock is held', () => {
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    expect(beginCommitGeneration(db, cwd)).toBe(false);
    expect(getCommitDraft(db, cwd).generating).toBe(true);
  });

  it('stale lock reads as idle and beginCommitGeneration reclaims it', () => {
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    const startedAt = Date.now() - COMMIT_GENERATION_STALE_MS - 1;
    db.prepare('UPDATE git_commit_drafts SET generating_started_at = ? WHERE cwd = ?')
      .run(startedAt, cwd);

    expect(getCommitDraft(db, cwd, startedAt + COMMIT_GENERATION_STALE_MS + 1))
      .toEqual({ message: '', generating: false });
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    expect(getCommitDraft(db, cwd).generating).toBe(true);
  });

  it('endCommitGeneration with message clears lock and writes message', () => {
    setCommitDraft(db, cwd, 'before');
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    expect(endCommitGeneration(db, cwd, 'feat: done')).toBe(true);
    expect(getCommitDraft(db, cwd)).toEqual({ message: 'feat: done', generating: false });
  });

  it('endCommitGeneration without message clears lock and keeps previous text', () => {
    setCommitDraft(db, cwd, 'keep me');
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    expect(endCommitGeneration(db, cwd)).toBe(true);
    expect(getCommitDraft(db, cwd)).toEqual({ message: 'keep me', generating: false });
  });

  it('endCommitGeneration returns false when the row was cleared', () => {
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    clearCommitDraft(db, cwd);
    expect(endCommitGeneration(db, cwd, 'orphaned')).toBe(false);
    expect(getCommitDraft(db, cwd)).toEqual({ message: '', generating: false });
  });

  it('clearCommitDraft removes the row; calling twice is a no-op', () => {
    setCommitDraft(db, cwd, 'gone');
    clearCommitDraft(db, cwd);
    expect(getCommitDraft(db, cwd)).toEqual({ message: '', generating: false });
    clearCommitDraft(db, cwd);
    expect(getCommitDraft(db, cwd)).toEqual({ message: '', generating: false });
  });

  it('cancelCommitGeneration clears generating lock and preserves existing message', () => {
    setCommitDraft(db, cwd, 'preserve my draft');
    expect(beginCommitGeneration(db, cwd)).toBe(true);
    expect(getCommitDraft(db, cwd).generating).toBe(true);
    expect(cancelCommitGeneration(db, cwd)).toBe(true);
    expect(getCommitDraft(db, cwd)).toEqual({ message: 'preserve my draft', generating: false });
  });

  it('endCommitGeneration with expectedStartedAt rejects stale or cancelled generation', () => {
    const t0 = 1000;
    expect(beginCommitGeneration(db, cwd, t0)).toBe(true);
    // Cancel clears the generating lock and startedAt
    expect(cancelCommitGeneration(db, cwd)).toBe(true);
    // Late worker arrives with t0
    expect(endCommitGeneration(db, cwd, 'too late', t0)).toBe(false);
    expect(getCommitDraft(db, cwd)).toEqual({ message: '', generating: false });
  });
});

