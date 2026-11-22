import type { Database } from 'better-sqlite3';
import {
  DEFAULT_SIDECAR_MAX_INPUT_CHARS,
  DEFAULT_SIDECAR_TIMEOUTS,
  isSidecarAgentBackend,
  type Conversation,
  type ServerFrame,
  type TranscriptEvent,
} from '@tierwyn/shared';
import { sidecarComplete, sidecarSiteReady } from './sidecar.js';
import { getConversation } from './repositories/conversations.js';
import { listEventsForConversation } from './repositories/events.js';
import { getEnhanceSettings, getSidecarLlmSettings } from './repositories/settings.js';
import { resolveConversationCwd } from './git/shadowCheckpoint.js';
import { remoteHostIdFor } from './repositories/remoteHosts.js';

/** Injectable so tests can stub the sidecar without hitting a network. */
export const describeDeps = { sidecarComplete };

export function isFirstPrompt(db: Database, conversationId: string): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
        AND e.type = 'prompt'
        AND json_extract(e.payload, '$.commandName') IS NULL`,
  ).get(conversationId) as { n: number };
  return row.n === 1;
}

/** Strip schedule envelope boilerplate (agent-prompt headers, steer, step API footers). */
export function stripScheduleEnvelope(text: string): string {
  let cleaned = text.trim();
  // Strip trailing Schedule step API footer
  cleaned = cleaned.replace(/\n*---\s*\nSchedule step API[\s\S]*$/i, '').trim();
  // Strip trailing or embedded steer sections
  cleaned = cleaned.replace(/\n*---\s*\n(?:(?:Operator|Agent) steer|Operator\/parent context)[^\n]*:?\s*\n[\s\S]*?\n---\s*$/i, '').trim();
  // Strip leading agent-authored prompt banner:
  // "---\nAgent-authored prompt...:\n(body)\n---" -> take body
  const agentPromptMatch = /^---\s*\n(?:Agent-authored prompt[^\n]*:?)\s*\n([\s\S]*?)(?:\n---|$)/i.exec(cleaned);
  if (agentPromptMatch && agentPromptMatch[1].trim()) {
    cleaned = agentPromptMatch[1].trim();
  }
  // Strip leading operator steer / context banner if present at start
  const steerMatch = /^---\s*\n(?:(?:Operator|Agent) steer|Operator\/parent context)[^\n]*:?\s*\n([\s\S]*?)(?:\n---|$)/i.exec(cleaned);
  if (steerMatch && steerMatch[1].trim()) {
    cleaned = steerMatch[1].trim();
  }
  // Strip any standalone leading or trailing "---" or "===" separators
  cleaned = cleaned.replace(/^[-=_*~#]{3,}\s*\n/g, '').replace(/\n[-=_*~#]{3,}\s*$/g, '').trim();
  return cleaned || text;
}

export function sanitiseDescription(raw: string): string {
  const cleaned = raw.replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!/[a-zA-Z0-9\p{L}\p{N}]/u.test(cleaned)) return '';
  return cleaned;
}

const SEPARATOR_LINE_RE = /^[-=_*~#]{2,}$/;
const ENVELOPE_HEADER_RE = /^(?:Agent-authored prompt|(?:Operator|Agent) steer|Operator\/parent context|Schedule step API|Standing workflow envelope)/i;

export function fallbackDescription(promptText: string): string {
  const stripped = stripScheduleEnvelope(promptText);
  const lines = stripped.split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (SEPARATOR_LINE_RE.test(trimmed)) continue;
    if (ENVELOPE_HEADER_RE.test(trimmed)) continue;
    if (trimmed.startsWith('```')) continue;
    const clean = trimmed.replace(/\s+/g, ' ').trim();
    if (/[a-zA-Z0-9\p{L}\p{N}]/u.test(clean)) {
      return clean.slice(0, 100);
    }
  }
  return '';
}

/** Head-truncate one message for the regenerate bundle. Never keeps the tail. */
export function truncateDescribeExcerpt(raw: string): string {
  const fences = raw.match(/```[\s\S]*?```/g) ?? [];
  const isDump = raw.length > 2000 || fences.length >= 2;
  const collapsed = raw.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim();
  const limit = isDump ? 200 : 400;
  if (collapsed.length > limit) return collapsed.slice(0, limit) + '…';
  return collapsed;
}

