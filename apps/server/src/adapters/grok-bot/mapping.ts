/**
 * Grok Bot replica entries → NormalisedEvent (entry-level).
 * User `message` rows are skipped unless `opts.includeUser` (watcher path) — the live
 * adapter must not emit them because Tierwyn already persisted the prompt.
 * Approval cards (DOM, not replica) map separately via mapApprovalDelta.
 */
import { fileFallbackText, type InteractionChoice, type NormalisedEvent } from '@tierwyn/shared';
import { APPROVAL_CHOICES } from './selectors.js';

const BOX_FILE_PREFIX = 'file:///home/box/';

/** sandboxUrl is server-side only — resolveSandboxMedia strips it before persist. */
type MappedAttachmentFile = {
  name: string;
  mediaType: string;
  status: 'unavailable';
  sandboxUrl?: string;
};

function basenameFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const base = p.split('/').filter(Boolean).pop();
    return base && base.trim() ? base : 'file';
  } catch {
    return 'file';
  }
}

function mapAttachmentEntry(entry: ReplicaEntry): PartialEvent {
  const url = typeof entry.message?.url === 'string' ? entry.message.url : '';
  const rawName = entry.message?.file_name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName : basenameFromUrl(url);
  const file: MappedAttachmentFile = {
    name,
    mediaType: 'application/octet-stream',
    status: 'unavailable',
  };
  if (url.startsWith(BOX_FILE_PREFIX)) file.sandboxUrl = url;
  return {
    type: 'message',
    payload: { chunk: fileFallbackText([file]), final: true, files: [file] },
  };
}

export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

export interface ReplicaWidgetOption {
  label?: string;
  value?: string;
  style?: string;
  description?: string;
}

export interface ReplicaWidget {
  prompt?: string;
  helpText?: string;
  options?: ReplicaWidgetOption[];
  allowCustom?: boolean;
  dismissOnMoveOn?: boolean;
}

export interface ReplicaEntry {
  id: string;
  kind: string;
  role?: string;
  content?: string;
  isStreaming?: boolean;
  message?: {
    type?: string;
    content?: unknown;
    images?: unknown;
    /** Live app shape for option / onboarding cards (not `content`). */
    widget?: ReplicaWidget;
    /** Bot-sent file (type === 'attachment'). */
    url?: string;
    file_name?: string;
    alt?: string;
  };
  timestampMs?: number;
  requestId?: string;
  clientNonce?: string;
  /** Set when the operator (or Tierwyn) picked an option. */
  respondedValue?: unknown;
  /** Set when the widget was dismissed / skipped without a value. */
  widgetSkipped?: boolean;
}

export function unwrapSlice<T = unknown>(raw: unknown): T {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return v as T; }
  }
  if (v && typeof v === 'object' && 'value' in v && 'schemaVersion' in v) {
    return unwrapSlice<T>((v as { value: unknown }).value);
  }
  return v as T;
}

export function replicaEntries(raw: unknown): ReplicaEntry[] {
  const v = unwrapSlice<Record<string, unknown>>(raw);
  const entries = v?.entries;
  return Array.isArray(entries) ? [...(entries as ReplicaEntry[])] : [];
}

/** True when the replica slice is unparseable or `entries` is not an array.
 *  Distinguishes "no news" / empty from a malformed read that must not advance a cursor. */
export function replicaEnvelopeMalformed(raw: unknown): boolean {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return true; }
  }
  if (v && typeof v === 'object' && 'value' in v && 'schemaVersion' in v) {
    return replicaEnvelopeMalformed((v as { value: unknown }).value);
  }
  if (v == null || typeof v !== 'object') return true;
  return !Array.isArray((v as { entries?: unknown }).entries);
}

