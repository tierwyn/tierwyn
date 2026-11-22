import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import type { Conversation, AgentStatus, ConversationKind, Workdir, InteractionMode, PendingHandoffMode, EffortPreference } from '@tierwyn/shared';
import { listBtwChildConversationIds } from './btw.js';
import { getTtsRecordingsDir } from './ttsRecordings.js';
import { appendEvent } from './events.js';
import { lastSessionForConversation } from './sessions.js';
import { evictMeshRates, evictMeshCallerRates } from '../mesh/rate.js';
import { parsePresetIdCell, serialisePresetIds } from './rulePresets.js';

interface Row {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /** Server-side view-tracking column (migration 014). 0 = never viewed. */
  last_viewed_at: number;
  /** Only populated by listConversations (correlated subquery). Other
   *  callers (create/get) don't include this column, so it's optional. */
  last_status_payload?: string | null;
  /** Latest session's agent_model_id / agent_id (list query only). */
  last_profile_id?: string | null;
  last_agent_type?: string | null;
  parent_conversation_id: string | null;
  template_name: string | null;
  workdir_path: string | null;
  /** 'chat' | 'schedule_home' (migration 030). Defaults to 'chat'. */
  kind: string;
  schedule_job_id: string | null;
  /** Conversation-level delegate workdir pin (migration 031). NULL = not pinned. */
  spawn_workdir: string | null;
  /** Retention-purge exemption pin (migration 102). 0 = purgeable. */
  pinned?: number;
  /** Operator archive flag (migration 114). 1 = hidden from the default list. */
  archived?: number;
  /** One-line summary (migration 104). */
  description: string | null;
  /** 'auto' | 'user' | NULL (migration 104). */
  description_source: string | null;
  /** JSON array of operator tags (migration 111). Always '[]' or a JSON array. */
  tags: string;
  /** Optional catalogue token (migration 122). */
  designation: string | null;
  /** Capability profile id (migration 128). NULL = 'all'. */
  capability_profile: string | null;
  /** JSON string[] of MCP registry ids (migration 140). NULL = inherit template default. */
  mcp_servers?: string | null;
  /** Sticky per-conversation permission mode (migration 141). NULL = inherit global. */
  permission_mode?: string | null;
  effort?: string | null;
  /** Operator-staged next-send action (migration 142). NULL = none. */
  pending_handoff_mode?: string | null;
  /** Operator-authored instructions (migration 143). NULL = none. */
  rules?: string | null;
  /** JSON string[] of rule_presets.id (migration 144). NULL = none. */
  rule_preset_ids?: string | null;
  /** Agent sandbox override (migration 148). NULL = inherit. */
  sandbox?: string | null;
}

function toConversation(r: Row): Conversation {
  let lastStatus: AgentStatus | undefined;
  if (r.last_status_payload) {
    try {
      const parsed = JSON.parse(r.last_status_payload) as { status?: AgentStatus };
      lastStatus = parsed.status;
    } catch { /* malformed payload — leave undefined */ }
  }
  // FW-15: never throw out of the mapper. listConversations maps every row in
  // a project, so one hand-edited/corrupt tags cell must not blank the sidebar.
  let tags: string[] = [];
  if (r.tags) {
    try {
      const parsed: unknown = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        // F7: hand-edited duplicate tags would collide as React keys. PATCH
        // already dedups; the mapper does the same so a dirty cell cannot
        // crash the sidebar.
        tags = [...new Set(parsed.filter((t): t is string => typeof t === 'string'))];
      }
    } catch { /* malformed column — treat as untagged */ }
  }
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastStatus,
    ...(r.last_profile_id ? { lastProfileId: r.last_profile_id } : {}),
    ...(r.last_agent_type ? { lastAgentType: r.last_agent_type } : {}),
    ...(r.last_viewed_at > 0 ? { lastViewedAt: r.last_viewed_at } : {}),
    parentConversationId: r.parent_conversation_id ?? undefined,
    templateName: r.template_name ?? undefined,
    workdirPath: r.workdir_path ?? undefined,
    kind: (r.kind as ConversationKind | undefined) ?? undefined,
    scheduleJobId: r.schedule_job_id ?? undefined,
    spawnWorkdir: (r.spawn_workdir as Workdir | null) ?? undefined,
    pinned: r.pinned === 1 ? true : undefined,
    archived: r.archived === 1 ? true : undefined,
    description: r.description ?? undefined,
    descriptionSource: (r.description_source as 'auto' | 'user' | null) ?? undefined,
    tags,
    designation: r.designation || undefined,
    capabilityProfile: r.capability_profile || undefined,
    ...mcpField(r.mcp_servers),
    ...permissionModeField(r.permission_mode),
    ...(r.effort && EFFORT_PREFERENCES.has(r.effort) ? { effort: r.effort as EffortPreference } : {}),
    ...(r.sandbox === 'on' || r.sandbox === 'off' ? { sandbox: r.sandbox } : {}),
    ...(r.pending_handoff_mode === 'fresh' || r.pending_handoff_mode === 'summary'
      ? { pendingHandoffMode: r.pending_handoff_mode }
      : {}),
    ...(r.rules ? { rules: r.rules } : {}),
    ...(() => {
      const ids = parsePresetIdCell(r.rule_preset_ids);
      return ids ? { rulePresetIds: ids } : {};
    })(),
  };
}

export const EFFORT_PREFERENCES: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Sticky per-conversation composer effort (migration 156). null clears. No
 *  reap: effort rides each prompt frame, long-lived adapters rebind on their own. */
