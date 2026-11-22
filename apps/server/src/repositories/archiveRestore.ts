import { openSync, readSync, closeSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import type { ArchiveEntry } from '@tierwyn/shared';
import type { Database } from 'better-sqlite3';
import { getConversation, noteConversationsChanged } from './conversations.js';
import { getProject } from './projects.js';

/**
 * FW-11 D7: `:id` is a conversation UUID used as a filename stem, never a path.
 * No dot, slash, backslash or NUL survives this, so `..` and absolute paths are
 * impossible before we ever touch the filesystem.
 */
export const SAFE_ARCHIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeArchiveId(id: string): boolean {
  return typeof id === 'string' && SAFE_ARCHIVE_ID.test(id);
}

/** Mirrors the private helper in retention.ts — archives only ever live here. */
export function archiveFilePath(dataDir: string, id: string): string {
  return join(dataDir, 'archive', `${id}.jsonl`);
}

/** The version-2 header line written by `archiveOneConversation`. */
export interface ArchiveHeader {
  id: string;
  title: string;
  project_id: string | null;
  kind: string | null;
  parent_conversation_id: string | null;
  pinned: number | null;
  created_at: number;
  updated_at: number;
  eventCount: number;
}

const CHUNK = 64 * 1024;

/**
 * Synchronous, memory-bounded JSONL reader (FW-11 D8).
 *
 * better-sqlite3 transactions are synchronous, so readline / async iteration
 * cannot run inside one — and readFileSync().split() would defeat the whole
 * point of the streaming archive writer on a multi-hundred-MB transcript.
 * StringDecoder (not buf.toString) is required: a UTF-8 sequence straddling the
 * 64KiB boundary would otherwise decode to U+FFFD.
 *
 * Memory is O(longest line), not O(file).
 */
export function forEachJsonlLine(path: string, cb: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let n = 0;
    while ((n = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      carry += decoder.write(buf.subarray(0, n));
      let nl = carry.indexOf('\n');
      while (nl >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim() !== '') cb(line);
        nl = carry.indexOf('\n');
      }
    }
    carry += decoder.end();
    if (carry.trim() !== '') cb(carry);
  } finally {
    closeSync(fd);
  }
}

/** First line only — never reads the body. Returns undefined for anything unparseable. */
export function readArchiveHeader(path: string): ArchiveHeader | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    const n = readSync(fd, buf, 0, CHUNK, 0);
    if (n <= 0) return undefined;
    const text = new StringDecoder('utf8').write(buf.subarray(0, n));
    const nl = text.indexOf('\n');
    // A header longer than 64KiB is not a header we wrote.
    if (nl < 0) return undefined;
    const parsed = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
    if (parsed.archive !== 'tierwyn-conversation') return undefined;
    const c = parsed.conversation as Record<string, unknown> | undefined;
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') return undefined;
    return {
      id: c.id,
      title: c.title,
      project_id: typeof c.project_id === 'string' ? c.project_id : null,
      kind: typeof c.kind === 'string' ? c.kind : null,
      parent_conversation_id:
        typeof c.parent_conversation_id === 'string' ? c.parent_conversation_id : null,
      pinned: typeof c.pinned === 'number' ? c.pinned : null,
      created_at: typeof c.created_at === 'number' ? c.created_at : 0,
      updated_at: typeof c.updated_at === 'number' ? c.updated_at : 0,
      eventCount: typeof parsed.eventCount === 'number' ? parsed.eventCount : 0,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * One entry per readable `<dataDir>/archive/<safe-id>.jsonl`, newest mtime first.
 * A corrupt or foreign file is skipped, never fatal (FW-11 D1).
 *
 * ponytail: O(files) opens, one 64KiB read each. Fine for the low thousands the
 * nightly purge produces, and the UI only calls it behind an explicit toggle.
 * Ceiling: if an install ever accumulates enough archives for this to drag,
 * cache the headers in a sidecar index — do not build one before it hurts.
 */
export function listArchiveEntries(dataDir: string): ArchiveEntry[] {
  const dir = join(dataDir, 'archive');
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }

  const items: ArchiveEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!isSafeArchiveId(id)) continue;
    const path = join(dir, name);
    let bytes = 0;
    let mtime = 0;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      bytes = st.size;
      mtime = st.mtimeMs;
    } catch { continue; }
    const header = readArchiveHeader(path);
    if (!header || header.id !== id) continue;
    items.push({
      id,
      title: header.title,
      projectId: header.project_id,
      parentConversationId: header.parent_conversation_id,
      eventCount: header.eventCount,
      bytes,
      mtime,
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

export type DeleteArchiveOutcome =
  | { ok: true }
  | { ok: false; code: 'bad_id' | 'not_found'; message: string };

/** Unlink one `data/archive/<id>.jsonl`. Does not touch the live DB. */
export function deleteArchiveFile(dataDir: string, id: string): DeleteArchiveOutcome {
  if (!isSafeArchiveId(id)) {
    return { ok: false, code: 'bad_id', message: 'invalid archive id' };
  }
  const path = archiveFilePath(dataDir, id);
  if (!existsSync(path)) {
    return { ok: false, code: 'not_found', message: `no archive for ${id}` };
  }
  unlinkSync(path);
  return { ok: true };
}

/**
 * Unlink every regular file in `data/archive/` (jsonl and leftover junk that
 * `getRetentionStats` also counts). Directories are skipped. Missing dir → 0.
 */
export function deleteAllArchiveFiles(dataDir: string): { deleted: number } {
  const dir = join(dataDir, 'archive');
  if (!existsSync(dir)) return { deleted: 0 };
  let names: string[];
  try { names = readdirSync(dir); } catch { return { deleted: 0 }; }
  let deleted = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      unlinkSync(path);
      deleted++;
    } catch { /* vanished between readdir and unlink */ }
  }
  return { deleted };
}

