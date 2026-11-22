import type { NormalisedEvent } from '@tierwyn/shared';
import type { MergedItem, PromptTurn } from './groupTurns.js';

/** Raw helper snapshot → launch coordinates. `mainAgentEvents` strips helpers from turns. */
export interface HelperFocusRef {
  taskId?: string;
  toolUseId?: string;
  sessionId?: string;
  ts?: number;
}

export function helperFocusById(events: readonly NormalisedEvent[]): ReadonlyMap<string, HelperFocusRef> {
  const map = new Map<string, HelperFocusRef>();
  for (const e of events) {
    if (e.type !== 'helper' || !e.id) continue;
    map.set(e.id, { taskId: e.payload.taskId, toolUseId: e.payload.toolUseId, sessionId: e.sessionId, ts: e.ts });
  }
  return map;
}

/**
 * FW-12: pure indexing for "find in transcript" and "jump to a search hit".
 *
 * Everything here works off the already-merged `turns` structure, never the DOM, so it is
 * testable under the web workspace's node-only Vitest. The DOM ids it produces mirror what
 * OutputPane/EventItem actually render:
 *   - turn container: `turn-${seq||ts}`  (groupTurns.groupIntoTurns → OutputPane:1126)
 *   - message card:   `event-${seq||ts}` (EventItem:299)
 * Prompts have no per-event id, so a prompt's target is its turn container.
 */
export interface FindTarget {
  /** Element to scroll to / flash. */
  domId: string;
  /** Enclosing turn — fallback when the card itself is not in the DOM (collapsed, hidden). */
  turnId: string;
  /** Plain text searched by findMatches (never rendered markdown/HTML). */
  text: string;
}

function eventDomId(item: MergedItem): string {
  return `event-${item.event.seq || item.event.ts}`;
}

function messageText(item: MergedItem): string {
  const ev = item.event;
  if (ev.type !== 'message') return '';
  // Spawn markers are cards, not prose; their body is not part of the transcript text.
  if (ev.payload.spawnMarker) return '';
  return typeof ev.payload.chunk === 'string' ? ev.payload.chunk : '';
}

function promptText(item: MergedItem): string {
  const ev = item.event;
  if (ev.type !== 'prompt') return '';
  if ((ev.payload as { source?: string }).source === 'subagent_notify') return '';
  return typeof ev.payload.text === 'string' ? ev.payload.text : '';
}

/** Searchable cards of the transcript, in document order. Prompts + messages only (FW-12). */
export function findTargets(turns: readonly PromptTurn[]): FindTarget[] {
  const out: FindTarget[] = [];
  for (const turn of turns) {
    if (turn.prompt) {
      const text = promptText(turn.prompt);
      if (text) out.push({ domId: turn.id, turnId: turn.id, text });
    }
    for (const m of turn.events) {
      const text = messageText(m);
      if (text) out.push({ domId: eventDomId(m), turnId: turn.id, text });
    }
  }
  return out;
}

/** Cards containing `query` (case-insensitive substring). Empty query = no matches.
 *  1/N is card-level. Phase 1 paints matches inside rendered markdown via
 *  `highlightMatches.ts` (code/mermaid/abc/KaTeX skipped, still counted here). */
export function findMatches(targets: readonly FindTarget[], query: string): FindTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return targets.filter((t) => t.text.toLowerCase().includes(q));
}

/** Wrapping step through `total` matches. -1 when there is nothing to step through. */
export function nextIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  return (((current + dir) % total) + total) % total;
}

/** Which DOM id to scroll/flash.
 *
 *  Card ids (`event-${seq||ts}`) collide across sessions because `events.seq` is
 *  per-session (adversary B1: 24% of prod indexed events). `getElementById` would
 *  silently pick the earliest duplicate. Unique card → that card; 0 or 2+ matches
 *  → the enclosing turn container (unique across the 25 largest prod transcripts).
 */
export function pickFlashDomId(
  target: { domId: string; turnId: string },
  cardCount: number,
): string {
  return cardCount === 1 ? target.domId : target.turnId;
}

/** Map a persisted events.id (from a search hit) onto the card that shows it.
 *  Streaming turns collapse into ONE card, so a mid-turn chunk id is matched via
 *  MergedItem.mergedIds. */
export const MAX_OCCURRENCES = 2000;

export type FindMode = 'substring' | 'words' | 'regex';

export interface FindOptions {
  mode?: FindMode;
  caseSensitive?: boolean;
}

export interface FindRange {
  start: number;
  end: number;
}

export interface FindMatcher {
  empty: boolean;
  error?: string;
  cardMatches(text: string): boolean;
  ranges(text: string): FindRange[];
}

const EMPTY_MATCHER: FindMatcher = {
  empty: true,
  cardMatches: () => false,
  ranges: () => [],
};

function indexOfRanges(text: string, needle: string, caseSensitive: boolean): FindRange[] {
  if (!needle) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  const out: FindRange[] = [];
  let from = 0;
  while (from <= hay.length - n.length && out.length < MAX_OCCURRENCES) {
    const i = hay.indexOf(n, from);
    if (i < 0) break;
    out.push({ start: i, end: i + n.length });
    from = i + n.length;
  }
  return out;
}