export function setConversationEffort(db: Database, id: string, effort: EffortPreference | null): Conversation | undefined {
  if (effort !== null && !EFFORT_PREFERENCES.has(effort)) throw new Error(`invalid effort: ${effort}`);
  const info = db.prepare('UPDATE conversations SET effort = ? WHERE id = ?').run(effort, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Omitted when NULL (inherit) so existing shapes stay unchanged. */
function permissionModeField(cell: string | null | undefined): { permissionMode?: InteractionMode } {
  if (cell === 'bypass' || cell === 'questions' || cell === 'prompt') {
    return { permissionMode: cell };
  }
  return {};
}

/** Omitted when NULL (inherit) so existing shapes stay unchanged. */
function mcpField(cell: string | null | undefined): {
  mcpServers?: string[];
  disableNativeMcp?: boolean;
  disabledNativeMcp?: string[];
} {
  const p = parseMcpCell(cell);
  return {
    ...(p.servers !== null ? { mcpServers: p.servers } : {}),
    ...(p.disableNative ? { disableNativeMcp: true } : {}),
    ...(p.disabledNative.length ? { disabledNativeMcp: p.disabledNative } : {}),
  };
}

export interface StoredMcpConfig {
  servers: string[] | null;
  disableNative: boolean;
  disabledNative: string[];
}

/** null servers = inherit; never throws on a corrupt cell (treated as inherit). */
export function parseMcpCell(cell: string | null | undefined): StoredMcpConfig {
  if (cell == null) return { servers: null, disableNative: false, disabledNative: [] };
  try {
    const v: unknown = JSON.parse(cell);
    if (Array.isArray(v)) {
      return {
        servers: v.filter((x): x is string => typeof x === 'string'),
        disableNative: false,
        disabledNative: [],
      };
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const servers = Array.isArray(obj.servers)
        ? obj.servers.filter((x): x is string => typeof x === 'string')
        : (obj.servers === null ? null : null);
      const disableNative = obj.disableNative === true;
      const disabledNative = Array.isArray(obj.disabledNative)
        ? obj.disabledNative.filter((x): x is string => typeof x === 'string')
        : [];
      return { servers, disableNative, disabledNative };
    }
    return { servers: null, disableNative: false, disabledNative: [] };
  } catch {
    return { servers: null, disableNative: false, disabledNative: [] };
  }
}

/** Legacy array accessor for compatibility. */
function parseMcpServers(cell: string | null | undefined): string[] | null {
  return parseMcpCell(cell).servers;
}

type ConvChange = { projectIds: string[]; createdIds?: string[]; deletedIds?: string[] };
let listener: ((c: ConvChange) => void) | null = null;
let pending: { p: Set<string>; c: Set<string>; d: Set<string> } | null = null;

/** index.ts wires this to fanOpenClients. Tests leave it null. */
export function setConversationsChangedListener(fn: typeof listener): void { listener = fn; }

// ponytail: flush on setImmediate. better-sqlite3 transactions are synchronous, so
// the enclosing tx has committed (or rolled back) before this fires. A rolled-back
// create only causes one spurious client refetch, which is harmless.
export function noteConversationsChanged(projectIds: string[], ids: { created?: string[]; deleted?: string[] }): void {
  if (!listener) return;
  if (!pending) {
    pending = { p: new Set(), c: new Set(), d: new Set() };
    setImmediate(() => {
      const b = pending!; pending = null;
      try {
        listener?.({
          projectIds: [...b.p],
          ...(b.c.size ? { createdIds: [...b.c] } : {}),
          ...(b.d.size ? { deletedIds: [...b.d] } : {}),
        });
      } catch (err) {
        console.error('[conversations] conversations_changed listener error:', err);
      }
    });
  }
  projectIds.forEach((x) => pending!.p.add(x));
  ids.created?.forEach((x) => pending!.c.add(x));
  ids.deleted?.forEach((x) => pending!.d.add(x));
}

export function createConversation(
  db: Database,
  input: {
    projectId: string; title: string; parentConversationId?: string; templateName?: string;
    workdirPath?: string; kind?: ConversationKind; spawnWorkdir?: Workdir;
    designation?: string; capabilityProfile?: string;
    /** Spawn children: the role's MCP ids. Omit = inherit (NULL). */
    mcpServers?: string[];
    permissionMode?: InteractionMode | null;
    sandbox?: import('@tierwyn/shared').SandboxSetting | null;
  }
): Conversation {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO conversations
       (id, project_id, title, created_at, updated_at, parent_conversation_id, template_name, workdir_path, kind, spawn_workdir, designation, capability_profile, mcp_servers, permission_mode, sandbox)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, input.projectId, input.title, now, now,
    input.parentConversationId ?? null, input.templateName ?? null, input.workdirPath ?? null,
    input.kind ?? 'chat', input.spawnWorkdir ?? null, input.designation ?? null, input.capabilityProfile ?? null,
    input.mcpServers ? JSON.stringify(input.mcpServers) : null,
    input.permissionMode ?? null,
    input.sandbox ?? null,
  );
  noteConversationsChanged([input.projectId], { created: [id] });
  return getConversation(db, id)!;
}

/** Creates the structural home conversation for a scheduled job (not a chat target). */
export function createScheduleHomeConversation(
  db: Database,
  input: { projectId: string; jobName: string; sandbox?: import('@tierwyn/shared').SandboxSetting | null },
): Conversation {
  return createConversation(db, {
    projectId: input.projectId,
    title: `⏱ ${input.jobName}`,
    kind: 'schedule_home',
    ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
  });
}

export function listConversations(
  db: Database,
  projectId: string,
  opts?: { includeArchived?: boolean },
): Conversation[] {
  // Correlated subquery pulls the most recent TERMINAL status event's payload
  // per conversation (events → sessions → conversations). Used to seed sidebar
  // indicators on initial load so an errored turn stays red across refresh.
  //
  // IMPORTANT: only done/error are returned. 'running'/'waiting' are live
  // transient states — after session_ended, the client clears its WS status
  // map and falls back to this value. If we returned the latest status
  // unconditionally, a session that crashed after emitting status:running
  // (no terminal status persisted) would leave a stuck amber dot on every
  // non-selected sidebar row until the next refresh.
  //
  // The `e.ts > c.last_viewed_at` gate (migration 014) drops the result once
  // the user has viewed the conversation since the status event fired — this
  // is the server-side equivalent of clearUnread() for the green unread path.
  // Without it, the sticky 'error' held by ws.ts:session_ended would survive
  // every refresh even after the user opened and read the errored turn.
  //
  // json_valid() guards against malformed payload rows crashing the entire
  // listing — toConversation's JS try/catch is the original fault-tolerance
  // surface; this preserves it now that we evaluate payload in SQL.
  return (
    db
      .prepare(
        `WITH RECURSIVE schedule_tree(id) AS (
           SELECT id FROM conversations WHERE kind = 'schedule_home' AND project_id = ?
           UNION ALL
           SELECT child.id
             FROM conversations child
             INNER JOIN schedule_tree st ON child.parent_conversation_id = st.id
         )
         SELECT c.*,
           (SELECT e.payload
              FROM events e
              JOIN sessions s ON s.id = e.session_id
             WHERE s.conversation_id = c.id AND e.type = 'status'
               AND json_valid(e.payload)
               AND json_extract(e.payload, '$.status') IN ('done', 'error')
               AND e.ts > c.last_viewed_at
             ORDER BY e.ts DESC, e.seq DESC
             LIMIT 1) AS last_status_payload,
           (SELECT s.agent_model_id FROM sessions s WHERE s.conversation_id = c.id
             ORDER BY s.created_at DESC LIMIT 1) AS last_profile_id,
           (SELECT s.agent_id FROM sessions s WHERE s.conversation_id = c.id
             ORDER BY s.created_at DESC LIMIT 1) AS last_agent_type
           FROM conversations c
          WHERE c.project_id = ?
            -- Hide ephemeral BTW answer-children (one-shot; fork is the promotion path).
            -- Spawn (↳) children of ordinary chats are intentionally NOT filtered.
            AND c.id NOT IN (SELECT child_conv_id FROM btw_queries WHERE child_conv_id IS NOT NULL)
            -- Hide the whole schedule tree (home + ⏱ runs + tick-spawned descendants).
            -- They belong in the Schedules tab. Do not key off schedule_runs:
            -- resume_conversation binds an ordinary project chat to a run row.
            AND c.id NOT IN (SELECT id FROM schedule_tree)
            AND (c.kind IS NULL OR c.kind = 'chat')
            -- Archived rows are excluded unless the caller explicitly asks
            -- (the sidebar's "Archived" toggle). The flag doubles as a
            -- retention-purge exemption (retention.ts).
            ${opts?.includeArchived ? '' : 'AND (c.archived IS NULL OR c.archived = 0)'}
          ORDER BY c.updated_at DESC`
      )
      .all(projectId, projectId) as Row[]
  ).map(toConversation);
}

export function getConversation(db: Database, id: string): Conversation | undefined {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
  return r ? toConversation(r) : undefined;
}

export interface ConversationWorkdirRow {
  id: string;
  title: string;
  workdirPath: string;
}

/** All conversation workdirs for a project (includes archived / schedule rows). */
export function listConversationWorkdirs(db: Database, projectId: string): ConversationWorkdirRow[] {
  return (
    db.prepare(
      `SELECT id, title, workdir_path AS workdirPath FROM conversations
       WHERE project_id = ? AND workdir_path IS NOT NULL`,
    ).all(projectId) as ConversationWorkdirRow[]
  );
}

/**
 * Null `workdir_path` for this project's conversations whose directory is gone.
 * Keeps the conversation row. Paths that still exist (even if not a git repo) stay.
 * Returns the number of rows nulled.
 */
export function pruneMissingConversationWorkdirs(db: Database, projectId: string): number {
  const rows = listConversationWorkdirs(db, projectId);
  const update = db.prepare(
    `UPDATE conversations SET workdir_path = NULL
     WHERE id = ? AND project_id = ? AND workdir_path IS NOT NULL`,
  );
  let n = 0;
  for (const row of rows) {
    if (existsSync(row.workdirPath)) continue;
    n += update.run(row.id, projectId).changes;
  }
  return n;
}

export function touchConversation(db: Database, id: string, ts = Date.now()): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, id);
}

