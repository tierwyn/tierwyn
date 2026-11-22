import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MAX_TAGS, type ServerFrame } from '@tierwyn/shared';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings } from './db/seed.js';
import { createProject } from './repositories/projects.js';
import { createConversation, getConversation, updateConversationTags } from './repositories/conversations.js';
import { createSession } from './repositories/sessions.js';
import { appendEvent } from './repositories/events.js';
import { setTagCatalogueSettings, updateDecisionSettings } from './repositories/settings.js';
import type { Answer, DecideResult, Question } from './decide.js';
import { autoTagConversationIfDue, autoTagDeps, AUTOTAG_MIN_PROMPTS } from './autoTags.js';

const origDecide = autoTagDeps.decide;
let stub: ReturnType<typeof vi.fn>;

const noul = (n: number): Answer => ({ type: 'noul', noul: n });
/** Answer keyed by the question keys actually sent; `hits` maps tag text -> probability. */
function answerFor(questions: Record<string, Question>, hits: Record<string, number>): DecideResult {
  const answers: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const tag = /"(.*)"/.exec(q.instructions)![1];
    answers[key] = noul(hits[tag] ?? 0.05);
  }
  return { answers, model: 'jev-1.13.0', latencyMs: 5 };
}
const verdict = (hits: Record<string, number>) =>
  stub.mockImplementation(async (_s: unknown, qs: Record<string, Question>) => answerFor(qs, hits));
const sentQuestions = () => stub.mock.calls[0]![1] as Record<string, Question>;
const sentTags = () => Object.values(sentQuestions()).map((q) => /"(.*)"/.exec(q.instructions)![1]);

function setup(opts: { prompts?: number; description?: string | null; on?: boolean } = {}) {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  if (opts.on !== false) updateDecisionSettings(db, { enabled: true, apiKey: 'k', autoTagEnabled: true });
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'Fix login crash' });
  db.prepare('UPDATE conversations SET description = ? WHERE id = ?')
    .run(opts.description === undefined ? 'Debugging a crash on login' : opts.description, c.id);
  createSession(db, { id: 's1', conversationId: c.id });
  for (let i = 0; i < (opts.prompts ?? AUTOTAG_MIN_PROMPTS); i++) prompt(db, i, {});
  return { db, id: c.id };
}
let seq = 0;
function prompt(db: Database, _i: number, payload: Record<string, unknown>, sessionId = 's1') {
  appendEvent(db, { sessionId, type: 'prompt', sender: 'user', seq: seq++, ts: 1, payload: { text: 'hello', ...payload } });
}
const markOf = (db: Database, id: string) =>
  (db.prepare('SELECT auto_tagged_at AS m FROM conversations WHERE id = ?').get(id) as { m: number | null }).m;

beforeEach(() => {
  stub = vi.fn();
  autoTagDeps.decide = stub as unknown as typeof autoTagDeps.decide;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  autoTagDeps.decide = origDecide;
  vi.restoreAllMocks();
});

