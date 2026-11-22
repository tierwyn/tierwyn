import { describe, expect, it } from 'vitest';
import type { NormalisedEvent, SpawnMarker } from '@tierwyn/shared';
import type { MergedItem, PromptTurn } from './groupTurns.js';
import {
  conversationSubagentTotalMs,
  cumulativeSubagentElapsedMs,
  cumulativeTurnElapsedMs,
  cumulativeTurnWaitingMs,
  turnElapsedMs,
  turnSubagentElapsedMs,
  turnWaitingMs,
  WAITING_DISPLAY_THRESHOLD_MS,
} from './turnElapsed.js';

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
  return { event };
}

function turn(partial: Partial<PromptTurn> & { id: string }): PromptTurn {
  return { events: [], ...partial };
}

function spawnItem(marker: Partial<SpawnMarker> & Pick<SpawnMarker, 'kind'>): MergedItem {
  return item(ev({
    type: 'message',
    payload: {
      chunk: marker.text ?? marker.kind,
      spawnMarker: {
        childConversationId: marker.childConversationId ?? 'child-1',
        text: marker.text ?? marker.kind,
        ...marker,
      },
    },
  }));
}

describe('turnElapsedMs', () => {
  it('pauses while an interaction_request is unresolved (settled and live)', () => {
    const t = turn({
      id: 'tq',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'interaction_request', ts: 2_000 } as never)),
        item(ev({ type: 'interaction_resolved', ts: 60_000 } as never)),
        item(ev({ type: 'message', ts: 61_000, payload: { chunk: 'a', final: true } })),
      ],
    });
    expect(turnElapsedMs(t)).toBe(2_000);
    const live = turn({ id: 'tl', prompt: t.prompt, events: t.events.slice(0, 1) });
    expect(turnElapsedMs(live, 99_000)).toBe(1_000);
  });

  it('measures prompt ts to the latest event ts', () => {
    const t = turn({
      id: 't1',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'message', ts: 1_400, payload: { chunk: 'a', final: false } })),
        item(ev({ type: 'message', ts: 3_500, payload: { chunk: 'b', final: true } })),
      ],
    });
    expect(turnElapsedMs(t)).toBe(2_500);
  });

  it('returns null when the prompt has no finite timestamp', () => {
    const t = turn({
      id: 't1',
      events: [item(ev({ type: 'message', ts: 2_000, payload: { chunk: 'a', final: true } }))],
    });
    expect(turnElapsedMs(t)).toBeNull();
  });

  it('extends the end to liveNow when it is later than the last event', () => {
    const t = turn({
      id: 't1',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [item(ev({ type: 'message', ts: 1_500, payload: { chunk: 'a', final: false } }))],
    });
    expect(turnElapsedMs(t, 4_000)).toBe(3_000);
  });

  it('does not shrink below the last event when liveNow is earlier', () => {
    const t = turn({
      id: 't1',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [item(ev({ type: 'message', ts: 5_000, payload: { chunk: 'a', final: true } }))],
    });
    expect(turnElapsedMs(t, 2_000)).toBe(4_000);
  });
});

describe('WAITING_DISPLAY_THRESHOLD_MS', () => {
  it('exports the 30-second display threshold constant', () => {
    expect(WAITING_DISPLAY_THRESHOLD_MS).toBe(30_000);
  });
});