const THIN_USER_RE = /^(ok|okay|continue|go|yes|yep|sure|please|thanks)\.?$/i;

function promptText(e: TranscriptEvent): string {
  const raw = typeof e.payload.text === 'string' ? e.payload.text : '';
  return stripScheduleEnvelope(raw);
}

function isEligibleUserPrompt(e: TranscriptEvent): boolean {
  if (e.type !== 'prompt') return false;
  if (e.payload.commandName) return false;
  const source = e.payload.source;
  if (source != null && source !== 'user') return false;
  return promptText(e).trim().length > 0;
}

function isThinUserExcerpt(raw: string): boolean {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 40 || THIN_USER_RE.test(collapsed);
}

/** Follow-ups that name a process request, not the conversation subject.
 *  Ack-only turns match the thin regex; short real topics ("Look up today's news") do not. */
export function isProcessDescribeTurn(raw: string): boolean {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return true;
  if (THIN_USER_RE.test(collapsed)) return true;
  return (
    /copy[\s-]?paste/i.test(collapsed)
    || /use this as the first message/i.test(collapsed)
    || /first message in a new conversation/i.test(collapsed)
    || /prompt (?:that )?I can use in a new conversation/i.test(collapsed)
    || /prompt in the new conversation/i.test(collapsed)
  );
}

function selectDescribePrompts(events: TranscriptEvent[]): TranscriptEvent[] {
  const eligible = events.filter(isEligibleUserPrompt);
  const substantive = eligible.filter((e) => !isProcessDescribeTurn(promptText(e)));
  return substantive.length > 0 ? substantive : eligible;
}

function assistantText(e: TranscriptEvent): string {
  if (typeof e.payload.chunk === 'string' && e.payload.chunk.trim()) return e.payload.chunk;
  if (typeof e.payload.text === 'string' && e.payload.text.trim()) return e.payload.text;
  return '';
}

function isFinalAssistant(e: TranscriptEvent): boolean {
  return e.type === 'message'
    && e.payload.final === true
    && e.payload.spawnMarker == null
    && assistantText(e).length > 0;
}

function lastFinalAssistant(events: TranscriptEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isFinalAssistant(events[i]!)) return assistantText(events[i]!);
  }
  return undefined;
}

function fitBundle(sections: { label: string; text: string; protect: boolean }[], cap: number): string {
  const out: string[] = [];
  for (const s of sections) {
    const assembled = out.join('\n');
    const prefix = (assembled ? '\n' : '') + `${s.label}: `;
    const remaining = cap - assembled.length - prefix.length;
    if (remaining <= 0) break;
    const text = s.protect ? s.text : s.text.slice(0, remaining);
    if (!text && !s.protect) continue;
    out.push(`${s.label}: ${text}`);
  }
  return out.join('\n');
}

/** Labelled First / Latest / Later / Assistant bundle, capped at the describe budget. */
export function buildDescribeBundle(
  events: TranscriptEvent[],
  cap = DEFAULT_SIDECAR_MAX_INPUT_CHARS.describe,
): string {
  const prompts = selectDescribePrompts(events);
  if (prompts.length === 0) return '';

  const firstEv = prompts[0]!;
  const latestEv = prompts[prompts.length - 1]!;
  const laterEv = prompts.length >= 3 ? prompts[prompts.length - 2] : undefined;

  const selected = [firstEv, firstEv === latestEv ? undefined : latestEv, laterEv]
    .filter((e): e is TranscriptEvent => !!e);
  const assistant = selected.every((e) => isThinUserExcerpt(promptText(e)))
    ? lastFinalAssistant(events)
    : undefined;

  const sections: { label: string; text: string; protect: boolean }[] = [
    { label: 'First', text: truncateDescribeExcerpt(promptText(firstEv)), protect: true },
  ];
  if (firstEv !== latestEv) {
    sections.push({ label: 'Latest', text: truncateDescribeExcerpt(promptText(latestEv)), protect: false });
  }
  if (laterEv) {
    sections.push({ label: 'Later', text: truncateDescribeExcerpt(promptText(laterEv)), protect: false });
  }
  if (assistant) {
    sections.push({ label: 'Assistant', text: truncateDescribeExcerpt(assistant), protect: false });
  }
  return fitBundle(sections, cap);
}

