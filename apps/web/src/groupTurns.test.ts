import { describe, it, expect } from 'vitest';
import type { NormalisedEvent } from '@tierwyn/shared';
import {
  forceInterruptDividerAt,
  groupIntoTurns,
  lastPromptKeyForSession,
  mergeMessageChunks,
  promptInterruptKey,
  findTurnIndexByPromptId,
  findGlobalTurnIndexByPromptId,
  type MergedItem,
} from './groupTurns.js';

function ev(partial: Partial<NormalisedEvent> & Pick<NormalisedEvent, 'type'>): NormalisedEvent {
  return {
    sessionId: 'sess-1',
    seq: 1,
    ts: 1000,
    sender: 'agent',
    ...partial,
  } as NormalisedEvent;
}

function item(event: NormalisedEvent): MergedItem {
  return { event, mergedIds: event.id ? [event.id] : [] };
}

describe('promptInterruptKey / lastPromptKeyForSession', () => {
  it('prefers persisted id over the ts fallback', () => {
    const prompt = ev({
      type: 'prompt',
      id: 'p-old',
      sender: 'user',
      payload: { text: 'hello' },
    });
    expect(promptInterruptKey(prompt)).toBe('p-old');
  });

  it('falls back to ts:session:ts when id is missing', () => {
    const prompt = ev({
      type: 'prompt',
      sender: 'user',
      ts: 42,
      sessionId: 's',
      payload: { text: 'hello' },
    });
    expect(promptInterruptKey(prompt)).toBe('ts:s:42');
  });

  it('snapshots the last prompt of the live session, not a later session', () => {
    const events = [
      ev({ type: 'prompt', id: 'p1', sessionId: 'sess-1', ts: 1, sender: 'user', payload: { text: 'a' } }),
      ev({ type: 'message', sessionId: 'sess-1', ts: 2, payload: { chunk: '…', final: true } }),
      ev({ type: 'prompt', id: 'p2', sessionId: 'sess-2', ts: 3, sender: 'user', payload: { text: 'b' } }),
    ];
    expect(lastPromptKeyForSession(events, 'sess-1')).toBe('p1');
    expect(lastPromptKeyForSession(events, 'sess-2')).toBe('p2');
  });

  it('does not pick a follow-up prompt that has not been sent yet', () => {
    const events = [
      ev({ type: 'prompt', id: 'p-live', sessionId: 'sess-1', sender: 'user', payload: { text: 'live' } }),
      ev({ type: 'tool_call', sessionId: 'sess-1', payload: { name: 'x', toolUseId: 't1', input: {} } }),
    ];
    expect(lastPromptKeyForSession(events, 'sess-1')).toBe('p-live');
  });
});

describe('forceInterruptDividerAt', () => {
  const interrupted = {
    id: 'turn-1',
    prompt: item(ev({ type: 'prompt', id: 'p-old', sender: 'user', payload: { text: 'old' } })),
    events: [item(ev({ type: 'message', payload: { chunk: 'partial', final: true } }))],
  };
  const followUp = {
    id: 'turn-2',
    prompt: item(ev({ type: 'prompt', id: 'p-new', sender: 'user', ts: 2000, payload: { text: 'cut in' } })),
    events: [item(ev({ type: 'tool_call', ts: 2001, payload: { name: 'x', toolUseId: 't2', input: {} } }))],
  };
  const ids = new Set(['p-old']);

  it('places the divider immediately above the Interrupt & Send message once it exists', () => {
    const turns = [interrupted, followUp];
    expect(forceInterruptDividerAt(turns, 0, ids)).toBeNull();
    expect(forceInterruptDividerAt(turns, 1, ids)).toBe('before-prompt');
  });

  it('keeps the divider at the end of the interrupted turn until the follow-up prompt arrives', () => {
    expect(forceInterruptDividerAt([interrupted], 0, ids)).toBe('after-turn');
  });

  it('does not leave the divider at the end of the follow-up turn (would drag through its tools)', () => {
    const turns = [interrupted, followUp];
    expect(forceInterruptDividerAt(turns, 1, ids)).not.toBe('after-turn');
  });
});

