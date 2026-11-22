import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { parseMemoryId } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import {
  saveMemory,
  getMemory,
  searchVisibleMemories,
  scoreProjectMemories,
  ftsRowCount,
  extractRecallKeywords,
  supersedeMemory,
  listMemories,
  countMemories,
  deleteMemory,
  activateMemory,
  resolveSuggestion,
  flagMemory,
  type SaveInput,
} from './memories.js';

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function setup() {
  const db = fresh();
  const project = createProject(db, { name: 'P', rootPath: '/tmp/p' });
  const other = createProject(db, { name: 'Q', rootPath: '/tmp/q' });
  const conv = createConversation(db, { projectId: project.id, title: 'T' });
  const now = 1_730_000_000_000;
  const base = (over: Partial<SaveInput> = {}): SaveInput => ({
    projectId: project.id,
    kind: 'gotcha',
    text: 'alpha routes behind web',
    agent: 'claude-code',
    conversationId: conv.id,
    now,
    ...over,
  });
  return { db, project, other, conv, now, base };
}

describe('memories repository', () => {
  it('project delete cascades to memories and the FTS index', () => {
    const db = fresh();
    const project = createProject(db, { name: 'A', rootPath: '/tmp/a' });
    saveMemory(db, {
      projectId: project.id, kind: 'fact', text: 'alpha routes',
      agent: null, conversationId: null, now: 1,
    });
    expect(ftsRowCount(db)).toBe(1);
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    expect(db.prepare('SELECT count(*) c FROM memories').get()).toEqual({ c: 0 });
    expect(ftsRowCount(db)).toBe(0);
  });

  it('conversation delete leaves the memory, provenance id intact, title null', () => {
    const { db, base, conv } = setup();
    const { memory } = saveMemory(db, base({ conversationId: conv.id }));
    expect(memory.createdByConversationTitle).toBe('T');
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    const after = getMemory(db, parseMemoryId(memory.id)!)!;
    expect(after.createdByConversation).toBe(conv.id);
    expect(after.createdByConversationTitle).toBeNull();
  });

  it('ids are not reused after delete', () => {
    const { db, base } = setup();
    const a = saveMemory(db, base({})).memory;
    deleteMemory(db, parseMemoryId(a.id)!);
    expect(saveMemory(db, base({})).memory.id).not.toBe(a.id);
  });

  it('searchVisibleMemories excludes flagged, superseded, promoted, other projects', () => {
    const { db, base, project, other } = setup();
    const active = saveMemory(db, base({ text: 'visible alpha widget' })).memory;
    const flagged = saveMemory(db, base({ text: 'flagged alpha widget' })).memory;
    const superseded = saveMemory(db, base({ text: 'superseded alpha widget' })).memory;
    const promoted = saveMemory(db, base({ text: 'promoted alpha widget', suggestRule: true })).memory;
    saveMemory(db, base({ projectId: other.id, text: 'other alpha widget' }));

    flagMemory(db, parseMemoryId(flagged.id)!, 'task_chatter');
    const replacement = saveMemory(db, base({ text: 'replacement alpha widget' })).memory;
    expect(supersedeMemory(db, project.id, parseMemoryId(superseded.id)!, parseMemoryId(replacement.id)!)).toBe('ok');
    expect(resolveSuggestion(db, parseMemoryId(promoted.id)!, 'promoted')).toBe(true);

    const rows = searchVisibleMemories(db, project.id, ['alpha', 'widget'], 20);
    const ids = rows.map((r) => `m_${r.id}`);
    expect(ids).toContain(active.id);
    expect(ids).toContain(replacement.id);
    expect(ids).not.toContain(flagged.id);
    expect(ids).not.toContain(superseded.id);
    expect(ids).not.toContain(promoted.id);
    expect(rows.every((r) => r.text.includes('other') === false)).toBe(true);
  });

  it('hits counts matched keywords per row', () => {
    const { db, base, project } = setup();
    saveMemory(db, base({ text: 'routes behind web' }));
    const rows = searchVisibleMemories(db, project.id, ['route', 'web'], 10);
    expect(rows[0]?.hits).toBe(2);
  });

  it('scoreProjectMemories ignores other projects and hidden rows', () => {
    const { db, base, project, other } = setup();
    const visible = saveMemory(db, base({ text: 'sprocket unique visible' })).memory;
    const flagged = saveMemory(db, base({ text: 'sprocket flagged row' })).memory;
    const superseded = saveMemory(db, base({ text: 'sprocket superseded row' })).memory;
    const promoted = saveMemory(db, base({ text: 'sprocket promoted row', suggestRule: true })).memory;
    saveMemory(db, base({ projectId: other.id, text: 'sprocket other project' }));

    flagMemory(db, parseMemoryId(flagged.id)!, 'task_chatter');
    const replacement = saveMemory(db, base({ text: 'unrelated replacement words' })).memory;
    expect(supersedeMemory(db, project.id, parseMemoryId(superseded.id)!, parseMemoryId(replacement.id)!)).toBe('ok');
    expect(resolveSuggestion(db, parseMemoryId(promoted.id)!, 'promoted')).toBe(true);

    const rows = scoreProjectMemories(db, project.id, ['sprocket']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(parseMemoryId(visible.id));
    expect(rows[0]!.hits).toBe(1);
    expect(rows[0]!.score).toBeCloseTo(1.0);
  });

  it('hits does not count words that only appear in other memories', () => {
    const { db, base, project } = setup();
    const a = saveMemory(db, base({ text: 'alpha widget' })).memory;
    const b = saveMemory(db, base({ text: 'alpha gizmo sprocket' })).memory;
    const rows = searchVisibleMemories(db, project.id, ['alpha', 'gizmo', 'sprocket'], 10);
    const hits = Object.fromEntries(rows.map((r) => [`m_${r.id}`, r.hits]));
    expect(hits[a.id]).toBe(1);
    expect(hits[b.id]).toBe(3);
  });

  it('extractRecallKeywords lowercases, drops stopwords and <3 chars, dedupes plurals, caps at 30', () => {
    expect(extractRecallKeywords('The HTTP routes need a Fix. Add new check.')).toEqual(['http', 'routes']);
    expect(extractRecallKeywords('route routes routing')).toEqual(['route', 'routing']);
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(extractRecallKeywords(many)).toHaveLength(30);
  });

  it('splits on _ like unicode61', () => {
    expect(extractRecallKeywords('HTTP_ROUTES')).toEqual(['http', 'routes']);
  });

  it('the sixth pending suggestion is rejected but the memory saves', () => {
    const { db, base } = setup();
    for (let i = 0; i < 5; i++) {
      expect(saveMemory(db, base({ suggestRule: true, text: `pending ${i} widget` })).ruleSuggestion).toBe('pending');
    }
    const r = saveMemory(db, base({ suggestRule: true, text: 'sixth widget' }));
    expect(r.ruleSuggestion).toBe('rejected');
    expect(r.memory.ruleSuggestion).toBeNull();
    expect(countMemories(db).pendingSuggestions).toBe(5);
  });

  it('a superseded row frees a pending slot', () => {
    const { db, base, project } = setup();
    const first = saveMemory(db, base({ suggestRule: true, text: 'first pending widget' }));
    for (let i = 0; i < 4; i++) {
      saveMemory(db, base({ suggestRule: true, text: `pending ${i} extra widget` }));
    }
    expect(countMemories(db).pendingSuggestions).toBe(5);
    const replacement = saveMemory(db, base({ text: 'replacement widget' }));
    expect(supersedeMemory(db, project.id, parseMemoryId(first.memory.id)!, parseMemoryId(replacement.memory.id)!)).toBe('ok');
    expect(countMemories(db).pendingSuggestions).toBe(4);
    const extra = saveMemory(db, base({ suggestRule: true, text: 'new pending widget' }));
    expect(extra.ruleSuggestion).toBe('pending');
    expect(countMemories(db).pendingSuggestions).toBe(5);
  });

  it('supersede across projects returns not_found and changes nothing', () => {
    const { db, base, other } = setup();
    const a = saveMemory(db, base({ text: 'alpha in p' })).memory;
    const b = saveMemory(db, base({ projectId: other.id, text: 'alpha in q' })).memory;
    expect(supersedeMemory(db, other.id, parseMemoryId(a.id)!, parseMemoryId(b.id)!)).toBe('not_found');
    expect(getMemory(db, parseMemoryId(a.id)!)!.status).toBe('active');
  });

  it('supersede by a non-visible or same row returns conflict', () => {
    const { db, base, project } = setup();
    const a = saveMemory(db, base({ text: 'alpha one' })).memory;
    const flagged = saveMemory(db, base({ text: 'alpha two' })).memory;
    flagMemory(db, parseMemoryId(flagged.id)!, 'secret_like');
    expect(supersedeMemory(db, project.id, parseMemoryId(a.id)!, parseMemoryId(a.id)!)).toBe('conflict');
    expect(supersedeMemory(db, project.id, parseMemoryId(a.id)!, parseMemoryId(flagged.id)!)).toBe('conflict');
  });

  it('superseding a flagged row returns conflict and leaves the flagged count intact', () => {
    const { db, base, project } = setup();
    const flagged = saveMemory(db, base({ text: 'flagged alpha widget' })).memory;
    const neu = saveMemory(db, base({ text: 'replacement alpha widget' })).memory;
    flagMemory(db, parseMemoryId(flagged.id)!, 'secret_like');
    expect(countMemories(db).flagged).toBe(1);
    expect(supersedeMemory(db, project.id, parseMemoryId(flagged.id)!, parseMemoryId(neu.id)!)).toBe('conflict');
    expect(getMemory(db, parseMemoryId(flagged.id)!)!.status).toBe('flagged');
    expect(countMemories(db).flagged).toBe(1);
  });

  it('re-superseding an already-superseded row returns conflict', () => {
    const { db, base, project } = setup();
    const old = saveMemory(db, base({ text: 'old alpha widget' })).memory;
    const neu = saveMemory(db, base({ text: 'new alpha widget' })).memory;
    const third = saveMemory(db, base({ text: 'third alpha widget' })).memory;
    expect(supersedeMemory(db, project.id, parseMemoryId(old.id)!, parseMemoryId(neu.id)!)).toBe('ok');
    expect(supersedeMemory(db, project.id, parseMemoryId(old.id)!, parseMemoryId(third.id)!)).toBe('conflict');
    expect(getMemory(db, parseMemoryId(old.id)!)!.status).toBe('superseded');
    expect(getMemory(db, parseMemoryId(old.id)!)!.supersededBy).toBe(neu.id);
  });

  it('activateMemory restores flagged and superseded rows', () => {
    const { db, base, project } = setup();
    const flagged = saveMemory(db, base({ text: 'flag me' })).memory;
    flagMemory(db, parseMemoryId(flagged.id)!, 'task_chatter');
    expect(getMemory(db, parseMemoryId(flagged.id)!)!.status).toBe('flagged');
    expect(activateMemory(db, parseMemoryId(flagged.id)!)).toBe(true);
    const restored = getMemory(db, parseMemoryId(flagged.id)!)!;
    expect(restored.status).toBe('active');
    expect(restored.flagReason).toBeNull();

    const old = saveMemory(db, base({ text: 'old fact' })).memory;
    const neu = saveMemory(db, base({ text: 'new fact' })).memory;
    expect(supersedeMemory(db, project.id, parseMemoryId(old.id)!, parseMemoryId(neu.id)!)).toBe('ok');
    expect(activateMemory(db, parseMemoryId(old.id)!)).toBe(true);
    const back = getMemory(db, parseMemoryId(old.id)!)!;
    expect(back.status).toBe('active');
    expect(back.supersededBy).toBeNull();
  });

  it('listMemories hides superseded unless includeSuperseded; suggestions and flagged views', () => {
    const { db, base, project } = setup();
    const pending = saveMemory(db, base({ suggestRule: true, text: 'suggest this widget', ruleReason: 'always needed' })).memory;
    const flagged = saveMemory(db, base({ text: 'flag this widget' })).memory;
    flagMemory(db, parseMemoryId(flagged.id)!, 'addressed_to_agents');
    const old = saveMemory(db, base({ text: 'old widget' })).memory;
    const neu = saveMemory(db, base({ text: 'new widget' })).memory;
    supersedeMemory(db, project.id, parseMemoryId(old.id)!, parseMemoryId(neu.id)!);

    expect(listMemories(db, { view: 'all', limit: 50 }).map((m) => m.id)).not.toContain(old.id);
    expect(listMemories(db, { view: 'all', includeSuperseded: true, limit: 50 }).map((m) => m.id)).toContain(old.id);
    expect(listMemories(db, { view: 'suggestions', limit: 50 }).map((m) => m.id)).toEqual([pending.id]);
    expect(listMemories(db, { view: 'flagged', limit: 50 }).map((m) => m.id)).toEqual([flagged.id]);
    expect(countMemories(db)).toEqual({ pendingSuggestions: 1, flagged: 1 });
  });
});

describe('parseMemoryId (repo-adjacent)', () => {
  it('parseMemoryId rejects m_0, m_01, m_1x, 1', () => {
    expect(parseMemoryId('m_0')).toBeNull();
    expect(parseMemoryId('m_01')).toBeNull();
    expect(parseMemoryId('m_1x')).toBeNull();
    expect(parseMemoryId('1')).toBeNull();
  });
});
