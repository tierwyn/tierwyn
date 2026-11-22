import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import {
  createTimer, getTimer, listPendingTimers, cancelTimer, claimDueTimers, setTimerError,
  updateTimer, getPendingNonOperatorTimer, cancelPendingNonOperatorTimers,
  listAllPendingTimerSummaries, setTimersChangedListener,
} from './conversationTimers.js';
import { PENDING_TIMER_PREVIEW_CHARS, type PromptAttachment } from '@tierwyn/shared';


const PROFILE = 'claude-code:test-model';
let db: Database;
let convA: string;
let convB: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
  convA = createConversation(db, { projectId: project.id, title: 'A' }).id;
  convB = createConversation(db, { projectId: project.id, title: 'B' }).id;
});

function seed(conversationId: string, fireAtMs: number, prompt = 'ping') {
  return createTimer(db, { conversationId, prompt, profileId: PROFILE, fireAtMs });
}

describe('conversationTimers repository', () => {
  it('round-trips a created timer', () => {
    const t = seed(convA, 1_000, 'run the tests');
    expect(t).toMatchObject({
      conversationId: convA, prompt: 'run the tests', profileId: PROFILE,
      fireAtMs: 1_000, cancelledAt: null, firedAt: null, error: null,
    });
    expect(getTimer(db, t.id)).toEqual(t);
  });

  it('lists only pending timers for the asked-for conversation, soonest first', () => {
    const later = seed(convA, 2_000);
    const sooner = seed(convA, 1_000);
    const other = seed(convB, 1_500);
    const cancelled = seed(convA, 1_200);
    cancelTimer(db, cancelled.id, 500);

    expect(listPendingTimers(db, convA).map((t) => t.id)).toEqual([sooner.id, later.id]);
    expect(listPendingTimers(db, convB).map((t) => t.id)).toEqual([other.id]);
  });

  it('cancels a pending timer once and not twice', () => {
    const t = seed(convA, 5_000);
    expect(cancelTimer(db, t.id, 900)).toBe(true);
    expect(cancelTimer(db, t.id, 950)).toBe(false);
    expect(getTimer(db, t.id)?.cancelledAt).toBe(900);
  });

  it('claims due timers exactly once (claim before deliver)', () => {
    const due = seed(convA, 1_000);
    const future = seed(convA, 9_000);
    const cancelled = seed(convA, 1_000);
    cancelTimer(db, cancelled.id, 500);

    const first = claimDueTimers(db, 1_000);
    expect(first.map((t) => t.id)).toEqual([due.id]);
    expect(first[0].firedAt).toBe(1_000);

    // A second sweep at the same instant claims nothing — the row is taken.
    expect(claimDueTimers(db, 1_000)).toEqual([]);
    expect(getTimer(db, future.id)?.firedAt).toBeNull();
  });

  it('cannot cancel a claimed timer', () => {
    const t = seed(convA, 1_000);
    claimDueTimers(db, 1_000);
    expect(cancelTimer(db, t.id, 1_100)).toBe(false);
  });

  it('records a delivery error without un-firing the row', () => {
    const t = seed(convA, 1_000);
    claimDueTimers(db, 1_000);
    setTimerError(db, t.id, 'profile unavailable');
    const after = getTimer(db, t.id);
    expect(after?.error).toBe('profile unavailable');
    expect(after?.firedAt).toBe(1_000);
  });
});