describe('turnWaitingMs', () => {
  it('returns null when the prompt has no finite timestamp', () => {
    const t = turn({
      id: 't1',
      events: [item(ev({ type: 'interaction_request', ts: 2_000 } as never))],
    });
    expect(turnWaitingMs(t)).toBeNull();
  });

  it('returns 0 when there are no unresolved cards', () => {
    const t = turn({
      id: 't1',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'message', ts: 2_000, payload: { chunk: 'a', final: true } })),
      ],
    });
    expect(turnWaitingMs(t)).toBe(0);
  });

  it('measures waiting sum with resolved cards', () => {
    const t = turn({
      id: 'tq',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'interaction_request', ts: 2_000 } as never)),
        item(ev({ type: 'interaction_resolved', ts: 60_000 } as never)),
        item(ev({ type: 'message', ts: 61_000, payload: { chunk: 'a', final: true } })),
      ],
    });
    // 60_000 - 2_000 = 58_000 waiting
    expect(turnWaitingMs(t)).toBe(58_000);
  });

  it('measures multiple wait windows in one turn', () => {
    const t = turn({
      id: 't-multi',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'message', ts: 2_000, payload: { chunk: '1', final: false } })),
        item(ev({ type: 'interaction_request', ts: 3_000 } as never)),
        item(ev({ type: 'interaction_resolved', ts: 8_000 } as never)),
        item(ev({ type: 'message', ts: 10_000, payload: { chunk: '2', final: false } })),
        item(ev({ type: 'interaction_request', ts: 12_000 } as never)),
        item(ev({ type: 'interaction_resolved', ts: 19_000 } as never)),
        item(ev({ type: 'message', ts: 20_000, payload: { chunk: '3', final: true } })),
      ],
    });
    // Wait window 1: 8_000 - 3_000 = 5_000
    // Wait window 2: 19_000 - 12_000 = 7_000
    // Total waiting: 12_000
    expect(turnWaitingMs(t)).toBe(12_000);
  });

  it('counts waiting only up to the last event when a card is never answered at end of events', () => {
    const t = turn({
      id: 't-unanswered',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'message', ts: 2_000, payload: { chunk: '1', final: false } })),
        item(ev({ type: 'interaction_request', ts: 5_000 } as never)),
        item(ev({ type: 'message', ts: 15_000, payload: { chunk: 'mid', final: false } })),
      ],
    });
    // Interaction opened at 5_000, last event at 15_000; never resolved
    // Waiting is 15_000 - 5_000 = 10_000
    expect(turnWaitingMs(t)).toBe(10_000);

    // If interaction_request is the very last event:
    const tEnd = turn({
      id: 't-end',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'interaction_request', ts: 5_000 } as never)),
      ],
    });
    expect(turnWaitingMs(tEnd)).toBe(0);
  });

  it('satisfies partition invariant turnElapsedMs === (turnWaitingMs + worked gaps) on a mixed fixture', () => {
    // start: 1_000
    // ev1: message at 3_000 (worked gap 1: 2_000)
    // ev2: interaction_request at 4_000 (worked gap 2: 1_000)
    // ev3: interaction_resolved at 14_000 (waiting gap 1: 10_000)
    // ev4: message at 18_000 (worked gap 3: 4_000)
    // ev5: interaction_request at 20_000 (worked gap 4: 2_000)
    // ev6: interaction_resolved at 25_000 (waiting gap 2: 5_000)
    // ev7: message at 26_000 (worked gap 5: 1_000)
    // Total wall clock: 26_000 - 1_000 = 25_000
    // Worked-only gaps: 2_000 + 1_000 + 4_000 + 2_000 + 1_000 = 10_000
    // Waiting-only gaps: 10_000 + 5_000 = 15_000
    const mixed = turn({
      id: 'mixed',
      prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'hi' } })),
      events: [
        item(ev({ type: 'message', ts: 3_000, payload: { chunk: 'a', final: false } })),
        item(ev({ type: 'interaction_request', ts: 4_000 } as never)),
        item(ev({ type: 'interaction_resolved', ts: 14_000 } as never)),
        item(ev({ type: 'message', ts: 18_000, payload: { chunk: 'b', final: false } })),
        item(ev({ type: 'interaction_request', ts: 20_000 } as never)),
        item(ev({ type: 'interaction_resolved', ts: 25_000 } as never)),
        item(ev({ type: 'message', ts: 26_000, payload: { chunk: 'c', final: true } })),
      ],
    });

    const elapsed = turnElapsedMs(mixed);
    const waiting = turnWaitingMs(mixed);
    const workedGaps = 10_000;
    const waitingGaps = 15_000;
    const totalDuration = 26_000 - 1_000;

    expect(elapsed).toBe(workedGaps);
    expect(waiting).toBe(waitingGaps);
    expect(elapsed! + waiting!).toBe(totalDuration);
    // Partition invariant: turnElapsedMs equals gaps where pending === 0
    expect(elapsed).toBe(workedGaps);
    expect(elapsed! - waiting!).toBe(workedGaps - waitingGaps);
  });
});

