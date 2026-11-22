/**
 * TTS recordings index — SQLite rows + WAV files next to the DB.
 *
 * Disk layout: `<dirname(TIERWYN_DB)>/tts-recordings/<id>.wav`
 * (e.g. `./data/tts-recordings/` for the default DB path).
 *
 * A row is also a durable job: status running → done | error. Jobs are allocated
 * on speaker press (before summarize/synth) so the client can poll by id.
 */
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import type { Database } from 'better-sqlite3';
import { dbPathFromEnv } from '../config/env.js';
import type {
  TtsRecording,
  TtsRecordingMode,
  TtsRecordingSource,
  TtsRecordingStatus,
} from '@tierwyn/shared';
import { listDescendants } from './conversations.js';

const SOURCES = new Set<TtsRecordingSource>([
  'message', 'prompt', 'spawn_result', 'file', 'selection', 'scope', 'other',
]);
const MODES = new Set<TtsRecordingMode>(['as-is', 'summarize', 'explain-diff']);

/** Max concurrent running jobs per project (429 above this). */
export const MAX_RUNNING_TTS_JOBS_PER_PROJECT = 4;

/** Override for tests; null = derive from TIERWYN_DB. */
let recordingsRootOverride: string | null = null;

export function setTtsRecordingsRoot(dir: string | null): void {
  recordingsRootOverride = dir;
}

/** Absolute directory where WAV files are stored. */
export function getTtsRecordingsDir(): string {
  if (recordingsRootOverride) return recordingsRootOverride;
  const dbPath = dbPathFromEnv();
  if (dbPath === ':memory:') {
    return join(tmpdir(), 'tierwyn-tts-recordings');
  }
  return join(dirname(resolve(dbPath)), 'tts-recordings');
}

export function parseRecordingSource(v: unknown): TtsRecordingSource {
  return typeof v === 'string' && SOURCES.has(v as TtsRecordingSource)
    ? (v as TtsRecordingSource)
    : 'other';
}

export function parseRecordingMode(v: unknown): TtsRecordingMode {
  return typeof v === 'string' && MODES.has(v as TtsRecordingMode)
    ? (v as TtsRecordingMode)
    : 'as-is';
}

function titleFrom(text: string, explicit?: string): string {
  const t = (explicit ?? text).trim().replace(/\s+/g, ' ');
  if (t.length <= 80) return t || 'Recording';
  return `${t.slice(0, 80)}…`;
}

/** Normalize a DB row (SELECT *) into TtsRecording with job fields. */
function mapRow(raw: Record<string, unknown>): TtsRecording {
  const statusRaw = raw.status;
  const status: TtsRecordingStatus =
    statusRaw === 'running' || statusRaw === 'error' || statusRaw === 'done'
      ? statusRaw
      : 'done';
  return {
    id: String(raw.id),
    project_id: String(raw.project_id),
    conversation_id: raw.conversation_id == null ? null : String(raw.conversation_id),
    created_at: Number(raw.created_at) || 0,
    source: parseRecordingSource(raw.source),
    mode: parseRecordingMode(raw.mode),
    provider: raw.provider === 'kokoro' ? 'kokoro' : 'piper',
    voice: String(raw.voice ?? ''),
    title: String(raw.title ?? ''),
    spoken_text: String(raw.spoken_text ?? ''),
    path: String(raw.path ?? ''),
    bytes: Number(raw.bytes) || 0,
    status,
    error: raw.error == null || raw.error === '' ? null : String(raw.error),
    updated_at: raw.updated_at == null ? null : Number(raw.updated_at),
    ephemeral: Number(raw.ephemeral) ? 1 : 0,
  };
}

export interface InsertTtsRecordingInput {
  /** At least one of projectId / conversationId must resolve to a real project. */
  projectId?: string | null;
  conversationId?: string | null;
  source?: TtsRecordingSource;
  mode?: TtsRecordingMode;
  provider: 'piper' | 'kokoro';
  voice: string;
  spokenText: string;
  title?: string;
  /** Raw WAV bytes from the sidecar. */
  buf: Buffer;
  /** When true, row is hidden from lists and reaped after ~10 min. */
  ephemeral?: boolean;
}