export function textFromEntry(entry: ReplicaEntry): string {
  if (entry.kind === 'message' && typeof entry.content === 'string') return entry.content;
  const msg = entry.message;
  if (!msg) return '';
  if (msg.type === 'text' && typeof msg.content === 'string') return msg.content;
  if (msg.type === 'widget') {
    const livePrompt = msg.widget?.prompt;
    if (typeof livePrompt === 'string' && livePrompt.trim()) return `[widget] ${livePrompt.trim()}`;
    const c = msg.content;
    if (c && typeof c === 'object' && 'title' in c && typeof (c as { title: unknown }).title === 'string') {
      return `[widget] ${(c as { title: string }).title}`;
    }
    return '[widget]';
  }
  if (typeof msg.content === 'string') return msg.content;
  return '';
}

/** Computer-use screenshots and fetched media ride along on the same send-message
 *  entry as `message.images: [{url: 'file:///home/box/…', alt, width, height}]`.
 *  The file lives inside the Grok Bot sandbox, not on this host — the URL is only
 *  useful as a handle for window.desktop.resolveAttachmentMedia (see bridge.ts). */
export function imagesFromEntry(entry: ReplicaEntry): { url: string; alt: string }[] {
  const raw = entry.message?.images;
  if (!Array.isArray(raw)) return [];
  const out: { url: string; alt: string }[] = [];
  for (const img of raw) {
    const url = (img as { url?: unknown })?.url;
    if (typeof url !== 'string' || !url) continue;
    const alt = (img as { alt?: unknown })?.alt;
    out.push({ url, alt: typeof alt === 'string' ? alt : 'image' });
  }
  return out;
}

export function normaliseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The app's replica stores the user echo with newlines collapsed to spaces (and may
 *  truncate long text), so a raw `content.includes(prompt)` never matches a multi-line
 *  prompt. Compare a whitespace-normalised head of both instead. */
export function entryEchoesPrompt(entry: ReplicaEntry, prompt: string): boolean {
  if (entry.kind !== 'message' || entry.role !== 'user') return false;
  const echo = normaliseWhitespace(
    typeof entry.content === 'string' ? entry.content : textFromEntry(entry),
  );
  const want = normaliseWhitespace(prompt);
  if (!echo || !want) return false;
  const n = Math.min(64, echo.length, want.length);
  return echo.slice(0, n) === want.slice(0, n);
}

export interface MapOpts {
  /** Watcher-only: replica user rows (app / phone / web) become `prompt` events.
   *  The live adapter must NOT set this — sessionManager already persisted its own
   *  prompt and a second copy would double the turn. */
  includeUser?: boolean;
}

export function mapReplicaDelta(
  entries: ReplicaEntry[],
  seen: Set<string>,
  opts: MapOpts = {},
): PartialEvent[] {
  const out: PartialEvent[] = [];
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.kind === 'message') {
      if (!opts.includeUser || entry.role !== 'user') continue;
      const text = textFromEntry(entry).trim();
      if (!text) continue;
      out.push({ type: 'prompt', payload: { text } });
      continue;
    }
    if (entry.kind !== 'send-message') continue;
    // Option / onboarding cards are interaction_request via openReplicaWidgetsToCards.
    if (entry.message?.type === 'widget') continue;
    if (entry.message?.type === 'attachment') {
      out.push(mapAttachmentEntry(entry));
      continue;
    }
    const images = imagesFromEntry(entry);
    const md = images.map((i) => `![${i.alt.replace(/[[\]]/g, '')}](${i.url})`).join('\n\n');
    const chunk = [textFromEntry(entry), md].filter(Boolean).join('\n\n');
    if (!chunk) continue;
    out.push({ type: 'message', payload: { chunk, final: true } });
  }
  return out;
}

const WIDGET_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Stable requestId for a replica widget entry — answer path remaps to the live DOM stamp. */
export function widgetCardId(entryId: string): string {
  return `gbw-${entryId}`;
}