describe('groupIntoTurns — leftover events after Interrupt & Send', () => {
  it('keeps a late tool_result with the turn that opened the tool, not the follow-up prompt', () => {
    const items = [
      item(ev({ type: 'prompt', id: 'p-old', ts: 1, sender: 'user', payload: { text: 'old' } })),
      item(ev({
        type: 'tool_call', id: 'tc1', ts: 2, seq: 2,
        payload: { name: 'schedule', toolUseId: 'tu-1', input: {} },
      })),
      item(ev({ type: 'prompt', id: 'p-new', ts: 3, sender: 'user', payload: { text: 'cut in' } })),
      item(ev({
        type: 'tool_result', id: 'tr1', ts: 4, seq: 3,
        payload: { toolUseId: 'tu-1', content: 'done', isError: false },
      })),
    ];
    const turns = groupIntoTurns(items);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt?.event.id).toBe('p-old');
    expect(turns[1]!.prompt?.event.id).toBe('p-new');
    expect(turns[0]!.events.map((m) => m.event.type)).toEqual(['tool_call', 'tool_result']);
    expect(turns[1]!.events.map((m) => m.event.type)).toEqual([]);
  });

  it('parks leftovers that arrive after the follow-up prompt but before status:running', () => {
    const items = [
      item(ev({ type: 'prompt', id: 'p-old', ts: 1, sender: 'user', payload: { text: 'old' } })),
      item(ev({ type: 'message', id: 'm1', ts: 2, payload: { chunk: 'working', final: false } })),
      item(ev({ type: 'prompt', id: 'p-new', ts: 3, sender: 'user', payload: { text: 'cut in' } })),
      item(ev({
        type: 'tool_call', id: 'late', ts: 4, seq: 4,
        payload: { name: 'leftover', toolUseId: 'tu-late', input: {} },
      })),
      item(ev({ type: 'status', ts: 5, seq: 5, payload: { status: 'running' } })),
      item(ev({ type: 'message', id: 'm2', ts: 6, seq: 6, payload: { chunk: 'new reply', final: true } })),
    ];
    const turns = groupIntoTurns(items, new Set(['p-old']));
    expect(turns).toHaveLength(2);
    expect(turns[0]!.events.map((m) => m.event.type)).toEqual(['message', 'tool_call']);
    expect(turns[1]!.events.map((m) => m.event.type)).toEqual(['status', 'message']);
    expect((turns[1]!.events[1]!.event.payload as { chunk: string }).chunk).toBe('new reply');
  });

  it('does not park unmatched leftovers when the previous turn was not interrupted', () => {
    const items = [
      item(ev({ type: 'prompt', id: 'p-old', ts: 1, sender: 'user', payload: { text: 'old' } })),
      item(ev({ type: 'message', ts: 2, payload: { chunk: 'ok', final: true } })),
      item(ev({ type: 'prompt', id: 'p-new', ts: 3, sender: 'user', payload: { text: 'next' } })),
      item(ev({
        type: 'tool_call', ts: 4,
        payload: { name: 'fresh', toolUseId: 'tu-fresh', input: {} },
      })),
    ];
    const turns = groupIntoTurns(items);
    expect(turns[1]!.events.map((m) => m.event.type)).toEqual(['tool_call']);
  });

  it('does not steal a later turn\'s own tools after status:running', () => {
    const items = [
      item(ev({ type: 'prompt', id: 'p-old', ts: 1, sender: 'user', payload: { text: 'old' } })),
      item(ev({ type: 'message', ts: 2, payload: { chunk: 'ok', final: true } })),
      item(ev({ type: 'prompt', id: 'p-new', ts: 3, sender: 'user', payload: { text: 'cut in' } })),
      item(ev({ type: 'status', ts: 4, payload: { status: 'running' } })),
      item(ev({
        type: 'tool_call', ts: 5,
        payload: { name: 'new-tool', toolUseId: 'tu-new', input: {} },
      })),
    ];
    const turns = groupIntoTurns(items, new Set(['p-old']));
    expect(turns[1]!.events.map((m) => m.event.type)).toEqual(['status', 'tool_call']);
    expect(turns[0]!.events.map((m) => m.event.type)).toEqual(['message']);
  });

  it('sends leftover hard-stop events (old sessionId) back to the interrupted turn', () => {
    const items = [
      item(ev({
        type: 'prompt', id: 'p-old', sessionId: 'old-sess', ts: 1, sender: 'user',
        payload: { text: 'old' },
      })),
      item(ev({ type: 'message', sessionId: 'old-sess', ts: 2, payload: { chunk: 'partial', final: false } })),
      item(ev({
        type: 'prompt', id: 'p-new', sessionId: 'new-sess', ts: 3, sender: 'user',
        payload: { text: 'cut in' },
      })),
      item(ev({
        type: 'tool_result', sessionId: 'old-sess', ts: 4,
        payload: { toolUseId: 'orphan', content: 'late', isError: false },
      })),
    ];
    const turns = groupIntoTurns(items);
    expect(turns[0]!.events.map((m) => m.event.type)).toEqual(['message', 'tool_result']);
    expect(turns[1]!.events).toHaveLength(0);
  });

  it('keeps unsolicited watcher session events with the latest turn rather than regressing to an earlier turn', () => {
    const watcherSession = 'synth-watcher-session';
    const items = [
      item(ev({ type: 'prompt', id: 'p1', sessionId: 'turn1-sess', ts: 100, sender: 'user', payload: { text: 'first' } })),
      item(ev({ type: 'message', sessionId: 'turn1-sess', ts: 101, payload: { chunk: 'ack 1', final: true } })),
      item(ev({ type: 'message', sessionId: watcherSession, ts: 102, payload: { chunk: 'watcher note 1', final: true } })),
      item(ev({ type: 'prompt', id: 'p2', sessionId: 'turn2-sess', ts: 200, sender: 'user', payload: { text: 'second' } })),
      item(ev({ type: 'message', sessionId: 'turn2-sess', ts: 201, payload: { chunk: 'ack 2', final: true } })),
      item(ev({ type: 'message', sessionId: watcherSession, ts: 202, payload: { chunk: 'watcher note 2', final: true } })),
    ];
    const turns = groupIntoTurns(items);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt?.event.id).toBe('p1');
    expect(turns[0]!.events.map((m) => (m.event.payload as { chunk?: string }).chunk)).toEqual(['ack 1', 'watcher note 1']);
    expect(turns[1]!.prompt?.event.id).toBe('p2');
    expect(turns[1]!.events.map((m) => (m.event.payload as { chunk?: string }).chunk)).toEqual(['ack 2', 'watcher note 2']);
  });
});