/** Leftmost, then longest. Overlapping multi-word hits collapse so CSS/HAST/overlay stay in sync. */
function collapseOverlaps(ranges: FindRange[]): FindRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: FindRange[] = [];
  let lastEnd = -1;
  for (const r of sorted) {
    if (r.start < lastEnd) continue;
    out.push(r);
    lastEnd = r.end;
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

function regexRanges(text: string, source: string, flags: string): FindRange[] {
  const re = new RegExp(source, flags);
  const out: FindRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < MAX_OCCURRENCES) {
    if (m[0].length === 0) {
      if (re.lastIndex >= text.length) break;
      re.lastIndex += 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function compileFindMatcher(query: string, opts?: FindOptions): FindMatcher {
  const mode = opts?.mode ?? 'substring';
  const caseSensitive = !!opts?.caseSensitive;
  if (!query.trim()) return EMPTY_MATCHER;

  if (mode === 'regex') {
    const flags = caseSensitive ? 'g' : 'gi';
    try {
      void new RegExp(query, flags);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ...EMPTY_MATCHER, error: `Invalid regex: ${msg}` };
    }
    return {
      empty: false,
      cardMatches: (text) => regexRanges(text, query, flags).length > 0,
      ranges: (text) => regexRanges(text, query, flags),
    };
  }

  if (mode === 'words') {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return EMPTY_MATCHER;
    return {
      empty: false,
      cardMatches(text) {
        const hay = caseSensitive ? text : text.toLowerCase();
        return terms.every((t) => hay.includes(caseSensitive ? t : t.toLowerCase()));
      },
      ranges(text) {
        const all: FindRange[] = [];
        for (const t of terms) all.push(...indexOfRanges(text, t, caseSensitive));
        return collapseOverlaps(all);
      },
    };
  }

  const needle = query.trim();
  return {
    empty: false,
    cardMatches(text) {
      const hay = caseSensitive ? text : text.toLowerCase();
      const n = caseSensitive ? needle : needle.toLowerCase();
      return hay.includes(n);
    },
    ranges: (text) => indexOfRanges(text, needle, caseSensitive),
  };
}

export type FindRole = 'user' | 'agent';

export interface FindOccurrence {
  /** Stable key for React list rendering: `${cardKey}:${matchIndexInCard}` */
  id: string;
  /** Unique DOM attribute value matching `[data-find-card="..."]`. */
  cardKey: string;
  /** Legacy card DOM id (`turn-...` or `event-...`) for fallback. */
  domId: string;
  /** Enclosing turn id (`turn-...`), used to auto-expand collapsed turns. */
  turnId: string;
  /** 1-based turn index in the loaded `turns` array (for display: `T#3`). */
  turnNumber: number;
  role: FindRole;
  /** 0-based index of this occurrence within its card's plain text. */
  matchIndexInCard: number;
  /** Character offset in the card's plain text. */
  charOffset: number;
  snippetBefore: string;
  matchText: string;
  snippetAfter: string;
}

export function extractSnippet(
  text: string,
  start: number,
  length: number,
  opts?: { beforeChars?: number; afterChars?: number },
): { snippetBefore: string; matchText: string; snippetAfter: string } {
  const beforeChars = opts?.beforeChars ?? 36;
  const afterChars = opts?.afterChars ?? 48;
  const matchText = text.slice(start, start + length);
  const from = Math.max(0, start - beforeChars);
  const to = Math.min(text.length, start + length + afterChars);
  let before = text.slice(from, start);
  let after = text.slice(start + length, to);
  const clippedBefore = from > 0;
  const clippedAfter = to < text.length;
  if (clippedBefore) {
    const startedMidWord = !/\s/.test(text[from] ?? '') && /\S/.test(text[from - 1] ?? '');
    if (startedMidWord) {
      const cut = before.search(/\s/);
      if (cut >= 0) before = before.slice(cut);
    }
  }
  if (clippedAfter) {
    const endedMidWord = !/\s/.test(text[to - 1] ?? '') && /\S/.test(text[to] ?? '');
    if (endedMidWord) {
      const lastWs = after.search(/\s\S*$/);
      if (lastWs >= 0) after = after.slice(0, lastWs);
    }
  }
  before = before.replace(/\s+/g, ' ');
  after = after.replace(/\s+/g, ' ');
  if (clippedBefore) before = `…${before.trimStart()}`;
  if (clippedAfter) after = `${after.trimEnd()}…`;
  return { snippetBefore: before, matchText, snippetAfter: after };
}

function resolvedMessageText(
  item: MergedItem,
  eventIdx: number,
  editedChunks?: Readonly<Record<string, string>>,
): string {
  const ev = item.event;
  if (ev.type !== 'message') return '';
  if (ev.payload.spawnMarker) return '';
  if ((ev.payload as { recalledMemories?: unknown }).recalledMemories) return '';
  const seqOrTs = ev.seq || ev.ts;
  if (editedChunks) {
    const direct = editedChunks[`event-${seqOrTs}`];
    if (direct !== undefined) return direct;
    const group = editedChunks[`g${eventIdx}-${seqOrTs}`];
    if (group !== undefined) return group;
    for (const [k, v] of Object.entries(editedChunks)) {
      if (k.endsWith(`-${seqOrTs}`)) return v;
    }
  }
  return typeof ev.payload.chunk === 'string' ? ev.payload.chunk : '';
}

function emitOccurrences(
  out: FindOccurrence[],
  text: string,
  matcher: FindMatcher,
  meta: Omit<FindOccurrence, 'id' | 'matchIndexInCard' | 'charOffset' | 'snippetBefore' | 'matchText' | 'snippetAfter'>,
): void {
  if (matcher.empty || !matcher.cardMatches(text)) return;
  let matchIndexInCard = 0;
  for (const r of matcher.ranges(text)) {
    if (out.length >= MAX_OCCURRENCES) return;
    const length = r.end - r.start;
    const snip = extractSnippet(text, r.start, length);
    out.push({
      ...meta,
      id: `${meta.cardKey}:${matchIndexInCard}`,
      matchIndexInCard,
      charOffset: r.start,
      matchText: text.slice(r.start, r.end),
      snippetBefore: snip.snippetBefore,
      snippetAfter: snip.snippetAfter,
    });
    matchIndexInCard += 1;
  }
}

export function findOccurrences(
  turns: readonly PromptTurn[],
  query: string,
  editedChunks?: Readonly<Record<string, string>>,
  opts?: FindOptions,
): FindOccurrence[] {
  const matcher = compileFindMatcher(query, opts);
  if (matcher.empty) return [];
  const out: FindOccurrence[] = [];
  for (let turnIdx = 0; turnIdx < turns.length && out.length < MAX_OCCURRENCES; turnIdx++) {
    const turn = turns[turnIdx]!;
    const turnNumber = turnIdx + 1;
    if (turn.prompt) {
      const text = promptText(turn.prompt);
      if (text) {
        emitOccurrences(out, text, matcher, {
          cardKey: `${turn.id}:prompt`,
          domId: turn.id,
          turnId: turn.id,
          turnNumber,
          role: 'user',
        });
      }
    }
    for (let eventIdx = 0; eventIdx < turn.events.length && out.length < MAX_OCCURRENCES; eventIdx++) {
      const item = turn.events[eventIdx]!;
      const text = resolvedMessageText(item, eventIdx, editedChunks);
      if (!text) continue;
      emitOccurrences(out, text, matcher, {
        cardKey: `${turn.id}:g${eventIdx}`,
        domId: eventDomId(item),
        turnId: turn.id,
        turnNumber,
        role: 'agent',
      });
    }
  }
  return out;
}

function turnSessionIds(turn: PromptTurn): string[] {
  const out: string[] = [];
  if (turn.prompt?.event.sessionId) out.push(turn.prompt.event.sessionId);
  for (const m of turn.events) {
    if (m.event.sessionId) out.push(m.event.sessionId);
  }
  return out;
}

function turnTimeRange(turn: PromptTurn): { min: number; max: number } | null {
  const times: number[] = [];
  if (turn.prompt) times.push(turn.prompt.event.ts);
  for (const m of turn.events) times.push(m.event.ts);
  if (times.length === 0) return null;
  return { min: Math.min(...times), max: Math.max(...times) };
}

export function resolveFocusTarget(
  turns: readonly PromptTurn[],
  eventId: string | null | undefined,
  helpers?: ReadonlyMap<string, HelperFocusRef>,
): { domId: string; turnId: string } | null {
  if (!eventId) return null;
  const holds = (item: MergedItem) =>
    item.event.id === eventId || (item.mergedIds?.includes(eventId) ?? false);
  for (const turn of turns) {
    if (turn.prompt && holds(turn.prompt)) return { domId: turn.id, turnId: turn.id };
    for (const m of turn.events) {
      if (holds(m)) return { domId: `event-${m.event.seq || m.event.ts}`, turnId: turn.id };
    }
  }
  const helper = helpers?.get(eventId);
  if (!helper) return null;
  if (helper.toolUseId) {
    for (const turn of turns) {
      for (const m of turn.events) {
        if (m.event.type === 'tool_call' && m.event.payload.toolUseId === helper.toolUseId) {
          return { domId: `event-${m.event.seq || m.event.ts}`, turnId: turn.id };
        }
      }
    }
  }
  const candidates = turns.filter((t) => helper.sessionId && turnSessionIds(t).includes(helper.sessionId));
  const covering = helper.ts != null
    ? candidates.find((t) => {
        const r = turnTimeRange(t);
        return r != null && helper.ts! >= r.min && helper.ts! <= r.max;
      })
    : undefined;
  const turn = covering ?? candidates[0];
  return turn ? { domId: turn.id, turnId: turn.id } : null;
}