/**
 * Mark a conversation as viewed at `ts` (default now). Called from the WS
 * subscribe handler — subscribe is the canonical "user opened this
 * conversation" signal. Used by listConversations' subquery to drop a stale
 * terminal status once the user has seen it, mirroring clearUnread() for the
 * error/done paths. Idempotent; safe to call on every subscribe/reconnect.
 */
export function markConversationViewed(db: Database, id: string, ts = Date.now()): void {
  db.prepare('UPDATE conversations SET last_viewed_at = ? WHERE id = ?').run(ts, id);
}

/**
 * Mark multiple (or all) conversations as viewed at `ts` (default now).
 * When `ids` is supplied, only those conversation IDs are touched in a transaction.
 * When `ids` is omitted, all conversations are marked as viewed.
 */
export function markConversationsViewed(db: Database, ids?: string[], ts = Date.now()): void {
  if (ids !== undefined) {
    if (ids.length === 0) return;
    const stmt = db.prepare('UPDATE conversations SET last_viewed_at = ? WHERE id = ?');
    const runMany = db.transaction((list: string[]) => {
      for (const id of list) {
        stmt.run(ts, id);
      }
    });
    runMany(ids);
  } else {
    db.prepare('UPDATE conversations SET last_viewed_at = ?').run(ts);
  }
}

/**
 * Manually mark a conversation as unread by resetting last_viewed_at to 0.
 * The next listConversations() call will then re-include any prior terminal
 * 'done' event in the subquery (since e.ts > 0), surfacing lastStatus='done'
 * to the client, which renders as the green unread dot. This is the inverse
 * of markConversationViewed and lets the user re-flag a conversation they
 * accidentally opened. Only works if a prior terminal event exists — empty
 * conversations have nothing to surface. Idempotent.
 */
export function markConversationUnread(db: Database, id: string): void {
  db.prepare('UPDATE conversations SET last_viewed_at = 0 WHERE id = ?').run(id);
}