/**
 * Resolve the durable (projectId, conversationId) pair. Null = invalid input
 * (unknown ids, mismatched pair, or neither provided).
 */
export function resolveRecordingScope(
  db: Database,
  input: { projectId?: string | null; conversationId?: string | null },
): { projectId: string; conversationId: string | null } | null {
  const conversationId =
    typeof input.conversationId === 'string' && input.conversationId.trim()
      ? input.conversationId.trim()
      : null;
  const projectId =
    typeof input.projectId === 'string' && input.projectId.trim()
      ? input.projectId.trim()
      : null;

  if (conversationId) {
    const conv = db
      .prepare('SELECT id, project_id FROM conversations WHERE id = ?')
      .get(conversationId) as { id: string; project_id: string } | undefined;
    if (!conv) return null;
    if (projectId && projectId !== conv.project_id) return null;
    return { projectId: conv.project_id, conversationId: conv.id };
  }

  if (projectId) {
    const proj = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as { id: string } | undefined;
    if (!proj) return null;
    return { projectId: proj.id, conversationId: null };
  }

  return null;
}

export function countRunningTtsJobsForProject(db: Database, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tts_recordings
       WHERE project_id = ? AND status = 'running'`,
    )
    .get(projectId) as { c: number };
  return Number(row?.c) || 0;
}

export type StartTtsJobResult =
  | { ok: true; recording: TtsRecording }
  | { ok: false; error: 'scope' | 'concurrency' };

export interface StartTtsRecordingJobInput {
  projectId?: string | null;
  conversationId?: string | null;
  source?: TtsRecordingSource;
  mode?: TtsRecordingMode;
  provider: 'piper' | 'kokoro';
  voice: string;
  /** Source text at job start (summarize output is written on finish). */
  spokenText: string;
  title?: string;
  ephemeral: boolean;
}

/**
 * Allocate a durable job row before summarize/synth. No audio yet (path='', bytes=0).
 */
export function startTtsRecordingJob(
  db: Database,
  input: StartTtsRecordingJobInput,
): StartTtsJobResult {
  const scope = resolveRecordingScope(db, {
    projectId: input.projectId,
    conversationId: input.conversationId,
  });
  if (!scope) return { ok: false, error: 'scope' };

  if (countRunningTtsJobsForProject(db, scope.projectId) >= MAX_RUNNING_TTS_JOBS_PER_PROJECT) {
    return { ok: false, error: 'concurrency' };
  }

  const now = Date.now();
  const id = randomUUID();
  const row: TtsRecording = {
    id,
    project_id: scope.projectId,
    conversation_id: scope.conversationId,
    created_at: now,
    source: input.source ?? 'other',
    mode: input.mode ?? 'as-is',
    provider: input.provider,
    voice: input.voice,
    title: titleFrom(input.spokenText, input.title),
    spoken_text: input.spokenText,
    path: '',
    bytes: 0,
    status: 'running',
    error: null,
    updated_at: now,
    ephemeral: input.ephemeral ? 1 : 0,
  };

  db.prepare(
    `INSERT INTO tts_recordings
      (id, project_id, conversation_id, created_at, source, mode, provider, voice,
       title, spoken_text, path, bytes, status, error, updated_at, ephemeral)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.project_id,
    row.conversation_id,
    row.created_at,
    row.source,
    row.mode,
    row.provider,
    row.voice,
    row.title,
    row.spoken_text,
    row.path,
    row.bytes,
    row.status,
    row.error,
    row.updated_at,
    row.ephemeral,
  );

  return { ok: true, recording: row };
}

/**
 * Terminal success: write WAV, fill path/bytes/spoken_text, status=done.
 * Optional mode/error overrides for the row's mode/error columns.
 */