describe('timer origin / attempt', () => {
  it('defaults origin to operator and attempt to 1', () => {
    const t = seed(convA, 1_000);
    expect(t.origin).toBe('operator');
    expect(t.attempt).toBe(1);
  });

  it('persists agent-resume origin and attempt', () => {
    const t = createTimer(db, {
      conversationId: convA, prompt: 'wake', profileId: PROFILE, fireAtMs: 2_000,
      origin: 'agent-resume', attempt: 2,
    });
    expect(getTimer(db, t.id)).toMatchObject({ origin: 'agent-resume', attempt: 2 });
  });

  it('[S2-7] a second pending non-operator timer for the same conversation is rejected', () => {
    createTimer(db, {
      conversationId: convA, prompt: 'wake', profileId: PROFILE, fireAtMs: 2_000,
      origin: 'agent-resume',
    });
    expect(() => createTimer(db, {
      conversationId: convA, prompt: 'wake again', profileId: PROFILE, fireAtMs: 3_000,
      origin: 'agent-resume',
    })).toThrowError(/UNIQUE/);
    // Other conversations are unaffected.
    const other = createTimer(db, {
      conversationId: convB, prompt: 'wake', profileId: PROFILE, fireAtMs: 2_000,
      origin: 'agent-resume',
    });
    // Fired rows free the slot.
    claimDueTimers(db, 5_000); // fires convA's wake and convB's other
    expect(getTimer(db, other.id)?.firedAt).not.toBeNull();
    expect(() => createTimer(db, {
      conversationId: convB, prompt: 'wake', profileId: PROFILE, fireAtMs: 9_000,
      origin: 'auto-resume',
    })).not.toThrow();
    expect(() => createTimer(db, {
      conversationId: convA, prompt: 'wake', profileId: PROFILE, fireAtMs: 9_000,
      origin: 'agent-resume', attempt: 2,
    })).not.toThrow();
  });

  it('getPendingNonOperatorTimer ignores operator rows', () => {
    seed(convA, 1_000);
    const agent = createTimer(db, {
      conversationId: convA, prompt: 'auto', profileId: PROFILE, fireAtMs: 1_500,
      origin: 'auto-resume',
    });
    expect(getPendingNonOperatorTimer(db, convA)?.id).toBe(agent.id);
  });

  it('cancelPendingNonOperatorTimers leaves operator rows', () => {
    const op = seed(convA, 1_000);
    const agent = createTimer(db, {
      conversationId: convA, prompt: 'auto', profileId: PROFILE, fireAtMs: 1_500,
      origin: 'agent-resume',
    });
    expect(cancelPendingNonOperatorTimers(db, convA, 900)).toBe(1);
    expect(getTimer(db, op.id)?.cancelledAt).toBeNull();
    expect(getTimer(db, agent.id)?.cancelledAt).toBe(900);
  });
});

describe('timer notifyParent', () => {
  it('defaults notifyParent to null when omitted', () => {
    const t = seed(convA, 1_000);
    expect(t.notifyParent).toBeNull();
    expect(getTimer(db, t.id)?.notifyParent).toBeNull();
  });

  it('persists notifyParent true as 1 and false as 0', () => {
    const yes = createTimer(db, {
      conversationId: convA, prompt: 'wake', profileId: PROFILE, fireAtMs: 2_000,
      origin: 'agent-resume', notifyParent: true,
    });
    const no = createTimer(db, {
      conversationId: convB, prompt: 'wake', profileId: PROFILE, fireAtMs: 2_000,
      origin: 'agent-resume', notifyParent: false,
    });
    expect(getTimer(db, yes.id)?.notifyParent).toBe(true);
    expect(getTimer(db, no.id)?.notifyParent).toBe(false);
    const raw = db.prepare('SELECT notify_parent FROM conversation_timers WHERE id = ?').get(no.id) as { notify_parent: number | null };
    expect(raw.notify_parent).toBe(0);
  });
});

describe('timer snapshot round-trip', () => {

  const ATT = [{ base64: 'QUJD', mediaType: 'text/plain', name: 'rebuild.log' }];

  it('persists effort, options, attachments and handoff override', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 1_000, createdAt: 0,
      effort: 'high', options: { thinking: true }, attachments: ATT,
      handoffOverride: 'transcript',
    });
    expect(created.effort).toBe('high');
    expect(created.options).toEqual({ thinking: true });
    expect(created.attachmentNames).toEqual(['rebuild.log']);
    expect(created.handoffOverride).toBe('transcript');

    const read = getTimer(db, created.id)!;
    expect(read.effort).toBe('high');
    expect(read.options).toEqual({ thinking: true });
    expect(read.handoffOverride).toBe('transcript');
  });

  it('defaults every snapshot field to null / empty when omitted (v1 rows)', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'plain', profileId: 'claude-code:opus',
      fireAtMs: 1_000, createdAt: 0,
    });
    expect(created).toMatchObject({
      effort: null, options: null, attachmentNames: [], handoffOverride: null,
    });
    expect(getTimer(db, created.id)).toMatchObject({ effort: null, options: null });
  });

  it('never leaks attachment base64 into the list DTO', () => {
    createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 1_000, createdAt: 0, attachments: ATT,
    });
    const [listed] = listPendingTimers(db, convA);
    expect(listed.attachmentNames).toEqual(['rebuild.log']);
    expect(JSON.stringify(listed)).not.toContain('QUJD');
  });

  it('names an unnamed attachment positionally so the chip still has a label', () => {
    createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 1_000, createdAt: 0,
      attachments: [{ base64: 'QUJD', mediaType: 'image/png' }],
    });
    expect(listPendingTimers(db, convA)[0].attachmentNames).toEqual(['attachment 1']);
  });

  it('hands attachment bodies to the sweep via claimDueTimers', () => {
    createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 1_000, createdAt: 0, attachments: ATT, effort: 'low',
    });
    const [claimed] = claimDueTimers(db, 2_000);
    expect(claimed.attachments).toEqual(ATT);
    expect(claimed.effort).toBe('low');
  });

  it('survives a corrupt JSON column instead of throwing the sweep', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 1_000, createdAt: 0,
    });
    db.prepare('UPDATE conversation_timers SET options = ?, attachments = ? WHERE id = ?')
      .run('{not json', 'also not json', created.id);
    const read = getTimer(db, created.id)!;
    expect(read.options).toBeNull();
    expect(read.attachmentNames).toEqual([]);
  });
});

