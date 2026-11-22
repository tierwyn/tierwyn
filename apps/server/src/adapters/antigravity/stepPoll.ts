/**
 * Live progress for agy `--print` runs.
 *
 * agy buffers stdout until a turn finishes (especially during tool use), but it
 * writes trajectory steps to the native conversation SQLite DB as work proceeds.
 * Polling that DB surfaces tool-action narration while the subprocess runs.
 *
 * agy 1.1.1+ no longer prints `Created conversation <uuid>` to stderr, so the
 * poller discovers the DB file by mtime when no resume id is known yet.
 */

import Database from 'better-sqlite3';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import type { PartialEvent } from './mapping.js';

export type StepPollEmit = (event: PartialEvent) => void;

const DISCOVERY_TOLERANCE_MS = 2000;

/** Newest conversation .db whose mtime is at/after `since` (with clock-skew tolerance). */
export function findNewestConversationSince(conversationsDir: string, since: number): string | null {
  const threshold = since - DISCOVERY_TOLERANCE_MS;
  try {
    const candidates: { id: string; mtime: number }[] = [];
    for (const entry of readdirSync(conversationsDir)) {
      if (!entry.endsWith('.db')) continue;
      const full = path.join(conversationsDir, entry);
      try {
        const st = statSync(full);
        if (st.mtimeMs >= threshold) {
          candidates.push({ id: entry.replace(/\.db$/, ''), mtime: st.mtimeMs });
        }
      } catch {
        // ignore stat errors on individual files
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].id;
  } catch {
    return null;
  }
}

/** Extract a tool-action line from a protobuf step payload. */
export function parseAgyToolStep(payload: Buffer): string | null {
  const raw = payload.toString('utf8');
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < raw.length; j++) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(raw.slice(i, j + 1)) as {
              toolAction?: string;
              toolSummary?: string;
            };
            const line = obj.toolAction?.trim() || obj.toolSummary?.trim();
            if (line) return `${line}\n`;
          } catch {
            // Not JSON at this offset — keep scanning.
          }
          break;
        }
      }
    }
  }
  return null;
}

type StepRow = { idx: number; step_payload: Buffer };

export type ConversationStepPollerOpts = {
  conversationsDir: string;
  /** Resume id when resuming; null for a fresh turn (discover via spawnTime). */
  conversationId: string | null;
  spawnTime: number;
  /** When true, ignore steps at/ before resumeBaselineIdx. */
  resumeTurn: boolean;
  /** Max step idx before this turn (read before spawning agy). Ignored when !resumeTurn. */
  resumeBaselineIdx?: number;
  emit: StepPollEmit;
  /** Fired once when a fresh conversation db is discovered mid-run. */
  onConversationId?: (id: string) => void;
  pollMs?: number;
};

export class ConversationStepPoller {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _conversationId: string | null;
  private _lastIdx = -1;
  private _baselineReady = false;
  private _seenLines = new Set<string>();

  constructor(private readonly opts: ConversationStepPollerOpts) {
    this._conversationId = opts.conversationId;
  }

  /** Begin polling immediately — discovers the conversation db when needed. */
  start(): void {
    this.stop();
    this._tick();
    this._timer = setInterval(() => this._tick(), this.opts.pollMs ?? 400);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _dbPath(): string {
    return path.join(this.opts.conversationsDir, `${this._conversationId!}.db`);
  }

  private _tick(): void {
    if (!this._conversationId) {
      const found = findNewestConversationSince(this.opts.conversationsDir, this.opts.spawnTime);
      if (!found) return;
      this._conversationId = found;
      this.opts.onConversationId?.(found);
    }
    if (!this._baselineReady) {
      this._lastIdx = this.opts.resumeTurn ? (this.opts.resumeBaselineIdx ?? -1) : -1;
      this._baselineReady = true;
    }
    this._poll();
  }

  private _poll(): void {
    let db: Database.Database | undefined;
    try {
      db = new Database(this._dbPath(), { readonly: true, fileMustExist: true });
      const rows = db
        .prepare('SELECT idx, step_payload FROM steps WHERE idx > ? ORDER BY idx')
        .all(this._lastIdx) as StepRow[];
      for (const row of rows) {
        this._lastIdx = row.idx;
        const line = parseAgyToolStep(row.step_payload);
        if (!line || this._seenLines.has(line)) continue;
        this._seenLines.add(line);
        this.opts.emit({ type: 'message', payload: { chunk: line, final: false } });
      }
    } catch {
      // DB not readable yet (still being created / locked).
    } finally {
      db?.close();
    }
  }
}