describe('autoTagConversationIfDue', () => {
  it('applies the top picks additively, broadcasts tags, marks, and calls decide as autotag', async () => {
    const { db, id } = setup();
    updateConversationTags(db, id, ['mine']);
    verdict({ bug: 0.95, ui: 0.8, api: 0.75, git: 0.71, docs: 0.5 });
    const frames: ServerFrame[] = [];
    await autoTagConversationIfDue(db, id, (f) => frames.push(f));
    expect(getConversation(db, id)!.tags).toEqual(['mine', 'bug', 'ui', 'api']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'conversation_updated', conversationId: id, tags: ['mine', 'bug', 'ui', 'api'] });
    expect(markOf(db, id)).not.toBeNull();
    expect(stub.mock.calls[0]![2]).toMatchObject({ consumer: 'autotag', timeoutMs: 5000, conversationId: id });
    expect(stub.mock.calls[0]![0]).toEqual({ title: 'Fix login crash', description: 'Debugging a crash on login' });
  });

  it('only catalogue tags are ever applied; disabled ones are not asked; unknown keys ignored', async () => {
    const { db, id } = setup();
    setTagCatalogueSettings(db, { custom: [{ tag: 'mine', hint: 'h' }], disabledBuiltins: ['bug'] });
    stub.mockImplementation(async (_s: unknown, qs: Record<string, Question>) => {
      const r = answerFor(qs, { mine: 0.9, ui: 0.8 });
      r.answers.t99 = noul(1);
      r.answers.evil = noul(1);
      return r;
    });
    await autoTagConversationIfDue(db, id);
    expect(sentTags()).not.toContain('bug');
    expect(sentTags()).toHaveLength(24);
    expect(Object.keys(sentQuestions()).slice(0, 2)).toEqual(['t0', 't1']);
    const tags = getConversation(db, id)!.tags;
    expect(tags).toEqual(['mine', 'ui']);
    expect(tags).not.toContain('evil');
  });

  it('nothing above threshold: tags unchanged, no broadcast, still marked', async () => {
    const { db, id } = setup();
    verdict({ bug: 0.69 });
    const frames: ServerFrame[] = [];
    await autoTagConversationIfDue(db, id, (f) => frames.push(f));
    expect(getConversation(db, id)!.tags).toEqual([]);
    expect(frames).toHaveLength(0);
    expect(markOf(db, id)).not.toBeNull();
  });

  it('respects MAX_TAGS: 9 existing + 3 picks -> 10, operator tags intact, no duplicate by case', async () => {
    const { db, id } = setup();
    const existing = ['Bug', ...Array.from({ length: 8 }, (_, i) => `op${i}`)];
    updateConversationTags(db, id, existing);
    verdict({ bug: 0.99, ui: 0.9, api: 0.8, git: 0.75 });
    await autoTagConversationIfDue(db, id);
    const tags = getConversation(db, id)!.tags;
    expect(tags.slice(0, 9)).toEqual(existing);
    expect(tags).toHaveLength(MAX_TAGS);
    expect(tags.filter((t) => t.toLowerCase() === 'bug')).toHaveLength(1);
  });

  it('full tag list: decide is not called but the conversation is marked', async () => {
    const { db, id } = setup();
    updateConversationTags(db, id, Array.from({ length: MAX_TAGS }, (_, i) => `op${i}`));
    await autoTagConversationIfDue(db, id);
    expect(stub).not.toHaveBeenCalled();
    expect(markOf(db, id)).not.toBeNull();
  });

  it('empty enabled catalogue: no call, marked', async () => {
    const { db, id } = setup();
    const { BUILTIN_TAG_CATALOGUE } = await import('@tierwyn/shared');
    setTagCatalogueSettings(db, { custom: [], disabledBuiltins: BUILTIN_TAG_CATALOGUE.map((b) => b.tag) });
    await autoTagConversationIfDue(db, id);
    expect(stub).not.toHaveBeenCalled();
    expect(markOf(db, id)).not.toBeNull();
  });

  it('a tag PATCHed between the claim and the write survives', async () => {
    const { db, id } = setup();
    stub.mockImplementation(async (_s: unknown, qs: Record<string, Question>) => {
      updateConversationTags(db, id, ['patched']);
      return answerFor(qs, { bug: 0.9 });
    });
    await autoTagConversationIfDue(db, id);
    expect(getConversation(db, id)!.tags).toEqual(['patched', 'bug']);
  });

  // Once-only holds via the already-marked gate plus single-threaded sync claim; the CAS in the claim
  // is defence-in-depth (a call B here exits at the gate, never reaching it).
  it('runs once across sequential and concurrent calls', async () => {
    const a = setup();
    verdict({ bug: 0.9 });
    await autoTagConversationIfDue(a.db, a.id);
    await autoTagConversationIfDue(a.db, a.id);
    expect(stub).toHaveBeenCalledTimes(1);

    stub.mockClear();
    const b = setup();
    verdict({ bug: 0.9 });
    await Promise.all([autoTagConversationIfDue(b.db, b.id), autoTagConversationIfDue(b.db, b.id)]);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('a null verdict releases the mark; the next call retries', async () => {
    const { db, id } = setup();
    stub.mockResolvedValueOnce(null);
    const frames: ServerFrame[] = [];
    await autoTagConversationIfDue(db, id, (f) => frames.push(f));
    expect(markOf(db, id)).toBeNull();
    expect(getConversation(db, id)!.tags).toEqual([]);
    expect(frames).toHaveLength(0);
    verdict({ bug: 0.9 });
    await autoTagConversationIfDue(db, id);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(getConversation(db, id)!.tags).toEqual(['bug']);
  });

  it('a throwing decide never escapes and releases the mark', async () => {
    const { db, id } = setup();
    stub.mockRejectedValue(new Error('boom SECRET'));
    await expect(autoTagConversationIfDue(db, id)).resolves.toBeUndefined();
    expect(markOf(db, id)).toBeNull();
  });

  it.each([
    ['Jev disabled', { enabled: false }],
    ['auto-tag flag off', { autoTagEnabled: false }],
    ['no api key', { apiKey: '' }],
  ])('%s: no call, row untouched', async (_name, patch) => {
    const { db, id } = setup();
    updateDecisionSettings(db, patch);
    await autoTagConversationIfDue(db, id);
    expect(stub).not.toHaveBeenCalled();
    expect(markOf(db, id)).toBeNull();
  });

  it('too few prompts: no call and no mark; commands and non-user sources are not counted', async () => {
    const { db, id } = setup({ prompts: AUTOTAG_MIN_PROMPTS - 1 });
    prompt(db, 0, { commandName: 'compact' });
    prompt(db, 0, { source: 'subagent_notify' });
    await autoTagConversationIfDue(db, id);
    expect(stub).not.toHaveBeenCalled();
    expect(markOf(db, id)).toBeNull();
    verdict({ bug: 0.9 });
    prompt(db, 0, {});
    await autoTagConversationIfDue(db, id);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('no description (null or blank): no call, no mark', async () => {
    for (const description of [null, '  ']) {
      const { db, id } = setup({ description });
      await autoTagConversationIfDue(db, id);
      expect(markOf(db, id)).toBeNull();
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it('spawn children and schedule runs are not tagged', async () => {
    const { db, id } = setup();
    const child = createConversation(db, {
      projectId: (db.prepare('SELECT project_id AS p FROM conversations WHERE id = ?').get(id) as { p: string }).p,
      title: 'child', parentConversationId: id,
    });
    db.prepare('UPDATE conversations SET description = ? WHERE id = ?').run('d', child.id);
    createSession(db, { id: 's2', conversationId: child.id });
    for (let i = 0; i < 3; i++) prompt(db, i, {}, 's2');
    await autoTagConversationIfDue(db, child.id);
    db.prepare("UPDATE conversations SET schedule_job_id = 'job1' WHERE id = ?").run(id);
    await autoTagConversationIfDue(db, id);
    expect(stub).not.toHaveBeenCalled();
  });

  it('[autotag] skipped= and failed: lines are content-free', async () => {
    const full = setup();
    updateConversationTags(full.db, full.id, Array.from({ length: MAX_TAGS }, (_, i) => `SENTINEL-${i}`));
    const log = vi.spyOn(console, 'log');
    await autoTagConversationIfDue(full.db, full.id);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(`[autotag] conversation=${full.id} skipped=full`);

    const bad = setup();
    stub.mockResolvedValue({ answers: null, model: 'SENTINEL-model', latencyMs: 1 });  // post-claim TypeError
    const warn = vi.spyOn(console, 'warn');
    await autoTagConversationIfDue(bad.db, bad.id);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`[autotag] conversation=${bad.id} failed: TypeError`);
    const out = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    for (const secret of ['SENTINEL', 'Fix login crash', 'Debugging a crash']) expect(out).not.toContain(secret);
  });

  it('[autotag] log is content-free (counts and id only)', async () => {
    const { db, id } = setup();
    setTagCatalogueSettings(db, { custom: [{ tag: 'SENTINEL-TAG', hint: 'SENTINEL-HINT' }], disabledBuiltins: [] });
    verdict({ 'SENTINEL-TAG': 0.9 });
    const log = vi.spyOn(console, 'log');
    await autoTagConversationIfDue(db, id);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(`[autotag] conversation=${id} asked=25 applied=1`);
    const out = JSON.stringify(log.mock.calls);
    for (const secret of ['SENTINEL', 'Fix login crash', 'Debugging a crash']) expect(out).not.toContain(secret);
  });
});