export function finishTtsRecordingJob(
  db: Database,
  id: string,
  buf: Buffer,
  spokenText: string,
  opts?: { mode?: TtsRecordingMode; error?: string | null },
): void {
  const existing = getTtsRecording(db, id);
  if (!existing) return;

  const dir = getTtsRecordingsDir();
  mkdirSync(dir, { recursive: true });
  const relPath = `tts-recordings/${id}.wav`;
  const absPath = join(dir, `${id}.wav`);
  writeFileSync(absPath, buf);

  const now = Date.now();
  const mode = opts?.mode ?? existing.mode;
  const error = opts?.error !== undefined ? opts.error : null;

  try {
    db.prepare(
      `UPDATE tts_recordings
       SET path = ?, bytes = ?, spoken_text = ?, title = ?, mode = ?,
           status = 'done', error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      relPath,
      buf.length,
      spokenText,
      titleFrom(spokenText, existing.title || undefined),
      mode,
      error,
      now,
      id,
    );
  } catch (e) {
    try { unlinkSync(absPath); } catch { /* ignore */ }
    throw e;
  }
}

/** Terminal failure: status=error, no file. Clears the spoken_text placeholder — nothing was spoken. */
export function failTtsRecordingJob(db: Database, id: string, message: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE tts_recordings
     SET status = 'error', error = ?, spoken_text = '', updated_at = ?
     WHERE id = ?`,
  ).run(message.slice(0, 2000), now, id);
}

/**
 * Boot: any row left 'running' from a previous process is dead.
 * Returns number of rows flipped to error.
 */
export function reconcileStaleTtsJobs(db: Database): number {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE tts_recordings
     SET status = 'error', error = ?, updated_at = ?
     WHERE status = 'running'`,
  ).run('interrupted by server restart', now);
  return Number(result.changes) || 0;
}

/**
 * Delete ephemeral rows (+ files) that are terminal and older than olderThanMs,
 * or still running but older than olderThanMs (safety). Returns count deleted.
 */
export function reapEphemeralTtsRecordings(db: Database, olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const rows = db
    .prepare(
      `SELECT id FROM tts_recordings
       WHERE ephemeral = 1
         AND (
           (status IN ('done', 'error') AND COALESCE(updated_at, created_at) < ?)
           OR (status = 'running' AND created_at < ?)
         )`,
    )
    .all(cutoff, cutoff) as { id: string }[];

  let n = 0;
  for (const { id } of rows) {
    if (deleteTtsRecording(db, id)) n += 1;
  }
  return n;
}

/**
 * Write WAV to disk and insert a completed index row (legacy / tests).
 * Prefer startTtsRecordingJob + finishTtsRecordingJob for the live speak-record path.
 */
export function insertTtsRecording(
  db: Database,
  input: InsertTtsRecordingInput,
): TtsRecording | null {
  const scope = resolveRecordingScope(db, {
    projectId: input.projectId,
    conversationId: input.conversationId,
  });
  if (!scope) return null;

  const id = randomUUID();
  const dir = getTtsRecordingsDir();
  mkdirSync(dir, { recursive: true });
  const relPath = `tts-recordings/${id}.wav`;
  const absPath = join(dir, `${id}.wav`);
  writeFileSync(absPath, input.buf);

  const now = Date.now();
  const row: TtsRecording = {
    id,
    project_id: scope.projectId,
    conversation_id: scope.conversationId,
    created_at: now,
    source: input.source ?? 'other',
    mode: input.mode ?? 'as-is',
    provider: input.provider,
    voice: input.voice,
    title: titleFrom(input.spokenText, input.title),
    spoken_text: input.spokenText,
    path: relPath,
    bytes: input.buf.length,
    status: 'done',
    error: null,
    updated_at: now,
    ephemeral: input.ephemeral ? 1 : 0,
  };

  try {
    db.prepare(
      `INSERT INTO tts_recordings
        (id, project_id, conversation_id, created_at, source, mode, provider, voice,
         title, spoken_text, path, bytes, status, error, updated_at, ephemeral)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id,
      row.project_id,
      row.conversation_id,
      row.created_at,
      row.source,
      row.mode,
      row.provider,
      row.voice,
      row.title,
      row.spoken_text,
      row.path,
      row.bytes,
      row.status,
      row.error,
      row.updated_at,
      row.ephemeral,
    );
  } catch (e) {
    try { unlinkSync(absPath); } catch { /* ignore */ }
    throw e;
  }

  return row;
}

