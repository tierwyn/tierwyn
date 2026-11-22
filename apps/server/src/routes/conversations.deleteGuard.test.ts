import { describe, it, expect } from 'vitest';
import type { Database } from 'better-sqlite3';
import { performConversationDelete } from './conversations.js';

describe('performConversationDelete', () => {
  it('turns a thrown DB error into a 500 outcome instead of rejecting (would crash the hub)', async () => {
    const db = { prepare: () => { throw new Error('boom'); } } as unknown as Database;
    const out = await performConversationDelete({ getDb: () => db }, 'x');
    expect(out).toEqual({ ok: false, status: 500, error: 'boom' });
  });
});
