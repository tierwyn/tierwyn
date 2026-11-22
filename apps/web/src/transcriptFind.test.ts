import { describe, it, expect } from 'vitest';
import type { NormalisedEvent } from '@tierwyn/shared';
import type { MergedItem, PromptTurn } from './groupTurns.js';
import { groupIntoTurns, mergeMessageChunks } from './groupTurns.js';
import { mainAgentEvents } from './subagents.js';
import { compileFindMatcher, extractSnippet, findMatches, findOccurrences, findTargets, helperFocusById, nextIndex, pickFlashDomId, resolveFocusTarget } from './transcriptFind.js';

function ev(partial: Partial<NormalisedEvent> & Pick<NormalisedEvent, 'type'>): NormalisedEvent {
  return { sessionId: 'sess-1', seq: 1, ts: 1000, sender: 'agent', ...partial } as NormalisedEvent;
}

function item(event: NormalisedEvent, mergedIds?: string[]): MergedItem {
  return { event, mergedIds: mergedIds ?? (event.id ? [event.id] : []) };
}

/** Two turns: prompt+reply, prompt+reply. Reply 2 is a merged streaming turn. */
function fixture(): PromptTurn[] {
  const p1 = ev({ type: 'prompt', id: 'p1', seq: 1, sender: 'user', payload: { text: 'ship the Marmalade parser' } });
  const m1 = ev({ type: 'message', id: 'm1', seq: 2, payload: { chunk: 'parser shipped', final: true } });
  const p2 = ev({ type: 'prompt', id: 'p2', seq: 3, sender: 'user', payload: { text: 'now the chutney' } });
  const m2 = ev({ type: 'message', id: 'm2c', seq: 6, payload: { chunk: 'chutney is ready', final: true } });
  return [
    { id: 'turn-1', prompt: item(p1), events: [item(m1)] },
    { id: 'turn-3', prompt: item(p2), events: [item(m2, ['m2a', 'm2b', 'm2c'])] },
  ];
}

describe('findTargets', () => {
  it('lists prompts as their turn container and messages as their event card, in order', () => {
    expect(findTargets(fixture()).map((t) => t.domId))
      .toEqual(['turn-1', 'event-2', 'turn-3', 'event-6']);
  });

  it('skips subagent_notify prompts (OutputPane does not render them)', () => {
    const hidden = ev({ type: 'prompt', id: 'pn', seq: 9, sender: 'user', payload: { text: 'marmalade notify', source: 'subagent_notify' } });
    const turns: PromptTurn[] = [{ id: 'turn-9', prompt: item(hidden), events: [] }];
    expect(findTargets(turns)).toEqual([]);
  });

  it('skips tool calls, tool results and file changes', () => {
    const tool = ev({ type: 'tool_call', id: 't1', seq: 4, payload: { toolUseId: 'tu1', name: 'shell', input: { command: 'marmalade' } } });
    const turns: PromptTurn[] = [{ id: 'turn-4', events: [item(tool)] }];
    expect(findTargets(turns)).toEqual([]);
  });
});

describe('findMatches', () => {
  const targets = findTargets(fixture());

  it('is case-insensitive', () => {
    expect(findMatches(targets, 'marmalade').map((t) => t.domId)).toEqual(['turn-1']);
    expect(findMatches(targets, 'MARMALADE').map((t) => t.domId)).toEqual(['turn-1']);
  });

  it('returns every matching card in document order', () => {
    expect(findMatches(targets, 'chutney').map((t) => t.domId)).toEqual(['turn-3', 'event-6']);
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(findMatches(targets, '')).toEqual([]);
    expect(findMatches(targets, '   ')).toEqual([]);
  });

  it('returns nothing when there is no transcript', () => {
    expect(findMatches([], 'marmalade')).toEqual([]);
  });
});

describe('nextIndex', () => {
  it('wraps forward from the last match to the first', () => {
    expect(nextIndex(2, 3, 1)).toBe(0);
  });

  it('wraps backward from the first match to the last', () => {
    expect(nextIndex(0, 3, -1)).toBe(2);
  });

  it('steps normally in the middle', () => {
    expect(nextIndex(0, 3, 1)).toBe(1);
    expect(nextIndex(2, 3, -1)).toBe(1);
  });

  it('returns -1 when there is nothing to step through', () => {
    expect(nextIndex(0, 0, 1)).toBe(-1);
    expect(nextIndex(0, 0, -1)).toBe(-1);
  });
});