export function renameConversation(db: Database, id: string, title: string): Conversation | undefined {
  const now = Date.now();
  const info = db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/**
 * Set (or clear) the operator-owned conversation description. A real clear
 * (`null` after text existed) writes `description_source = 'user'` so
 * auto-generation will not refill it. Clearing a never-described row is a
 * no-op — Edit → Save with an empty field must not poison first-prompt describe.
 */
export function setConversationDescription(
  db: Database, id: string, description: string | null,
): Conversation | undefined {
  const existing = getConversation(db, id);
  if (!existing) return undefined;
  if (description === null && !existing.description && !existing.descriptionSource) {
    return existing;
  }
  const now = Date.now();
  const info = db.prepare(
    "UPDATE conversations SET description = ?, description_source = 'user', updated_at = ? WHERE id = ?",
  ).run(description, now, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/**
 * Attach (or detach) a spawn template to a conversation. The template is read
 * at spawn time by the spawn route to drive child role/profile resolution.
 * Pass null/undefined to clear. Caller is responsible for template-name
 * validation against the templates store — this function only persists the
 * string. Returns the updated conversation, or undefined if no such row.
 */
export function setConversationTemplate(db: Database, id: string, templateName: string | null): Conversation | undefined {
  const now = Date.now();
  const info = db.prepare('UPDATE conversations SET template_name = ?, updated_at = ? WHERE id = ?').run(templateName, now, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/**
 * Set (or clear) the conversation-level delegate workdir pin. null clears it.
 * Value is validated by the caller (route) against 'shared'|'worktree'.
 * Returns the updated conversation, or undefined if no such row.
 */
export function setConversationSpawnWorkdir(db: Database, id: string, workdir: Workdir | null): Conversation | undefined {
  const now = Date.now();
  const info = db.prepare('UPDATE conversations SET spawn_workdir = ?, updated_at = ? WHERE id = ?').run(workdir, now, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/**
 * Set (or clear) the capability profile scoping this conversation's plugin
 * capabilities (migration 128). null/'' clears back to the default profile.
 * The id is validated by the caller (route) against the profile store — this
 * function only persists the string. Spawn/run tokens are minted from this
 * value at issue time, so a change here only takes effect after the parked
 * sessions' tokens are revoked and re-issued (route's job). Returns the
 * updated conversation, or undefined if no such row.
 */
export function setConversationCapabilityProfile(
  db: Database,
  id: string,
  capabilityProfile: string | null,
): Conversation | undefined {
  const now = Date.now();
  const info = db
    .prepare('UPDATE conversations SET capability_profile = ?, updated_at = ? WHERE id = ?')
    .run(capabilityProfile ?? null, now, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Set the MCP selection and native overrides (migration 140). null = inherit template default; [] = none.
 *  Ids are validated by the route. Takes effect next turn (route reaps parked sessions). */
export function setConversationMcpServers(
  db: Database,
  id: string,
  ids: string[] | null,
  disableNative?: boolean,
  disabledNative?: string[],
): Conversation | undefined {
  let serialized: string | null = null;
  if (disableNative || (disabledNative && disabledNative.length > 0)) {
    serialized = JSON.stringify({
      servers: ids,
      disableNative: Boolean(disableNative),
      disabledNative: disabledNative ?? [],
    });
  } else if (ids !== null) {
    serialized = JSON.stringify(ids);
  }
  const info = db
    .prepare('UPDATE conversations SET mcp_servers = ?, updated_at = ? WHERE id = ?')
    .run(serialized, Date.now(), id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Set the sticky per-conversation permission mode (migration 141, WP-2.1).
 *  null = inherit global CompactionSettings.interactionMode.
 *  Values: 'bypass' | 'questions' | 'prompt'. Takes effect live where supported,
 *  or reaps parked sessions so the next turn starts under the new mode. */
export function setConversationPermissionMode(
  db: Database,
  id: string,
  mode: InteractionMode | null,
): Conversation | undefined {
  if (mode !== null && !['bypass', 'questions', 'prompt'].includes(mode)) {
    throw new Error(`invalid permission_mode: ${mode}`);
  }
  const info = db
    .prepare('UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?')
    .run(mode, Date.now(), id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

export function setConversationSandbox(
  db: Database,
  id: string,
  v: import('@tierwyn/shared').SandboxSetting | null,
): Conversation | undefined {
  if (v !== null && v !== 'on' && v !== 'off') {
    throw new Error(`invalid sandbox: ${v}`);
  }
  const info = db
    .prepare('UPDATE conversations SET sandbox = ?, updated_at = ? WHERE id = ?')
    .run(v, Date.now(), id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Stage (or clear) the operator "+ menu" next-send action (migration 142).
 *  Does NOT bump updated_at — staging must not reorder the sidebar. */
export function setConversationPendingHandoffMode(
  db: Database,
  id: string,
  mode: PendingHandoffMode | null,
): Conversation | undefined {
  if (mode !== null && mode !== 'fresh' && mode !== 'summary') {
    throw new Error('invalid pending_handoff_mode: ' + mode);
  }
  const info = db
    .prepare('UPDATE conversations SET pending_handoff_mode = ? WHERE id = ?')
    .run(mode, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Set or clear operator-authored conversation rules (migration 143). null clears. */
export function setConversationRules(
  db: Database,
  id: string,
  rules: string | null,
): Conversation | undefined {
  const info = db
    .prepare('UPDATE conversations SET rules = ?, updated_at = ? WHERE id = ?')
    .run(rules, Date.now(), id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Set or clear the conversation preset stack (migration 144). null clears. */
export function setConversationRulePresetIds(
  db: Database,
  id: string,
  ids: string[] | null,
): Conversation | undefined {
  const info = db
    .prepare('UPDATE conversations SET rule_preset_ids = ?, updated_at = ? WHERE id = ?')
    .run(serialisePresetIds(ids), Date.now(), id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Clear a staged next-send action. Returns true only when a value was actually cleared. */
export function clearConversationPendingHandoffMode(db: Database, id: string): boolean {
  const info = db
    .prepare('UPDATE conversations SET pending_handoff_mode = NULL WHERE id = ? AND pending_handoff_mode IS NOT NULL')
    .run(id);
  return info.changes > 0;
}

/**
 * Set (or clear) the retention-purge exemption pin (migration 102).
 * Pinned conversations are never selected by the nightly retention purge.
 * Intentionally does NOT bump updated_at — pinning is bookkeeping, not
 * activity, and must not extend a conversation's lifetime.
 */
export function setConversationPinned(db: Database, id: string, pinned: boolean): Conversation | undefined {
  const info = db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/** Drop mesh edges that touch any of `ids` and evict their in-memory rate
 *  buckets (per-edge by edge id, per-caller + peer-list by conversation id).
 *  D10: archive/delete cascade *removes* edges (not revoke). */
export function dropMeshEdgesTouching(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id FROM mesh_edges WHERE from_conversation IN (${ph}) OR to_conversation IN (${ph})`,
    ).all(...ids, ...ids) as { id: string }[];
    db.prepare(
      `DELETE FROM mesh_edges WHERE from_conversation IN (${ph}) OR to_conversation IN (${ph})`,
    ).run(...ids, ...ids);
    evictMeshRates(rows.map((r) => r.id));
    evictMeshCallerRates(ids);
  } catch {
    // mesh_edges ships in migration 116; older fixtures may not have it
  }
}

/**
 * Set or clear the operator archive flag (migration 114). Archived=1 hides
 * the conversation from the default sidebar list and exempts it from the
 * nightly retention purge — archiving must preserve, not destroy.
 * Intentionally does NOT bump updated_at, mirroring setConversationPinned.
 */
export function setConversationArchived(db: Database, id: string, archived: boolean): Conversation | undefined {
  const info = db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  if (info.changes === 0) return undefined;
  if (archived) dropMeshEdgesTouching(db, [id]);
  const conv = getConversation(db, id);
  // Bulk archive does not broadcast per id; this hook covers that path.
  // Single PATCH already sends conversation_updated.archived — a coalesced
  // conversations_changed refetch is redundant and harmless.
  if (conv) noteConversationsChanged([conv.projectId], {});
  return conv;
}

/**
 * FW-15: replace the whole tag list for a conversation. `tags` must already be
 * normalised (see normaliseTags in @tierwyn/shared) — this function only
 * persists. Pass [] to clear.
 *
 * ponytail: deliberately does NOT bump updated_at, mirroring
 * setConversationPinned. The sidebar sorts by updatedAt desc; relabelling a
 * chat should not jump it to the top of the list.
 *
 * Applies to ANY conversation — unlike pin and move, tags have no root-only
 * rule, so spawn children and schedule runs are taggable too.
 */
export function updateConversationTags(db: Database, id: string, tags: string[]): Conversation | undefined {
  const info = db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

export function setConversationDesignation(
  db: Database, id: string, designation: string | null,
): Conversation | undefined {
  const info = db.prepare('UPDATE conversations SET designation = ? WHERE id = ?').run(designation, id);
  if (info.changes === 0) return undefined;
  return getConversation(db, id);
}

/**
 * FW-10: re-home a root conversation and its ENTIRE spawn subtree into another
 * project, atomically.
 *
 * Why the whole subtree: `listConversations` selects `WHERE c.project_id = ?`
 * and deliberately does NOT filter spawn children — the sidebar nests them
 * client-side by parent id. Moving only the root would leave every child
 * stranded in the source project as a parentless orphan row.
 *
 * `listDescendants` is called WITHOUT `hideBtw` on purpose: ephemeral BTW
 * answer-children are hidden from the sidebar but still belong to the tree,
 * and leaving them behind would orphan them in the source project.
 *
 * On a real cross-project move we also:
 *   - clear `workdir_path` (worktrees / pins belong to the old project root)
 *   - clear `sessions.native_session_id` for the tree (native resume is
 *     cwd-bound; the next prompt must start a fresh agent session under the
 *     destination project's root — including Repeat-question resends)
 *
 * Caller (route) is responsible for validating that the target project exists
 * and that the source is a movable root — this function only persists.
 *
 * Same-project call is a no-op: returns the row unchanged with `movedIds: []`
 * so `updated_at` is not bumped (which would reorder the sidebar for nothing).
 * Returns undefined if no such conversation.
 */
export function moveConversationTree(
  db: Database,
  id: string,
  projectId: string,
): { conversation: Conversation; movedIds: string[] } | undefined {
  const existing = getConversation(db, id);
  if (!existing) return undefined;
  if (existing.projectId === projectId) {
    return { conversation: existing, movedIds: [] };
  }

  const ids = [id, ...listDescendants(db, id).map((c) => c.id)];
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  db.transaction(() => {
    db.prepare(
      `UPDATE conversations
          SET project_id = ?, workdir_path = NULL, updated_at = ?
        WHERE id IN (${placeholders})`,
    ).run(projectId, now, ...ids);
    // Drop native resume handles so the next turn cannot reopen a session that
    // was started under the source project's cwd / worktree.
    db.prepare(
      `UPDATE sessions
          SET native_session_id = NULL, updated_at = ?
        WHERE conversation_id IN (${placeholders})
          AND native_session_id IS NOT NULL`,
    ).run(now, ...ids);
    db.prepare(
      `UPDATE global_tasks SET project_id = ? WHERE conversation_id IN (${placeholders})`,
    ).run(projectId, ...ids);
  })();

  const conversation = getConversation(db, id);
  if (!conversation) return undefined;
  if (ids.length > 0) {
    noteConversationsChanged([existing.projectId, projectId], {});
  }
  return { conversation, movedIds: ids };
}

export type DeleteConversationResult = {
  ok: boolean;
  /** Conversations removed (root first, then descendants). */
  deletedIds: string[];
  /** Captured before sessions rows are deleted — route unlinks native files post-commit. */
  nativeSessions: { agentId: string; nativeSessionId: string; projectId: string }[];
  /** TTS WAV absolute paths to unlink after the DB tx (rows cascade with conversations). */
  ttsWavPaths: string[];
};

/**
 * Delete a conversation, its full spawn subtree (children/grandchildren/…),
 * sessions, events, spawn edges/requests, and related rows.
 *
 * Explicit cascade in a transaction so it is correct regardless of PRAGMA foreign_keys.
 * TTS index rows cascade via FK; WAV paths are returned for best-effort disk cleanup.
 *
 * Schedule run rows that pointed at a deleted conversation have `conversation_id`
 * nulled so history remains without dangling FKs.
 */
export function deleteConversation(
  db: Database,
  id: string,
): DeleteConversationResult {
  const root = getConversation(db, id);
  if (!root) {
    return { ok: false, deletedIds: [], nativeSessions: [], ttsWavPaths: [] };
  }

  // Root + BFS descendants. Delete deepest first so parent FKs (spawn_edges) clear cleanly.
  const descendants = listDescendants(db, id);
  const ids = [...descendants.map((c) => c.id).reverse(), id];

  const placeholders = ids.map(() => '?').join(',');
  const nativeSessions = (db.prepare(
    `SELECT DISTINCT s.agent_id AS agentId, s.native_session_id AS nativeSessionId, c.project_id AS projectId
       FROM sessions s
       JOIN conversations c ON c.id = s.conversation_id
      WHERE s.conversation_id IN (${placeholders})
        AND s.native_session_id IS NOT NULL
        AND s.agent_id IS NOT NULL`,
  ).all(...ids) as { agentId: string; nativeSessionId: string; projectId: string }[]);

  // Collect WAV paths before rows vanish (tts_recordings ON DELETE CASCADE).
  // Layout matches ttsRecordings.absoluteWavPath: <recordingsDir>/<id>.wav
  let ttsWavPaths: string[] = [];
  try {
    const rows = db.prepare(
      `SELECT id FROM tts_recordings WHERE conversation_id IN (${placeholders})`,
    ).all(...ids) as { id: string }[];
    const dir = getTtsRecordingsDir();
    ttsWavPaths = rows.map((r) => join(dir, `${r.id}.wav`));
  } catch {
    ttsWavPaths = [];
  }

  const tx = db.transaction(() => {
    // Detach schedule runs / bound jobs before removing conversations.
    // A live run whose conversation vanishes can never settle — end it now
    // instead of leaving it `running` until the reclaim timeout.
    try {
      db.prepare(
        `UPDATE schedule_steps SET status = 'blocked'
          WHERE status = 'running' AND id IN (
            SELECT step_id FROM schedule_runs
             WHERE conversation_id IN (${placeholders}) AND status IN ('pending','running'))`,
      ).run(...ids);
      db.prepare(
        `UPDATE schedule_runs SET status = 'failed', finished_at = ?, error = 'conversation_deleted'
          WHERE conversation_id IN (${placeholders}) AND status IN ('pending','running')`,
      ).run(Date.now(), ...ids);
    } catch {
      // schedule tables may not exist in older test DBs — ignore.
    }
    db.prepare(
      `UPDATE schedule_runs SET conversation_id = NULL WHERE conversation_id IN (${placeholders})`,
    ).run(...ids);
    try {
      // Deleted conversation = no actionable error; drop the orphaned failed row.
      db.prepare(
        `DELETE FROM schedule_runs WHERE conversation_id IS NULL AND status = 'failed' AND error = 'conversation_deleted'`,
      ).run();
    } catch {
      // ignore (older test DBs)
    }
    try {
      db.prepare(
        `UPDATE schedule_jobs SET bound_conversation_id = NULL WHERE bound_conversation_id IN (${placeholders})`,
      ).run(...ids);
    } catch {
      // schedule_jobs may not exist in older test DBs — ignore.
    }

    // spawn_edges FKs have no ON DELETE CASCADE — clear all edges touching the set.
    try {
      db.prepare(
        `DELETE FROM spawn_edges
          WHERE parent_conversation_id IN (${placeholders})
             OR child_conversation_id IN (${placeholders})`,
      ).run(...ids, ...ids);
    } catch {
      // table may be absent in very old fixtures
    }
    dropMeshEdgesTouching(db, ids);

    db.prepare(
      `UPDATE global_tasks SET conversation_id = NULL WHERE conversation_id IN (${placeholders})`,
    ).run(...ids);

    for (const convId of ids) {
      db.prepare(
        'DELETE FROM spawn_requests WHERE parent_conversation_id = ? OR child_conversation_id = ?',
      ).run(convId, convId);
      db.prepare('DELETE FROM checkpoints WHERE conversation_id = ?').run(convId);
      db.prepare('DELETE FROM draft_prompts WHERE conversation_id = ?').run(convId);
      db.prepare('DELETE FROM handoffs WHERE conversation_id = ?').run(convId);
      db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(convId);
      db.prepare(
        'DELETE FROM btw_queries WHERE parent_conv_id = ? OR child_conv_id = ?',
      ).run(convId, convId);
      // TTS rows: CASCADE on conversation delete when FK pragma is on; explicit for safety.
      try {
        db.prepare('DELETE FROM tts_recordings WHERE conversation_id = ?').run(convId);
      } catch { /* pre-migration */ }
      db.prepare(
        `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE conversation_id = ?)`,
      ).run(convId);
      db.prepare('DELETE FROM sessions WHERE conversation_id = ?').run(convId);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
    }
    return true;
  });
  const ok = tx();
  if (ok) noteConversationsChanged([root.projectId], { deleted: ids });
  return {
    ok,
    deletedIds: ok ? ids : [],
    nativeSessions: ok ? nativeSessions : [],
    ttsWavPaths: ok ? ttsWavPaths : [],
  };
}

export function forkConversation(
  db: Database,
  conversationId: string,
  eventId: string,
  title?: string
): Conversation {
  const tx = db.transaction(() => {
    // 1. Get original conversation details
    const origConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as Row | undefined;
    if (!origConv) {
      throw new Error('Original conversation not found');
    }

    // 2. Find the target event to get its ts and seq
    const targetEvent = db.prepare('SELECT ts, seq FROM events WHERE id = ?').get(eventId) as { ts: number; seq: number } | undefined;
    if (!targetEvent) {
      throw new Error('Target event not found');
    }

    // 3. Get all events in the conversation up to the target event (ordered by ts, seq)
    const eventsToCopy = db.prepare(`
      SELECT e.* FROM events e
      JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
        AND (e.ts < ? OR (e.ts = ? AND e.seq <= ?))
      ORDER BY e.ts ASC, e.seq ASC
    `).all(conversationId, targetEvent.ts, targetEvent.ts, targetEvent.seq) as {
      id: string; session_id: string; type: string; payload: string;
      sender: string; agent_model_id: string | null; seq: number; ts: number;
    }[];

    if (eventsToCopy.length === 0) {
      throw new Error('No events found to copy');
    }

    // 4. Create new conversation
    const now = Date.now();
    const newConvId = randomUUID();
    const newTitle = title?.trim() || `Fork of ${origConv.title}`;
    db.prepare(
      `INSERT INTO conversations (
        id, project_id, title, created_at, updated_at, description, description_source, tags,
        template_name, spawn_workdir, designation, capability_profile, mcp_servers, permission_mode, effort, sandbox, rules, rule_preset_ids
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      newConvId, origConv.project_id, newTitle, now, now,
      origConv.description, origConv.description_source,
      // FW-15: a fork is a snapshot, so it inherits the labels. `?? '[]'`
      // guards a pre-111 row read back through SELECT * on an old DB file.
      origConv.tags ?? '[]',
      origConv.template_name ?? null,
      origConv.spawn_workdir ?? null,
      origConv.designation ?? null,
      origConv.capability_profile ?? null,
      origConv.mcp_servers ?? null,
      origConv.permission_mode ?? null,
      origConv.effort ?? null,
      origConv.sandbox ?? null,
      origConv.rules ?? null,
      origConv.rule_preset_ids ?? null,
    );

    // 5. Get the unique session IDs from the events to copy
    const uniqueSessionIds = Array.from(new Set(eventsToCopy.map(e => e.session_id)));

    // 6. Copy sessions and build old_session_id -> new_session_id map dynamically
    const sessionMap = new Map<string, string>();
    for (const oldSessId of uniqueSessionIds) {
      const oldSess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(oldSessId) as Record<string, any> | undefined;
      if (oldSess) {
        const newSessId = randomUUID();
        const keys = Object.keys(oldSess).filter(k => k !== 'id' && k !== 'conversation_id' && k !== 'native_session_id');
        const columns = ['id', 'conversation_id', ...keys];
        const placeholders = columns.map(() => '?').join(', ');
        const values = [newSessId, newConvId, ...keys.map(k => oldSess[k])];
        
        db.prepare(`
          INSERT INTO sessions (${columns.join(', ')})
          VALUES (${placeholders})
        `).run(...values);
        
        sessionMap.set(oldSessId, newSessId);
      }
    }

    // 7. Copy events with new IDs and session IDs dynamically
    for (const oldEv of eventsToCopy) {
      const newSessId = sessionMap.get(oldEv.session_id);
      if (!newSessId) continue;
      const newEvId = randomUUID();
      const keys = Object.keys(oldEv).filter(k => k !== 'id' && k !== 'session_id');
      const columns = ['id', 'session_id', ...keys];
      const placeholders = columns.map(() => '?').join(', ');
      const values = [newEvId, newSessId, ...keys.map(k => (oldEv as any)[k])];

      db.prepare(`
        INSERT INTO events (${columns.join(', ')})
        VALUES (${placeholders})
      `).run(...values);
    }

    const newConvRow = db.prepare('SELECT * FROM conversations WHERE id = ?').get(newConvId) as Row;
    return toConversation(newConvRow);
  });

  const created = tx();
  noteConversationsChanged([created.projectId], { created: [created.id] });
  return created;
}

/** Thrown by duplicateConversation when the source id does not exist. The
 *  duplicate route pre-checks with getConversation, so this only fires for a
 *  direct repo caller or a TOCTOU race — it exists so neither 500s blindly. */
export class ConversationNotFound extends Error {
  constructor(id: string) {
    super(`no such conversation: ${id}`);
    this.name = 'ConversationNotFound';
  }
}

/** D2: default copy set — the human-readable transcript. */
const DUPLICATE_EVENT_TYPES = ['prompt', 'message'] as const;
/** D2: `includeTools: true` adds the tool/IO trail. `status`, `steer` and the
 *  `interaction_*` pair stay out either way — they only mean something to a
 *  live adapter session, which a duplicate deliberately does not have. */
const DUPLICATE_EVENT_TYPES_WITH_TOOLS = [
  'prompt', 'message', 'tool_call', 'tool_result', 'file_change', 'error',
] as const;

export interface DuplicateConversationOptions {
  /** Target project. Defaults to the source's project. Caller validates existence. */
  projectId?: string;
  /** Also copy tool_call/tool_result/file_change/error. Default false. */
  includeTools?: boolean;
  /** Override the `Copy of …` default. Trimmed; blank falls back to the default. */
  title?: string;
  /** Copy only events with ts <= this (inclusive). Used by /btw fork. */
  untilTs?: number;
}

interface DuplicateEventRow {
  type: string;
  payload: string;
  sender: string;
  agent_model_id: string | null;
  ts: number;
}

/**
 * FW-13: snapshot one conversation into a brand-new ROOT chat.
 *
 * Unlike forkConversation this takes no eventId (the whole transcript is
 * copied), copies no sessions (one NULL-everything stub carries the events —
 * D1), and never inherits parentage — the copy is always a root chat. Drafts, spawn_edges, checkpoints,
 * summaries, handoffs and TTS recordings are all left behind by construction:
 * this function only ever writes `conversations`, one `sessions` row, and
 * `events`.
 *
 * ponytail: events go back in through appendEvent so the spawn/run-token
 * redactors cannot be skipped, and migration 109's AFTER INSERT triggers
 * index the copy into event_fts for free. Cost is a JSON round-trip per
 * event; a raw INSERT is the upgrade path if a 10k-event copy ever feels slow.
 */
export function duplicateConversation(
  db: Database,
  sourceId: string,
  opts: DuplicateConversationOptions = {},
): Conversation {
  return db.transaction(() => {
    const src = db.prepare('SELECT * FROM conversations WHERE id = ?').get(sourceId) as Row | undefined;
    if (!src) throw new ConversationNotFound(sourceId);

    const types = opts.includeTools ? DUPLICATE_EVENT_TYPES_WITH_TOOLS : DUPLICATE_EVENT_TYPES;
    const placeholders = types.map(() => '?').join(',');
    const untilClause = opts.untilTs !== undefined ? 'AND e.ts <= ?' : '';
    const rows = db.prepare(
      `SELECT e.type, e.payload, e.sender, e.agent_model_id, e.ts
         FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id = ?
          AND e.type IN (${placeholders})
          ${untilClause}
        ORDER BY e.ts ASC, e.seq ASC`,
    ).all(
      sourceId,
      ...types,
      ...(opts.untilTs !== undefined ? [opts.untilTs] : []),
    ) as DuplicateEventRow[];

    const now = Date.now();
    const newId = randomUUID();
    db.prepare(
      `INSERT INTO conversations
         (id, project_id, title, created_at, updated_at, parent_conversation_id,
          template_name, workdir_path, kind, spawn_workdir,
          description, description_source, tags, designation, capability_profile, mcp_servers, permission_mode, effort, sandbox, rules, rule_preset_ids)
       VALUES (?,?,?,?,?,?,?,?,'chat',?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId,
      opts.projectId ?? src.project_id,
      opts.title?.trim() || `Copy of ${src.title}`,
      now, now,
      null,
      src.template_name, src.workdir_path, src.spawn_workdir,
      src.description, src.description_source,
      // `?? '[]'` guards a pre-111 row read back through SELECT * on an old DB file.
      src.tags ?? '[]',
      src.designation ?? null,
      src.capability_profile ?? null,
      src.mcp_servers ?? null,
      src.permission_mode ?? null,
      src.effort ?? null,
      src.sandbox ?? null,
      src.rules ?? null,
      src.rule_preset_ids ?? null,
    );

    if (rows.length > 0) {
      // D1: ONE stub session. NULL agent/model/native so nothing downstream
      // mistakes the copy for a resumable native session.
      const stubSessionId = randomUUID();
      db.prepare(
        `INSERT INTO sessions
           (id, conversation_id, agent_id, agent_model_id, native_session_id, created_at, updated_at)
         VALUES (?,?,NULL,NULL,NULL,?,?)`,
      ).run(stubSessionId, newId, now, now);

      let seq = 0;
      for (const row of rows) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload);
        } catch {
          continue; // hand-corrupted cell — skip it rather than fail the whole copy
        }
        appendEvent(db, {
          sessionId: stubSessionId,
          type: row.type,
          payload,
          sender: row.sender as 'user' | 'agent' | 'system',
          agentModelId: row.agent_model_id ?? undefined,
          // Renumbered: source seq is per-session and would collide once every
          // session's events land on one stub. ts is preserved verbatim.
          seq: seq++,
          ts: row.ts,
        });
      }
    }

    const created = getConversation(db, newId)!;
    noteConversationsChanged([created.projectId], { created: [created.id] });
    return created;
  })();
}

/** IDs of conversations whose parent is `parentId`. Used by the breadth cap. */
export function childConversationIds(db: Database, parentId: string): string[] {
  return (db.prepare('SELECT id FROM conversations WHERE parent_conversation_id = ?').all(parentId) as { id: string }[])
    .map((r) => r.id);
}

/** Depth from the root: root = 0, child = 1, grandchild = 2. Walks the parent
 *  chain. ponytail: O(depth) walk; a stored `depth` column is the upgrade path
 *  if MAX_SPAWN_DEPTH ever rises past a couple hops.
 *  UI tree only — schedule runs under a `schedule_home` parent are depth 1 here
 *  even though they are spawn-policy roots (see spawnPolicyDepth). */
export function conversationDepth(db: Database, id: string): number {
  const stmt = db.prepare('SELECT parent_conversation_id FROM conversations WHERE id = ?');
  let depth = 0;
  let cur: string | undefined = id;
  while (cur) {
    const row = stmt.get(cur) as { parent_conversation_id: string | null } | undefined;
    if (!row || !row.parent_conversation_id) break;
    cur = row.parent_conversation_id;
    depth += 1;
  }
  return depth;
}

/**
 * Depth for spawn policy (preamble injection, concurrent vs grandchild caps,
 * MAX_SPAWN_DEPTH). Schedule tick conversations hang under `schedule_home` for
 * the sidebar, but they are orchestrators — same as a normal depth-0 chat.
 * Walk stops at a `schedule_home` parent so:
 *   home (schedule_home) → ⏱ run = 0 → spawn child = 1 → grandchild = 2
 * True agent trees (no schedule_home) match conversationDepth.
 */
export function spawnPolicyDepth(db: Database, id: string): number {
  const stmt = db.prepare(
    'SELECT parent_conversation_id, kind FROM conversations WHERE id = ?',
  );
  let depth = 0;
  let cur: string | undefined = id;
  while (cur) {
    const row = stmt.get(cur) as
      | { parent_conversation_id: string | null; kind: string }
      | undefined;
    if (!row || !row.parent_conversation_id) return depth;
    const parent = stmt.get(row.parent_conversation_id) as
      | { parent_conversation_id: string | null; kind: string }
      | undefined;
    // Direct child of the job home = schedule fire orchestrator (policy root).
    if (parent?.kind === 'schedule_home') return depth;
    cur = row.parent_conversation_id;
    depth += 1;
  }
  return depth;
}

/**
 * True if the conversation is a top-level orchestrator / policy root (depth 0):
 * - A normal chat conversation with no parent (depth 0)
 * - A schedule run conversation spawned directly by a schedule (direct child of `schedule_home`, policy depth 0)
 *
 * False for:
 * - `schedule_home` container rows (which are inert grouping anchors, not orchestrators)
 * - Subagents spawned by either chat roots or schedule runs (depth >= 1)
 */
export function isPolicyRoot(
  db: Database,
  convOrId: string | { id: string; kind?: string; parentConversationId?: string | null },
): boolean {
  if (typeof convOrId === 'string') {
    const row = db.prepare('SELECT id, kind, parent_conversation_id AS parentConversationId FROM conversations WHERE id = ?').get(convOrId) as { id: string; kind: string; parentConversationId: string | null } | undefined;
    if (!row || row.kind === 'schedule_home') return false;
    if (!row.parentConversationId) return true;
    return spawnPolicyDepth(db, row.id) === 0;
  }
  if (convOrId.kind === 'schedule_home') return false;
  if (convOrId.kind === undefined) {
    const row = db.prepare('SELECT kind FROM conversations WHERE id = ?').get(convOrId.id) as { kind: string } | undefined;
    if (!row || row.kind === 'schedule_home') return false;
  }
  if (!convOrId.parentConversationId) return true;
  return spawnPolicyDepth(db, convOrId.id) === 0;
}

/**
 * BFS flat list of every descendant of `rootId` (children, grandchildren, ...).
 * Used by the schedule tree endpoint to attach a run's spawn subtree, and by
 * delete paths that must purge the full subtree.
 *
 * `hideBtw: true` skips ephemeral /btw answer-children (same rule as
 * `listConversations`) so schedule-originated trees match the projects tab.
 * Delete/hard-purge callers must leave this off so BTW children still clean up.
 */
export function listDescendants(
  db: Database,
  rootId: string,
  opts?: { hideBtw?: boolean },
): Conversation[] {
  const btwChildIds = opts?.hideBtw ? listBtwChildConversationIds(db) : null;

  const result: Conversation[] = [];
  const visited = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of childConversationIds(db, current)) {
      if (visited.has(childId)) continue;
      if (btwChildIds?.has(childId)) continue;
      visited.add(childId);
      const conv = getConversation(db, childId);
      if (conv) result.push(conv);
      queue.push(childId);
    }
  }
  return result;
}

export function markStopped(db: Database, id: string, at: number): void {
  db.prepare('UPDATE conversations SET stopped_at = ? WHERE id = ?').run(at, id);
}

export function getStoppedAt(db: Database, id: string): number | null {
  const row = db.prepare('SELECT stopped_at FROM conversations WHERE id = ?').get(id) as
    | { stopped_at: number | null }
    | undefined;
  return row?.stopped_at ?? null;
}

/** Derivation minus the live-session check: stopped_at is set and is at least
 *  as new as the last session row. A later revival creates a newer session, so
 *  this flips false with no clearing write. */
export function isStopped(db: Database, id: string): boolean {
  const stoppedAt = getStoppedAt(db, id);
  if (stoppedAt == null) return false;
  return stoppedAt >= (lastSessionForConversation(db, id)?.createdAt ?? 0);
}

/** True iff `childId` is a STRICT descendant of `ancestorId` (walks the
 *  parent chain starting at the child's parent — self is not a descendant).
 *  🔒 Security helper: the descent gate for GET /spawn/:id/result and
 *  POST /spawn/:id/message (threat-model concern 1). */
export function isDescendedFrom(db: Database, childId: string, ancestorId: string): boolean {
  const stmt = db.prepare('SELECT parent_conversation_id FROM conversations WHERE id = ?');
  let cur = (stmt.get(childId) as { parent_conversation_id: string | null } | undefined)?.parent_conversation_id ?? undefined;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = (stmt.get(cur) as { parent_conversation_id: string | null } | undefined)?.parent_conversation_id ?? undefined;
  }
  return false;
}

/**
 * Walk parent_conversation_id up to the terminal ancestor and return its id.
 * Returns `id` itself if the conversation has no parent (it IS the root).
 * Does NOT stop at schedule_home — recordings belong to real conversations
 * regardless of spawn-policy root (a schedule_home is a real conversation
 * that can hold recordings). O(depth) walk.
 *
 * Same acyclic-tree assumption as isDescendedFrom / conversationDepth; no
 * visited-set guard. If a cycle ever appeared in the DB, the existing walkers
 * would infinite-loop too, so this introduces no new risk.
 */
export function getRootAncestor(db: Database, id: string): string {
  const stmt = db.prepare('SELECT parent_conversation_id FROM conversations WHERE id = ?');
  let cur = id;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = stmt.get(cur) as { parent_conversation_id: string | null } | undefined;
    if (!row || !row.parent_conversation_id) return cur;
    cur = row.parent_conversation_id;
  }
}