describe('cumulativeTurnWaitingMs', () => {
  const turnA = turn({
    id: 'a',
    prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'a' } })),
    events: [
      item(ev({ type: 'interaction_request', ts: 2_000 } as never)),
      item(ev({ type: 'interaction_resolved', ts: 5_000 } as never)),
      item(ev({ type: 'message', ts: 6_000, payload: { chunk: 'a', final: true } })),
    ], // waiting: 3_000
  });
  const turnB = turn({
    id: 'b',
    prompt: item(ev({ type: 'prompt', ts: 10_000, sender: 'user', payload: { text: 'b' } })),
    events: [
      item(ev({ type: 'message', ts: 13_000, payload: { chunk: 'b', final: true } })),
    ], // waiting: 0
  });
  const turnC = turn({
    id: 'c',
    prompt: item(ev({ type: 'prompt', ts: 20_000, sender: 'user', payload: { text: 'c' } })),
    events: [
      item(ev({ type: 'interaction_request', ts: 21_000 } as never)),
      item(ev({ type: 'interaction_resolved', ts: 27_000 } as never)),
      item(ev({ type: 'message', ts: 28_000, payload: { chunk: 'c', final: true } })),
    ], // waiting: 6_000
  });

  it('equals the first turn waiting at index 0', () => {
    expect(cumulativeTurnWaitingMs([turnA, turnB], 0)).toBe(3_000);
  });

  it('sums every turn waiting up to the given index', () => {
    // 3_000 + 0 + 6_000 = 9_000
    expect(cumulativeTurnWaitingMs([turnA, turnB, turnC], 2)).toBe(9_000);
  });

  it('stops at the given index rather than the whole conversation', () => {
    expect(cumulativeTurnWaitingMs([turnA, turnB, turnC], 1)).toBe(3_000);
  });

  it('skips turns that have no measurable duration', () => {
    const missing = turn({ id: 'gap', events: [item(ev({ type: 'message', ts: 9_000, payload: { chunk: 'x', final: true } }))] });
    expect(cumulativeTurnWaitingMs([turnA, missing, turnC], 2)).toBe(9_000);
  });

  it('returns null when no included turn has a duration or when input is empty/negative index', () => {
    const missing = turn({ id: 'gap', events: [] });
    expect(cumulativeTurnWaitingMs([missing], 0)).toBeNull();
    expect(cumulativeTurnWaitingMs([], 0)).toBeNull();
    expect(cumulativeTurnWaitingMs([turnA], -1)).toBeNull();
  });
});

describe('cumulativeTurnElapsedMs', () => {
  const turnA = turn({
    id: 'a',
    prompt: item(ev({ type: 'prompt', ts: 1_000, sender: 'user', payload: { text: 'a' } })),
    events: [item(ev({ type: 'message', ts: 2_000, payload: { chunk: 'a', final: true } }))],
  });
  const turnB = turn({
    id: 'b',
    prompt: item(ev({ type: 'prompt', ts: 10_000, sender: 'user', payload: { text: 'b' } })),
    events: [item(ev({ type: 'message', ts: 13_000, payload: { chunk: 'b', final: true } }))],
  });
  const turnC = turn({
    id: 'c',
    prompt: item(ev({ type: 'prompt', ts: 20_000, sender: 'user', payload: { text: 'c' } })),
    events: [item(ev({ type: 'message', ts: 20_500, payload: { chunk: 'c', final: true } }))],
  });

  it('equals the first turn duration at index 0', () => {
    expect(cumulativeTurnElapsedMs([turnA, turnB], 0)).toBe(1_000);
  });

  it('sums every turn up to the given index', () => {
    // 1000 + 3000 + 500
    expect(cumulativeTurnElapsedMs([turnA, turnB, turnC], 2)).toBe(4_500);
  });

  it('stops at the given index rather than the whole conversation', () => {
    expect(cumulativeTurnElapsedMs([turnA, turnB, turnC], 1)).toBe(4_000);
  });

  it('skips turns that have no measurable duration', () => {
    const missing = turn({ id: 'gap', events: [item(ev({ type: 'message', ts: 9_000, payload: { chunk: 'x', final: true } }))] });
    expect(cumulativeTurnElapsedMs([turnA, missing, turnB], 2)).toBe(4_000);
  });

  it('applies liveNow only to the last included turn', () => {
    const live = turn({
      id: 'live',
      prompt: item(ev({ type: 'prompt', ts: 10_000, sender: 'user', payload: { text: 'live' } })),
      events: [item(ev({ type: 'message', ts: 10_200, payload: { chunk: '…', final: false } }))],
    });
    expect(cumulativeTurnElapsedMs([turnA, live], 1, 12_000)).toBe(3_000);
  });

  it('returns null when no included turn has a duration', () => {
    const missing = turn({ id: 'gap', events: [] });
    expect(cumulativeTurnElapsedMs([missing], 0)).toBeNull();
  });
});

describe('turnSubagentElapsedMs', () => {
  it('sums two result markers in one turn', () => {
    const t = turn({
      id: 't1',
      events: [
        spawnItem({ kind: 'result', childConversationId: 'a', durationMs: 1_000 }),
        spawnItem({ kind: 'result', childConversationId: 'b', durationMs: 2_500 }),
      ],
    });
    expect(turnSubagentElapsedMs(t)).toBe(3_500);
  });

  it('counts stalled and ignores spawned and heartbeat', () => {
    const t = turn({
      id: 't1',
      events: [
        spawnItem({ kind: 'spawned', childConversationId: 'a', durationMs: 9_999 }),
        spawnItem({ kind: 'heartbeat', childConversationId: 'b', durationMs: 9_999 }),
        spawnItem({ kind: 'stalled', childConversationId: 'c', durationMs: 4_000 }),
      ],
    });
    expect(turnSubagentElapsedMs(t)).toBe(4_000);
  });

  it('skips denied and expired markers with empty child ids and no duration', () => {
    const t = turn({
      id: 't1',
      events: [
        spawnItem({ kind: 'denied', childConversationId: '' }),
        spawnItem({ kind: 'expired', childConversationId: '' }),
        spawnItem({ kind: 'result', childConversationId: 'ok', durationMs: 800 }),
      ],
    });
    expect(turnSubagentElapsedMs(t)).toBe(800);
  });

  it('counts a duplicate childConversationId once (last terminal marker wins)', () => {
    const t = turn({
      id: 't1',
      events: [
        spawnItem({ kind: 'result', childConversationId: 'same', durationMs: 1_000 }),
        spawnItem({ kind: 'stalled', childConversationId: 'same', durationMs: 2_500 }),
      ],
    });
    expect(turnSubagentElapsedMs(t)).toBe(2_500);
  });

  it('returns null when the turn has no terminal spawn markers', () => {
    const t = turn({
      id: 't1',
      events: [
        item(ev({ type: 'message', payload: { chunk: 'plain', final: true } })),
        spawnItem({ kind: 'spawned', childConversationId: 'a' }),
      ],
    });
    expect(turnSubagentElapsedMs(t)).toBeNull();
  });
});

