import type { Database } from 'better-sqlite3';
import { redactAll } from './secrets/redactAll.js';

export const RECONSTRUCT_CHUNK_CAP = 40;
export const RECONSTRUCT_MAX_CHARS = 8000;

export function payloadObj(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function ownText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.chunk === 'string') return payload.chunk;
  const parts = [payload.label, payload.description, payload.summary]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  return parts.join(' ');
}

export function reconstructMessageText(db: Database, sessionId: string, seq: number, ownChunk: string): string {
  if (ownChunk.length >= RECONSTRUCT_CHUNK_CAP) return ownChunk.slice(0, RECONSTRUCT_MAX_CHARS);
  const rows = db.prepare(
    `SELECT seq, type, payload FROM events
      WHERE session_id = ? AND seq <= ?
      ORDER BY seq DESC
      LIMIT 400`,
  ).all(sessionId, seq) as Array<{ seq: number; type: string; payload: string }>;
  const chunks: string[] = [];
  let total = 0;
  for (const row of rows) {
    if (row.type !== 'message') break;
    const p = payloadObj(row.payload);
    if (p.spawnMarker || p.recalledMemories) break;
    if (row.seq !== seq && p.final === true) break;
    const chunk = typeof p.chunk === 'string' ? p.chunk : '';
    chunks.push(chunk);
    total += chunk.length;
    if (total >= RECONSTRUCT_MAX_CHARS) break;
  }
  chunks.reverse();
  return chunks.join('').slice(0, RECONSTRUCT_MAX_CHARS);
}

export function literalTokens(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean);
}

export function centerSnippet(text: string, tokens: string[], max: number): string {
  const collapsed = redactAll(text.replace(/\n{3,}/g, '\n\n'));
  const lower = collapsed.toLowerCase();
  let idx = -1;
  let tokLen = 0;
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      tokLen = t.length;
    }
  }
  if (idx < 0) return collapsed.slice(0, max);
  const room = Math.max(0, max - tokLen);
  const half = Math.floor(room / 2);
  let from = Math.max(0, idx - half);
  let to = Math.min(collapsed.length, from + max);
  if (to - from < max) from = Math.max(0, to - max);
  let snip = collapsed.slice(from, to);
  if (from > 0) snip = `…${snip}`;
  if (to < collapsed.length) snip = `${snip}…`;
  return snip;
}

export function turnText(db: Database, row: { type: string; sessionId: string; seq: number; payload: string }): string {
  const payload = payloadObj(row.payload);
  const text = ownText(payload);
  if (row.type === 'message' && payload.final === true && text.length < RECONSTRUCT_CHUNK_CAP) {
    return reconstructMessageText(db, row.sessionId, row.seq, text);
  }
  return text;
}