describe('resolveFocusTarget', () => {
  const turns = fixture();

  it('resolves a prompt id to its turn container', () => {
    expect(resolveFocusTarget(turns, 'p2')).toEqual({ domId: 'turn-3', turnId: 'turn-3' });
  });

  it('resolves a message id to its event card', () => {
    expect(resolveFocusTarget(turns, 'm1')).toEqual({ domId: 'event-2', turnId: 'turn-1' });
  });

  it('resolves a mid-turn streaming chunk id through mergedIds', () => {
    // D3: FTS indexes the last chunk (backfill) or the final terminator (live trigger);
    // both live in the same merged card.
    expect(resolveFocusTarget(turns, 'm2a')).toEqual({ domId: 'event-6', turnId: 'turn-3' });
  });

  it('returns null for a missing, empty or unknown id', () => {
    expect(resolveFocusTarget(turns, undefined)).toBeNull();
    expect(resolveFocusTarget(turns, null)).toBeNull();
    expect(resolveFocusTarget(turns, '')).toBeNull();
    expect(resolveFocusTarget(turns, 'nope')).toBeNull();
  });

  it('resolves a helper eventId to its launching tool_call card through mainAgentEvents', () => {
    const prompt = ev({ type: 'prompt', id: 'p-h', seq: 1, sender: 'user', payload: { text: 'look around' } });
    const tool = ev({ type: 'tool_call', id: 'tc1', seq: 10, payload: { toolUseId: 'tu-h', name: 'Agent', input: { description: 'list files' } } });
    const helper = ev({
      type: 'helper', id: 'h1', seq: 11,
      payload: { taskId: 't1', toolUseId: 'tu-h', label: 'Explore', description: 'list files', status: 'completed', startedAt: 1 },
    });
    const events = [prompt, tool, helper];
    const turns = groupIntoTurns(mergeMessageChunks(mainAgentEvents(events)));
    expect(turns.some((t) => t.events.some((m) => m.event.type === 'helper'))).toBe(false);
    expect(resolveFocusTarget(turns, 'h1', helperFocusById(events))).toEqual({
      domId: 'event-10',
      turnId: 'turn-1',
    });
  });

  it('falls back to the enclosing turn when the helper has no launching tool_call', () => {
    const prompt = ev({ type: 'prompt', id: 'p-h2', seq: 1, sender: 'user', payload: { text: 'go' } });
    const helper = ev({
      type: 'helper', id: 'h2', seq: 12, ts: 1000,
      payload: { taskId: 't2', label: 'Explore', description: 'gone', status: 'completed', startedAt: 1 },
    });
    const events = [prompt, helper];
    const turns = groupIntoTurns(mergeMessageChunks(mainAgentEvents(events)));
    expect(resolveFocusTarget(turns, 'h2', helperFocusById(events))).toEqual({
      domId: 'turn-1',
      turnId: 'turn-1',
    });
  });
});

describe('pickFlashDomId', () => {
  const t = { domId: 'event-2', turnId: 'turn-1' };

  it('uses the card when its id is unique', () => {
    expect(pickFlashDomId(t, 1)).toBe('event-2');
  });

  it('falls back to the turn when the card id is duplicated (B1)', () => {
    expect(pickFlashDomId(t, 2)).toBe('turn-1');
    expect(pickFlashDomId(t, 40)).toBe('turn-1');
  });

  it('falls back to the turn when the card is not in the DOM', () => {
    expect(pickFlashDomId(t, 0)).toBe('turn-1');
  });
});

describe('extractSnippet', () => {
  it('returns surrounding context and the original match text', () => {
    const s = extractSnippet('the quick brown fox jumps', 10, 5, { beforeChars: 6, afterChars: 6 });
    expect(s.matchText).toBe('brown');
    expect(s.snippetBefore).toContain('quick');
    expect(s.snippetAfter).toContain('fox');
  });

  it('collapses whitespace in before/after and ellipsizes when clipped', () => {
    const text = `${'word '.repeat(20)}HIT${' word'.repeat(20)}`;
    const start = text.indexOf('HIT');
    const s = extractSnippet(text, start, 3, { beforeChars: 10, afterChars: 10 });
    expect(s.snippetBefore.startsWith('…')).toBe(true);
    expect(s.snippetAfter.endsWith('…')).toBe(true);
    expect(s.snippetBefore).not.toMatch(/\s{2,}/);
    expect(s.snippetAfter).not.toMatch(/\s{2,}/);
  });
});