export type RegenerateResult =
  | { ok: true; conversation: Conversation }
  | { ok: false; status: 404; error: 'no such conversation' }
  | { ok: false; status: 400; error: 'no prompt text to describe' };

export async function regenerateConversationDescription(
  db: Database,
  conversationId: string,
  broadcastAll?: (frame: ServerFrame) => void,
): Promise<RegenerateResult> {
  if (!getConversation(db, conversationId)) {
    return { ok: false, status: 404, error: 'no such conversation' };
  }
  const events = listEventsForConversation(db, conversationId);
  const describeSettings = getSidecarLlmSettings(db).describe;
  const maxChars = describeSettings.maxInputChars
    ?? DEFAULT_SIDECAR_MAX_INPUT_CHARS.describe;
  const timeoutSecs = describeSettings.timeoutSecs
    ?? (isSidecarAgentBackend(describeSettings.backend) ? 60 : DEFAULT_SIDECAR_TIMEOUTS.describe);
  const bundle = buildDescribeBundle(events, maxChars);
  const subject = selectDescribePrompts(events)[0];
  if (!bundle || !subject) {
    return { ok: false, status: 400, error: 'no prompt text to describe' };
  }

  let text = fallbackDescription(promptText(subject));
  if (sidecarSiteReady(db, 'describe')) {
    try {
      const cwd = resolveConversationCwd(db, conversationId) ?? undefined;
      const remoteHostId = remoteHostIdFor(db, { conversationId }) ?? null;
      const generated = await describeDeps.sidecarComplete(db, 'describe', bundle, {
        timeoutSecs,
        ...(cwd ? { cwd } : {}),
        remoteHostId,
      });
      if (generated.trim()) text = generated;
    } catch {
      // keep fallback
    }
  }
  text = sanitiseDescription(text);
  if (!text) {
    return { ok: false, status: 400, error: 'no prompt text to describe' };
  }

  db.prepare(
    "UPDATE conversations SET description = ?, description_source = 'auto', updated_at = ? WHERE id = ?",
  ).run(text, Date.now(), conversationId);
  broadcastAll?.({
    type: 'conversation_updated',
    conversationId,
    ts: Date.now(),
    description: text,
  });
  return { ok: true, conversation: getConversation(db, conversationId)! };
}

export async function describeConversationIfFirst(
  db: Database,
  conversationId: string,
  promptText: string,
  broadcastAll?: (frame: ServerFrame) => void,
): Promise<void> {
  if (getEnhanceSettings(db).describeEnabled === false) return;
  if (!isFirstPrompt(db, conversationId)) return;
  const conv = getConversation(db, conversationId);
  // A clear leaves description NULL with description_source = 'user'. Bail on
  // any already-set source so we never refill an operator-cleared row.
  if (!conv || conv.description || conv.descriptionSource) return;

  const cleanedPrompt = stripScheduleEnvelope(promptText);
  let text = fallbackDescription(cleanedPrompt);
  if (sidecarSiteReady(db, 'describe')) {
    try {
      const describeSettings = getSidecarLlmSettings(db).describe;
      const maxChars = describeSettings.maxInputChars
        ?? DEFAULT_SIDECAR_MAX_INPUT_CHARS.describe;
      const timeoutSecs = describeSettings.timeoutSecs
        ?? (isSidecarAgentBackend(describeSettings.backend) ? 60 : DEFAULT_SIDECAR_TIMEOUTS.describe);
      const cwd = resolveConversationCwd(db, conversationId) ?? undefined;
      const remoteHostId = remoteHostIdFor(db, { conversationId }) ?? null;
      const generated = await describeDeps.sidecarComplete(db, 'describe', cleanedPrompt.slice(0, maxChars), {
        timeoutSecs,
        ...(cwd ? { cwd } : {}),
        remoteHostId,
      });
      if (generated.trim()) text = generated;
    } catch {
      // keep fallback
    }
  }
  text = sanitiseDescription(text);
  if (!text) return;

  const info = db.prepare(
    "UPDATE conversations SET description = ?, description_source = 'auto' WHERE id = ? AND description IS NULL AND description_source IS NULL",
  ).run(text, conversationId);
  if (info.changes === 1) {
    broadcastAll?.({
      type: 'conversation_updated',
      conversationId,
      ts: Date.now(),
      description: text,
    });
  }
}