export type RestoreFailureCode = 'bad_id' | 'not_found' | 'already_live' | 'no_project' | 'malformed';

export type RestoreOutcome =
  | {
      ok: true;
      /** Root first, then descendants in the order they were written. */
      restored: { id: string; title: string }[];
      projectId: string;
      eventsRestored: number;
      parentCleared: boolean;
    }
  | { ok: false; code: RestoreFailureCode; message: string };

/** Thrown inside the transaction so better-sqlite3 rolls back; never escapes this module. */
class MalformedArchive extends Error {}

/**
 * INSERT using only the columns that both the archived row and the live table
 * have. `draft_prompts` has gained columns in migrations 103/106/107, so an
 * archive written before those must not fail on a positional INSERT — and an
 * archive written after a future column drop must not fail either.
 * `table` is a literal from this module, never client input.
 */
function insertKnownColumns(
  db: Database,
  table: 'summaries' | 'draft_prompts',
  row: Record<string, unknown>,
): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const keys = cols.filter((c) => c in row);
  if (keys.length === 0) return;
  db.prepare(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  ).run(...keys.map((k) => row[k] as never));
}

interface RestoreCtx {
  db: Database;
  projectId: string;
  /** agent_models ids that still exist — anything else is NULLed (D12). */
  modelIds: Set<string>;
  /** Sessions already stubbed during this restore, so we only INSERT once (D3). */
  seenSessions: Set<string>;
  eventsRestored: number;
}

/**
 * Replay one archive file into the live DB. Caller guarantees: the header is
 * readable, the conversation id is not live, and the project exists.
 * Must run inside a transaction — it throws MalformedArchive on a bad line.
 */
