import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { appendEvent } from './repositories/events.js';
import { centerSnippet, literalTokens, ownText, turnText } from './searchSnippets.js';

describe('centerSnippet', () => {
  it('centres the first matched token with ellipses on both sides', () => {
    const text = `${'a '.repeat(200)}marmalade${' b'.repeat(200)}`;
    const s = centerSnippet(text, ['marmalade'], 60);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('marmalade');
    expect(s.length).toBe(62); // 60 body + 2 ellipses
  });
  it('is case-insensitive and falls back to the head when no token matches', () => {
    expect(centerSnippet('Hello MARMALADE world', ['marmalade'], 160)).toBe('Hello MARMALADE world');
    expect(centerSnippet('x'.repeat(300), ['nope'], 10)).toBe('x'.repeat(10));
  });
});

describe('literalTokens', () => {
  it('strips punctuation inside tokens and drops empties', () => {
    expect(literalTokens('  foo-bar  "baz" ! ')).toEqual(['foobar', 'baz']);
  });
});

describe('turnText', () => {
  it('reconstructs a streaming turn from its chunks when the indexed row is the terminator', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'C' });
    db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)').run('s1', c.id, 1, 1);
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'the marma', final: false }, sender: 'agent', seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'lade parser', final: false }, sender: 'agent', seq: 2 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: '', final: true }, sender: 'agent', seq: 3 });
    expect(turnText(db, { type: 'message', sessionId: 's1', seq: 3, payload: '{"chunk":"","final":true}' }))
      .toBe('the marmalade parser');
  });
  it('returns a prompt\'s own text', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    expect(turnText(db, { type: 'prompt', sessionId: 'x', seq: 1, payload: '{"text":"hi there"}' })).toBe('hi there');
  });

  it('joins helper label, description and summary', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const payload = JSON.stringify({
      taskId: 't1', label: 'Explore', description: 'list marmalade files', summary: 'found the parser', status: 'completed',
    });
    expect(turnText(db, { type: 'helper', sessionId: 'x', seq: 1, payload }))
      .toBe('Explore list marmalade files found the parser');
  });
});

describe('ownText', () => {
  it('extracts helper description and summary (and label) for snippets', () => {
    expect(ownText({
      taskId: 't1', label: 'Explore', description: 'list marmalade files', summary: 'found the parser',
    })).toBe('Explore list marmalade files found the parser');
    expect(ownText({ description: 'just desc', summary: 'just sum' })).toBe('just desc just sum');
    expect(ownText({ label: '', description: '', summary: '' })).toBe('');
  });

  it('still prefers prompt text and message chunk over helper fields', () => {
    expect(ownText({ text: 'hi there' })).toBe('hi there');
    expect(ownText({ chunk: 'the reply' })).toBe('the reply');
  });
});

describe('centerSnippet for helper text', () => {
  it('centres around a word that lives in the helper summary', () => {
    const text = `Explore list files ${'x '.repeat(80)}marmalade parser ${'y '.repeat(80)}`;
    const s = centerSnippet(text, ['marmalade'], 60);
    expect(s).toContain('marmalade');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
});