describe('mergeMessageChunks (regression)', () => {
  it('joins consecutive message chunks and flushes on a tool event', () => {
    const merged = mergeMessageChunks([
      ev({ type: 'message', id: 'a', payload: { chunk: 'Hel', final: false } }),
      ev({ type: 'message', id: 'b', payload: { chunk: 'lo', final: true } }),
      ev({ type: 'tool_call', id: 'c', payload: { name: 'x', toolUseId: 't', input: {} } }),
    ]);
    expect(merged).toHaveLength(2);
    expect((merged[0]!.event.payload as { chunk: string }).chunk).toBe('Hello');
    expect(merged[1]!.event.type).toBe('tool_call');
  });

  it('preserves payload.files on a final attachment message (Grok Bot chips)', () => {
    const files = [{
      name: 'test-file.txt',
      mediaType: 'text/plain',
      status: 'ok' as const,
      size: 84,
      path: '/data/attachments/c/abc.txt',
    }];
    const merged = mergeMessageChunks([
      ev({
        type: 'message',
        id: 'att-1',
        payload: { chunk: '📎 test-file.txt', final: true, files },
      }),
    ]);
    expect(merged).toHaveLength(1);
    const payload = merged[0]!.event.payload as {
      chunk: string;
      final: boolean;
      files?: typeof files;
    };
    expect(payload.chunk).toBe('📎 test-file.txt');
    expect(payload.final).toBe(true);
    expect(payload.files).toEqual(files);
  });

  it('preserves payload.recalledMemories without merging it into preceding text', () => {
    const merged = mergeMessageChunks([
      ev({ type: 'message', ts: 1, payload: { chunk: 'preceding' } }),
      ev({
        type: 'message',
        id: 'chip-1',
        ts: 2,
        sender: 'system',
        payload: { chunk: '', recalledMemories: ['m_41', 'm_17'] },
      }),
      ev({ type: 'message', ts: 3, payload: { chunk: 'following', final: true } }),
    ]);
    expect(merged).toHaveLength(3);
    expect((merged[0]!.event.payload as { chunk: string }).chunk).toBe('preceding');
    expect((merged[1]!.event.payload as { recalledMemories?: string[] }).recalledMemories).toEqual(['m_41', 'm_17']);
    expect((merged[2]!.event.payload as { chunk: string }).chunk).toBe('following');
  });
});

describe('groupIntoTurns — recall chip grouping', () => {
  it('carries a chip that arrives before the prompt into the prompt turn without an initial dummy turn', () => {
    const items = [
      item(ev({
        type: 'message',
        id: 'chip-1',
        ts: 1,
        sender: 'system',
        payload: { chunk: '', recalledMemories: ['m_10'] },
      })),
      item(ev({ type: 'prompt', id: 'p1', ts: 2, sender: 'user', payload: { text: 'hello' } })),
      item(ev({ type: 'status', ts: 3, payload: { status: 'running' } })),
      item(ev({ type: 'message', ts: 4, payload: { chunk: 'world', final: true } })),
    ];
    const turns = groupIntoTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt?.event.id).toBe('p1');
    expect(turns[0]!.events).toHaveLength(3);
    expect(turns[0]!.events[0]!.event.id).toBe('chip-1');
  });
});

describe('findTurnIndexByPromptId / findGlobalTurnIndexByPromptId', () => {
  it('finds the correct 0-based turn index for a prompt id in full events', () => {
    const events = [
      ev({ type: 'prompt', id: 'p0', ts: 10, sender: 'user', payload: { text: 'turn 0' } }),
      ev({ type: 'message', ts: 20, payload: { chunk: 'reply 0', final: true } }),
      ev({ type: 'prompt', id: 'p1', ts: 30, sender: 'user', payload: { text: 'turn 1' } }),
      ev({ type: 'message', ts: 40, payload: { chunk: 'reply 1', final: true } }),
      ev({ type: 'prompt', id: 'p2', ts: 50, sender: 'user', payload: { text: 'turn 2' } }),
      ev({ type: 'message', ts: 60, payload: { chunk: 'reply 2', final: true } }),
    ];

    expect(findGlobalTurnIndexByPromptId(events, 'p0')).toBe(0);
    expect(findGlobalTurnIndexByPromptId(events, 'p1')).toBe(1);
    expect(findGlobalTurnIndexByPromptId(events, 'p2')).toBe(2);
    expect(findGlobalTurnIndexByPromptId(events, 'non-existent')).toBe(-1);
  });
});