function restoreOneFile(
  ctx: RestoreCtx,
  path: string,
  header: ArchiveHeader,
  parentConversationId: string | null,
): void {
  const { db } = ctx;
  db.prepare(
    `INSERT INTO conversations
       (id, project_id, title, created_at, updated_at, parent_conversation_id, kind, pinned)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    header.id,
    ctx.projectId,
    header.title,
    header.created_at,
    header.updated_at,
    parentConversationId,
    header.kind ?? 'chat',
    header.pinned ?? 0,
  );

  const insertSession = db.prepare(
    `INSERT INTO sessions
       (id, conversation_id, agent_id, agent_model_id, native_session_id, created_at, updated_at)
     VALUES (?,?,NULL,?,NULL,?,?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (id, session_id, type, payload, sender, agent_model_id, seq, ts)
     VALUES (?,?,?,?,?,?,?,?)`,
  );

  let first = true;
  forEachJsonlLine(path, (line) => {
    if (first) { first = false; return; } // header, already parsed
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new MalformedArchive(`unparseable line in ${header.id}.jsonl`);
    }

    if (row.record === 'summary') {
      const { record, ...rest } = row;
      void record;
      insertKnownColumns(db, 'summaries', { ...rest, conversation_id: header.id });
      return;
    }
    if (row.record === 'draft') {
      const { record, ...rest } = row;
      void record;
      insertKnownColumns(db, 'draft_prompts', { ...rest, conversation_id: header.id });
      return;
    }

    // Otherwise: an event line.
    const sessionId = row.sessionId;
    if (typeof row.id !== 'string' || typeof sessionId !== 'string' || typeof row.type !== 'string') {
      throw new MalformedArchive(`event line missing id/sessionId/type in ${header.id}.jsonl`);
    }
    const rawModel = typeof row.agentModelId === 'string' ? row.agentModelId : null;
    const modelId = rawModel && ctx.modelIds.has(rawModel) ? rawModel : null;
    const ts = typeof row.ts === 'number' ? row.ts : header.updated_at;

    if (!ctx.seenSessions.has(sessionId)) {
      // D3: sessions were never archived. Stub one from the first event that
      // names it. native_session_id stays NULL — the native files were unlinked
      // at purge. agent_id stays NULL — nothing to attribute it from.
      insertSession.run(sessionId, header.id, modelId, ts, ts);
      ctx.seenSessions.add(sessionId);
    }

    // payload is already a JSON *string* (the raw DB column) — insert verbatim.
    // Do NOT re-stringify and do NOT re-run appendEvent's redaction: the bytes
    // were redacted before they were ever archived.
    const payload = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload ?? {});
    insertEvent.run(
      row.id,
      sessionId,
      row.type,
      payload,
      typeof row.sender === 'string' ? row.sender : 'agent',
      modelId,
      typeof row.seq === 'number' ? row.seq : 0,
      ts,
    );
    ctx.eventsRestored++;
  });
}

/**
 * Restore `<dataDir>/archive/<id>.jsonl` (and every archived descendant still
 * on disk) back into the live DB with its original ids.
 *
 * The JSONL is never deleted (D5), so a second call returns `already_live`.
 * Everything happens in one synchronous transaction (D8): on any failure zero
 * live rows are written and the archive is untouched.
 */
export function restoreArchivedConversation(
  db: Database,
  dataDir: string,
  id: string,
  opts: { projectId?: string } = {},
): RestoreOutcome {
  if (!isSafeArchiveId(id)) {
    return { ok: false, code: 'bad_id', message: 'invalid archive id' };
  }
  const rootPath = archiveFilePath(dataDir, id);
  if (!existsSync(rootPath)) {
    return { ok: false, code: 'not_found', message: `no archive for ${id}` };
  }
  const rootHeader = readArchiveHeader(rootPath);
  if (!rootHeader || rootHeader.id !== id) {
    return { ok: false, code: 'malformed', message: `unreadable archive header for ${id}` };
  }

  // D4: breadth-first over archived children that are still on disk.
  const byParent = new Map<string, string[]>();
  for (const entry of listArchiveEntries(dataDir)) {
    if (!entry.parentConversationId) continue;
    const siblings = byParent.get(entry.parentConversationId) ?? [];
    siblings.push(entry.id);
    byParent.set(entry.parentConversationId, siblings);
  }
  const group: ArchiveHeader[] = [rootHeader];
  const queue = [id];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const childId of byParent.get(cur) ?? []) {
      if (seen.has(childId)) continue; // a cyclic parent chain cannot loop us
      seen.add(childId);
      const h = readArchiveHeader(archiveFilePath(dataDir, childId));
      if (!h || h.id !== childId) continue; // unreadable child: skip, do not fail the root
      group.push(h);
      queue.push(childId);
    }
  }

  for (const h of group) {
    if (getConversation(db, h.id)) {
      // F1: restoring a child first, then the root, 409s because BFS re-pulls
      // the live child into the group. The Settings table is a flat title list,
      // so name the descendant by title and tell the operator how to recover —
      // do not lead with a uuid that is not shown in the UI.
      const message = h.id === id
        ? `conversation ${h.id} is already in the database — delete it first to restore again`
        : `a descendant "${h.title}" is already in the database — delete it first to restore this tree, or restore it on its own`;
      return { ok: false, code: 'already_live', message };
    }
  }

  // D6: explicit target wins; otherwise fall back to the archived project.
  let projectId: string;
  if (opts.projectId) {
    if (!getProject(db, opts.projectId)) {
      return { ok: false, code: 'no_project', message: `no such project ${opts.projectId}` };
    }
    projectId = opts.projectId;
  } else {
    if (!rootHeader.project_id || !getProject(db, rootHeader.project_id)) {
      return {
        ok: false,
        code: 'no_project',
        message: 'original project no longer exists — choose a target project',
      };
    }
    projectId = rootHeader.project_id;
  }

  // D4: the root's archived parent is by definition not in `group`. Keep the
  // link only if that parent is live right now; otherwise restore as a root.
  const parentLive = Boolean(
    rootHeader.parent_conversation_id && getConversation(db, rootHeader.parent_conversation_id),
  );
  const parentCleared = Boolean(rootHeader.parent_conversation_id) && !parentLive;

  const modelIds = new Set(
    (db.prepare('SELECT id FROM agent_models').all() as { id: string }[]).map((r) => r.id),
  );
  const ctx: RestoreCtx = { db, projectId, modelIds, seenSessions: new Set(), eventsRestored: 0 };

  try {
    db.transaction(() => {
      for (const h of group) {
        const parent = h.id === id
          ? (parentLive ? rootHeader.parent_conversation_id : null)
          : h.parent_conversation_id;
        restoreOneFile(ctx, archiveFilePath(dataDir, h.id), h, parent);
      }
    })();
  } catch (err) {
    if (err instanceof MalformedArchive) {
      return { ok: false, code: 'malformed', message: err.message };
    }
    throw err;
  }

  const restoredIds = group.map((h) => h.id);
  noteConversationsChanged([projectId], { created: restoredIds });
  return {
    ok: true,
    restored: group.map((h) => ({ id: h.id, title: h.title })),
    projectId,
    eventsRestored: ctx.eventsRestored,
    parentCleared,
  };
}