describe('cumulativeSubagentElapsedMs', () => {
  const turnA = turn({
    id: 'a',
    events: [spawnItem({ kind: 'result', childConversationId: 'a1', durationMs: 1_000 })],
  });
  const turnB = turn({
    id: 'b',
    events: [
      spawnItem({ kind: 'result', childConversationId: 'b1', durationMs: 2_000 }),
      spawnItem({ kind: 'stalled', childConversationId: 'b2', durationMs: 500 }),
    ],
  });
  const turnC = turn({
    id: 'c',
    events: [item(ev({ type: 'message', payload: { chunk: 'no spawn', final: true } }))],
  });
  const turnD = turn({
    id: 'd',
    events: [spawnItem({ kind: 'result', childConversationId: 'd1', durationMs: 3_000 })],
  });

  it('sums across turns and honours upToIndex', () => {
    const turns = [turnA, turnB, turnC, turnD];
    expect(cumulativeSubagentElapsedMs(turns, 0)).toBe(1_000);
    expect(cumulativeSubagentElapsedMs(turns, 1)).toBe(3_500);
    expect(cumulativeSubagentElapsedMs(turns, 2)).toBe(3_500);
    expect(cumulativeSubagentElapsedMs(turns, 3)).toBe(6_500);
    expect(conversationSubagentTotalMs(turns)).toBe(6_500);
    expect(conversationSubagentTotalMs([])).toBeNull();
  });
});

describe('settled gaps', () => {
  it('excludes the gap after done (late idle when the session parks)', () => {
    const t = turn({
      id: 't',
      prompt: item(ev({ type: 'prompt', ts: 1_000 } as never)),
      events: [
        item(ev({ type: 'message', ts: 4_000 } as never)),
        item(ev({ type: 'status', ts: 5_000, payload: { status: 'done' } } as never)),
        item(ev({ type: 'status', ts: 50_000_000, payload: { status: 'idle' } } as never)),
      ],
    });
    expect(turnElapsedMs(t)).toBe(4_000);
    expect(turnWaitingMs(t)).toBe(0);
  });
  it('ignores helper events after done so elapsed time is unchanged', () => {
    const t = turn({
      id: 't',
      prompt: item(ev({ type: 'prompt', ts: 1_000 } as never)),
      events: [
        item(ev({ type: 'message', ts: 4_000 } as never)),
        item(ev({ type: 'status', ts: 5_000, payload: { status: 'done' } } as never)),
        item(ev({
          type: 'helper',
          ts: 15_000,
          payload: { taskId: 't1', label: 'Explore', description: 'x', status: 'running', startedAt: 2000 },
        } as never)),
      ],
    });
    expect(turnElapsedMs(t, 25_000)).toBe(4_000);
    expect(turnWaitingMs(t, 25_000)).toBe(0);
  });
  it('resumes counting when activity follows a settle', () => {
    const t = turn({
      id: 't',
      prompt: item(ev({ type: 'prompt', ts: 0 } as never)),
      events: [
        item(ev({ type: 'status', ts: 1_000, payload: { status: 'idle' } } as never)),
        item(ev({ type: 'status', ts: 9_000, payload: { status: 'running' } } as never)),
        item(ev({ type: 'message', ts: 10_000 } as never)),
      ],
    });
    expect(turnElapsedMs(t)).toBe(2_000);
  });
});

it('turnWaitingMs accrues live while a card is pending', () => {
  const t = turn({
    id: 't',
    prompt: item(ev({ type: 'prompt', ts: 0 } as never)),
    events: [item(ev({ type: 'interaction_request', ts: 1_000 } as never))],
  });
  expect(turnWaitingMs(t, 61_000)).toBe(60_000);
  expect(turnElapsedMs(t, 61_000)).toBe(1_000);
});