export function isOpenWidget(entry: ReplicaEntry): boolean {
  return entry.kind === 'send-message'
    && entry.message?.type === 'widget'
    && entry.respondedValue == null
    && !entry.widgetSkipped
    && typeof entry.id === 'string'
    && entry.id.length > 0;
}

/**
 * Open replica widgets → QuestionCard[] for mapQuestionDelta.
 * Letter ids match the app's "A Label" DOM buttons so idle answers can click by id.
 */
export function openReplicaWidgetsToCards(entries: ReplicaEntry[]): QuestionCard[] {
  const out: QuestionCard[] = [];
  for (const entry of entries) {
    if (!isOpenWidget(entry)) continue;
    const w = entry.message?.widget;
    const prompt = typeof w?.prompt === 'string' ? w.prompt.trim() : '';
    if (!prompt) continue;
    const options = Array.isArray(w?.options) ? w.options : [];
    const choices: InteractionChoice[] = [];
    for (let i = 0; i < options.length && i < WIDGET_LETTERS.length; i++) {
      const label = typeof options[i]?.label === 'string' ? options[i]!.label!.trim() : '';
      const letter = WIDGET_LETTERS[i]!;
      choices.push({ id: letter, label: label ? `${letter} ${label}` : letter });
    }
    choices.push({ id: 'dismiss', label: 'Dismiss' });
    out.push({
      cardId: widgetCardId(entry.id),
      prompt,
      choices,
      allowFreeText: w?.allowCustom === true,
    });
  }
  return out;
}

export interface ApprovalCard {
  cardId: string;
  prompt: string;
  choices: InteractionChoice[];
}

export const DEFAULT_APPROVAL_CHOICES: InteractionChoice[] = APPROVAL_CHOICES.map((c) => ({
  id: c.id,
  label: c.label,
}));

/** New cards → interaction_request; disappearance → interaction_resolved auto
 *  (operator clicked in the app, or Auto Review fired). Mutates `pending`. */
export function mapApprovalDelta(cards: ApprovalCard[], pending: Set<string>): PartialEvent[] {
  const out: PartialEvent[] = [];
  const live = new Set(cards.map((c) => c.cardId).filter(Boolean));
  for (const card of cards) {
    if (!card.cardId || pending.has(card.cardId)) continue;
    pending.add(card.cardId);
    const choices = card.choices?.length ? card.choices : DEFAULT_APPROVAL_CHOICES;
    out.push({
      type: 'interaction_request',
      payload: {
        requestId: card.cardId,
        kind: 'permission',
        prompt: card.prompt || 'Grok Bot wants approval',
        choices,
        allowFreeText: false,
      },
    });
  }
  for (const id of [...pending]) {
    if (live.has(id)) continue;
    pending.delete(id);
    out.push({
      type: 'interaction_resolved',
      payload: { requestId: id, selection: [], resolution: 'auto' },
    });
  }
  return out;
}

export interface QuestionCard {
  cardId: string;
  prompt: string;
  choices: InteractionChoice[];
  allowFreeText?: boolean;
}

/** New onboarding/question cards → interaction_request kind=question;
 *  disappearance → interaction_resolved auto. Mutates `pending`. */
export function mapQuestionDelta(cards: QuestionCard[], pending: Set<string>): PartialEvent[] {
  const out: PartialEvent[] = [];
  const live = new Set(cards.map((c) => c.cardId).filter(Boolean));
  for (const card of cards) {
    if (!card.cardId || pending.has(card.cardId)) continue;
    pending.add(card.cardId);
    out.push({
      type: 'interaction_request',
      payload: {
        requestId: card.cardId,
        kind: 'question',
        prompt: card.prompt || 'Grok Bot has a question',
        choices: card.choices ?? [],
        allowFreeText: true,
      },
    });
  }
  for (const id of [...pending]) {
    if (live.has(id)) continue;
    pending.delete(id);
    out.push({
      type: 'interaction_resolved',
      payload: { requestId: id, selection: [], resolution: 'auto' },
    });
  }
  return out;
}