describe('updateTimer', () => {
  const ATT = [{ base64: 'QUJD', mediaType: 'text/plain', name: 'rebuild.log' }];

  it('partial patch preserves untouched columns', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 5_000, createdAt: 42,
      effort: 'high', options: { thinking: true }, attachments: ATT,
      handoffOverride: 'transcript',
    });
    const updated = updateTimer(db, created.id, { prompt: 'go harder' });
    expect(updated).toMatchObject({
      id: created.id,
      prompt: 'go harder',
      profileId: 'claude-code:opus',
      fireAtMs: 5_000,
      createdAt: 42,
      effort: 'high',
      options: { thinking: true },
      attachmentNames: ['rebuild.log'],
      handoffOverride: 'transcript',
      firedAt: null,
      cancelledAt: null,
    });
  });

  it('normalises empty options {} and attachments [] to SQL NULL', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: PROFILE,
      fireAtMs: 5_000, createdAt: 0,
      options: { thinking: true }, attachments: ATT,
    });
    const updated = updateTimer(db, created.id, { options: {}, attachments: [] });
    expect(updated?.options).toBeNull();
    expect(updated?.attachmentNames).toEqual([]);
    const row = db.prepare(
      'SELECT options, attachments FROM conversation_timers WHERE id = ?',
    ).get(created.id) as { options: string | null; attachments: string | null };
    expect(row.options).toBeNull();
    expect(row.attachments).toBeNull();
  });

  it('returns undefined when fired_at is set', () => {
    const t = seed(convA, 1_000);
    claimDueTimers(db, 1_000);
    expect(updateTimer(db, t.id, { prompt: 'too late' })).toBeUndefined();
    expect(getTimer(db, t.id)?.prompt).toBe('ping');
  });

  it('returns undefined when cancelled_at is set', () => {
    const t = seed(convA, 5_000);
    cancelTimer(db, t.id, 900);
    expect(updateTimer(db, t.id, { prompt: 'too late' })).toBeUndefined();
    expect(getTimer(db, t.id)?.prompt).toBe('ping');
  });

  it('empty patch is a no-op returning the row', () => {
    const t = seed(convA, 5_000, 'unchanged');
    const updated = updateTimer(db, t.id, {});
    expect(updated).toEqual(getTimer(db, t.id));
    expect(updated?.prompt).toBe('unchanged');
    expect(updated?.fireAtMs).toBe(5_000);
  });

  it('explicit null clears effort; prompt, fireAtMs and options stay put', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 5_000, createdAt: 42,
      effort: 'high', options: { thinking: true }, attachments: ATT,
      handoffOverride: 'transcript',
    });
    const updated = updateTimer(db, created.id, { effort: null });
    expect(updated).toMatchObject({
      prompt: 'go',
      fireAtMs: 5_000,
      createdAt: 42,
      effort: null,
      options: { thinking: true },
      attachmentNames: ['rebuild.log'],
      handoffOverride: 'transcript',
    });
    const row = db.prepare(
      'SELECT effort FROM conversation_timers WHERE id = ?',
    ).get(created.id) as { effort: string | null };
    expect(row.effort).toBeNull();
  });

  it('explicit null clears handoffOverride; other snapshot columns stay put', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 5_000, createdAt: 42,
      effort: 'high', options: { thinking: true }, attachments: ATT,
      handoffOverride: 'transcript',
    });
    const updated = updateTimer(db, created.id, { handoffOverride: null });
    expect(updated).toMatchObject({
      prompt: 'go',
      fireAtMs: 5_000,
      effort: 'high',
      options: { thinking: true },
      attachmentNames: ['rebuild.log'],
      handoffOverride: null,
    });
    const row = db.prepare(
      'SELECT handoff_override FROM conversation_timers WHERE id = ?',
    ).get(created.id) as { handoff_override: string | null };
    expect(row.handoff_override).toBeNull();
  });

  // Discriminates `'key' in patch` from `patch.key !== undefined`.
  // `{ options: undefined }` is `in` the object so the column is written
  // (empty → SQL NULL). A `!== undefined` check would skip the clause and
  // leave the stored object intact — this test would then fail.
  it('treats explicit undefined as present (in-check, not !== undefined)', () => {
    const created = createTimer(db, {
      conversationId: convA, prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: 5_000, createdAt: 0,
      options: { thinking: true }, effort: 'high',
    });
    const updated = updateTimer(db, created.id, { options: undefined });
    expect(updated?.options).toBeNull();
    expect(updated?.effort).toBe('high');
    expect(updated?.prompt).toBe('go');
    const row = db.prepare(
      'SELECT options FROM conversation_timers WHERE id = ?',
    ).get(created.id) as { options: string | null };
    expect(row.options).toBeNull();
  });

  it('cancelPendingNonOperatorTimers cancels agent-self but never operator rows', () => {
    createTimer(db, { conversationId: convA, prompt: 'op', profileId: PROFILE, fireAtMs: 1e5 });
    createTimer(db, { conversationId: convA, prompt: 'self', profileId: PROFILE, fireAtMs: 2e5, origin: 'agent-self' });
    expect(cancelPendingNonOperatorTimers(db, convA, 50_000)).toBe(1);
    expect(listPendingTimers(db, convA).map((t) => t.origin)).toEqual(['operator']);
  });

  it('lists pending timers across conversations, soonest first, without blobs', () => {
    createTimer(db, { conversationId: convA, prompt: 'op', profileId: PROFILE, fireAtMs: 3e5 });
    createTimer(db, { conversationId: convB, prompt: 'self', profileId: PROFILE, fireAtMs: 1e5, origin: 'agent-self' });
    const cancelled = createTimer(db, { conversationId: convA, prompt: 'canc', profileId: PROFILE, fireAtMs: 2e5 });
    cancelTimer(db, cancelled.id, 50);
    createTimer(db, { conversationId: convB, prompt: 'fired', profileId: PROFILE, fireAtMs: 50 });
    claimDueTimers(db, 100);

    const r = listAllPendingTimerSummaries(db, 200);
    expect(r.truncated).toBe(false);
    expect(r.timers.map((t) => [t.conversationId, t.origin])).toEqual([[convB, 'agent-self'], [convA, 'operator']]);
    expect(r.timers[0]).toMatchObject({ conversationTitle: 'B', projectName: 'p', promptTruncated: false });
    expect(r.timers[0]).not.toHaveProperty('attachments');
    expect(r.timers[0]).not.toHaveProperty('attachmentNames');
  });

  it('truncates long prompts to PENDING_TIMER_PREVIEW_CHARS', () => {
    createTimer(db, {
      conversationId: convA, prompt: 'x'.repeat(5000), profileId: PROFILE, fireAtMs: 1e5,
      attachments: [{ name: 'big.bin', mediaType: 'application/octet-stream', base64: 'A'.repeat(1_000_000) }],
    });
    const [t] = listAllPendingTimerSummaries(db, 200).timers;
    expect(t.promptPreview).toHaveLength(PENDING_TIMER_PREVIEW_CHARS);
    expect(t.promptTruncated).toBe(true);
  });

  it('caps the list and reports truncated', () => {
    for (let i = 0; i < 3; i++) createTimer(db, { conversationId: convA, prompt: `t${i}`, profileId: PROFILE, fireAtMs: 1e5 + i });
    const r = listAllPendingTimerSummaries(db, 2);
    expect(r.timers).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});




describe('timers_changed notifier', () => {
  it('reports the conversation on create, edit, cancel and fire (coalesced per tick)', async () => {
    const seen: string[][] = [];
    setTimersChangedListener((ids) => seen.push([...ids].sort()));
    const tick = () => new Promise((r) => setImmediate(r));
    try {
      const a = seed(convA, 1000);
      seed(convB, 1000);
      await tick();
      expect(seen).toEqual([[convA, convB].sort()]);
      updateTimer(db, a.id, { prompt: 'edited' });
      await tick();
      expect(seen.at(-1)).toEqual([convA]);
      expect(cancelTimer(db, a.id, 5)).toBe(true);
      expect(cancelTimer(db, a.id, 6)).toBe(false);
      await tick();
      expect(seen.at(-1)).toEqual([convA]);
      const n = seen.length;
      claimDueTimers(db, 2000);
      await tick();
      expect(seen.length).toBe(n + 1);
      expect(seen.at(-1)).toEqual([convB]);
    } finally {
      setTimersChangedListener(null);
    }
  });
});