/** List non-ephemeral rows for a conversation (includes running/error for recovery). */
export function listTtsRecordings(db: Database, conversationId: string): TtsRecording[] {
  return (db
    .prepare(
      `SELECT * FROM tts_recordings
       WHERE conversation_id = ? AND ephemeral = 0
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(conversationId) as Record<string, unknown>[]).map(mapRow);
}

/**
 * All non-ephemeral recordings for a project (chat-scoped + project-only), newest first.
 */
export function listTtsRecordingsForProject(db: Database, projectId: string): TtsRecording[] {
  return (db
    .prepare(
      `SELECT * FROM tts_recordings
       WHERE project_id = ? AND ephemeral = 0
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(projectId) as Record<string, unknown>[]).map(mapRow);
}

/**
 * Recordings for `rootId` and ALL its descendants (root inclusive). Same sort
 * order as listTtsRecordings so tree rows mix naturally by recency rather than
 * grouping by source conversation. Caller must pass a validated root id
 * (typically the output of getRootAncestor).
 *
 * `hideBtw` is intentionally OFF — `/btw` answer-children are real
 * conversations that can hold recordings, and the user wants them included in
 * the tree view. Do not pass `{ hideBtw: true }` to listDescendants here.
 *
 * The ids are server-derived UUIDs from the conversations table (rootId +
 * listDescendants output), never user input. The placeholder string is built
 * from `ids.length` only; the ids themselves are bound as parameters via
 * `.all(...ids)`, never string-interpolated as literals — injection-safe by
 * construction.
 */
export function listTtsRecordingsForTree(db: Database, rootId: string): TtsRecording[] {
  const ids = [rootId, ...listDescendants(db, rootId).map((c) => c.id)];
  if (ids.length === 0) return []; // defensive — rootId is always present
  const placeholders = ids.map(() => '?').join(', ');
  return (db
    .prepare(
      `SELECT * FROM tts_recordings
       WHERE conversation_id IN (${placeholders}) AND ephemeral = 0
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...ids) as Record<string, unknown>[]).map(mapRow);
}

export function getTtsRecording(db: Database, id: string): TtsRecording | undefined {
  const raw = db
    .prepare('SELECT * FROM tts_recordings WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return raw ? mapRow(raw) : undefined;
}

/** Absolute path for a stored relative `path` column value. */
export function absoluteWavPath(row: TtsRecording): string {
  // Always resolve under the active recordings dir by id — robust when tests
  // override the root (stored path stays `tts-recordings/<id>.wav` for display).
  return join(getTtsRecordingsDir(), `${row.id}.wav`);
}

export function readTtsRecordingAudio(row: TtsRecording): Buffer | null {
  if (!row.path || row.status !== 'done') return null;
  const abs = absoluteWavPath(row);
  if (!existsSync(abs)) return null;
  return readFileSync(abs);
}

/** Delete index row and WAV file. Returns false if the row was missing. */
export function deleteTtsRecording(db: Database, id: string): boolean {
  const row = getTtsRecording(db, id);
  if (!row) return false;
  db.prepare('DELETE FROM tts_recordings WHERE id = ?').run(id);
  const abs = absoluteWavPath(row);
  try {
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    // Row is gone; orphan file is acceptable.
  }
  return true;
}

/** Best-effort unlink of WAV files after conversation cascade (rows already gone). */
export function unlinkTtsWavPaths(paths: string[]): void {
  for (const abs of paths) {
    try {
      if (existsSync(abs)) unlinkSync(abs);
    } catch {
      // orphan WAV is acceptable
    }
  }
}