describe('findOccurrences', () => {
  it('emits one occurrence per match, including multiple in one card', () => {
    const turns = fixture();
    const hits = findOccurrences(turns, 'e');
    expect(hits.length).toBeGreaterThan(1);
    const promptHits = hits.filter((h) => h.cardKey === 'turn-1:prompt');
    expect(promptHits.length).toBeGreaterThan(1);
    expect(promptHits.map((h) => h.matchIndexInCard)).toEqual(promptHits.map((_, i) => i));
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });

  it('is case-insensitive and preserves original match casing', () => {
    const hits = findOccurrences(fixture(), 'MARMALADE');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchText).toBe('Marmalade');
    expect(hits[0]!.role).toBe('user');
    expect(hits[0]!.turnNumber).toBe(1);
    expect(hits[0]!.cardKey).toBe('turn-1:prompt');
  });

  it('skips subagent_notify, spawnMarker, and recalledMemories', () => {
    const hidden = ev({ type: 'prompt', id: 'pn', seq: 9, sender: 'user', payload: { text: 'marmalade notify', source: 'subagent_notify' } });
    const spawn = ev({ type: 'message', id: 'ms', seq: 10, payload: { chunk: 'marmalade', spawnMarker: { kind: 'spawned', childConversationId: 'c', text: 'x' } } });
    const recall = ev({ type: 'message', id: 'mr', seq: 11, payload: { chunk: 'marmalade', recalledMemories: ['m_1'] } });
    const turns: PromptTurn[] = [
      { id: 'turn-9', prompt: item(hidden), events: [item(spawn), item(recall)] },
    ];
    expect(findOccurrences(turns, 'marmalade')).toEqual([]);
  });

  it('uses editedChunks override for the card text', () => {
    const turns = fixture();
    const hits = findOccurrences(turns, 'rewritten', { 'event-2': 'rewritten marmalade' });
    expect(hits.map((h) => h.cardKey)).toEqual(['turn-1:g0']);
    expect(hits[0]!.matchText).toBe('rewritten');
  });

  it('treats regex metacharacters as literals', () => {
    const p = ev({ type: 'prompt', id: 'p', seq: 1, sender: 'user', payload: { text: 'foo.bar (a+b) [test]' } });
    const turns: PromptTurn[] = [{ id: 'turn-1', prompt: item(p), events: [] }];
    expect(findOccurrences(turns, 'foo.bar')).toHaveLength(1);
    expect(findOccurrences(turns, 'fooXbar')).toHaveLength(0);
    expect(findOccurrences(turns, '(a+b)')).toHaveLength(1);
    expect(findOccurrences(turns, '[test]')).toHaveLength(1);
  });

  it('returns nothing for an empty query', () => {
    expect(findOccurrences(fixture(), '')).toEqual([]);
    expect(findOccurrences(fixture(), '   ')).toEqual([]);
  });

  it('matches a card only when every word is present (words mode)', () => {
    const hits = findOccurrences(fixture(), 'marmalade parser', undefined, { mode: 'words' });
    expect(hits.every((h) => h.cardKey === 'turn-1:prompt')).toBe(true);
    expect(hits.map((h) => h.matchText.toLowerCase()).sort()).toEqual(['marmalade', 'parser']);
  });

  it('does not match a card that has only one of two words', () => {
    const hits = findOccurrences(fixture(), 'parser chutney', undefined, { mode: 'words' });
    expect(hits).toEqual([]);
  });

  it('lists multi-word occurrences in document order by charOffset', () => {
    const hits = findOccurrences(fixture(), 'parser marmalade', undefined, { mode: 'words' });
    expect(hits.map((h) => h.matchText.toLowerCase())).toEqual(['marmalade', 'parser']);
    const offsets = hits.map((h) => h.charOffset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('matches regex patterns', () => {
    const hits = findOccurrences(fixture(), 'chutn[aeiou]y', undefined, { mode: 'regex' });
    expect(hits.map((h) => h.matchText)).toEqual(['chutney', 'chutney']);
    expect(hits.map((h) => h.cardKey)).toEqual(['turn-3:prompt', 'turn-3:g0']);
  });

  it('returns empty results for invalid regex without throwing', () => {
    expect(() => findOccurrences(fixture(), '[', undefined, { mode: 'regex' })).not.toThrow();
    expect(findOccurrences(fixture(), '[', undefined, { mode: 'regex' })).toEqual([]);
    expect(compileFindMatcher('[', { mode: 'regex' }).error).toMatch(/^Invalid regex:/);
  });

  it('terminates on zero-length regex matches like ^ and a*', () => {
    expect(compileFindMatcher('^', { mode: 'regex' }).ranges('hello')).toEqual([]);
    const star = compileFindMatcher('a*', { mode: 'regex' }).ranges('aaa');
    expect(star.every((r) => r.end > r.start)).toBe(true);
    expect(star).toEqual([{ start: 0, end: 3 }]);
    expect(findOccurrences(fixture(), '^', undefined, { mode: 'regex' })).toEqual([]);
  });

  it('respects caseSensitive across substring, words, and regex', () => {
    expect(findOccurrences(fixture(), 'marmalade', undefined, { caseSensitive: true })).toEqual([]);
    expect(findOccurrences(fixture(), 'Marmalade', undefined, { caseSensitive: true })).toHaveLength(1);
    expect(findOccurrences(fixture(), 'marmalade parser', undefined, { mode: 'words', caseSensitive: true })).toEqual([]);
    expect(findOccurrences(fixture(), 'Marmalade parser', undefined, { mode: 'words', caseSensitive: true }).map((h) => h.matchText))
      .toEqual(['Marmalade', 'parser']);
    expect(findOccurrences(fixture(), 'MARMALADE', undefined, { mode: 'regex', caseSensitive: true })).toEqual([]);
    expect(findOccurrences(fixture(), 'Marmalade', undefined, { mode: 'regex', caseSensitive: true })).toHaveLength(1);
  });
});

describe('compileFindMatcher', () => {
  it('is empty for whitespace queries', () => {
    expect(compileFindMatcher('').empty).toBe(true);
    expect(compileFindMatcher('   ').empty).toBe(true);
    expect(compileFindMatcher('   ', { mode: 'regex' }).empty).toBe(true);
  });
});
