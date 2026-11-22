import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type {
  GlobalTask, GlobalTaskDto, GlobalTaskCounts, GlobalTaskStatus, GlobalTaskView,
} from '@tierwyn/shared';
import { GLOBAL_TASK_LIMITS } from '@tierwyn/shared';
import { getGlobalTasksSettings } from './settings.js';

export interface NewGlobalTask {
  projectId: string;
  conversationId: string;
  sessionId: string;
  conversationTitle: string;
  title: string;
  description: string;
  testing: string;
  progress: string;
  now: number;
}

export interface AgentTaskPatch {
  title?: string;
  description?: string;
  testing?: string;
  progress?: string;
  status?: GlobalTaskStatus;
}

interface Row {
  id: string;
  project_id: string;
  conversation_id: string | null;
  session_id: string | null;
  conversation_title: string;
  title: string;
  description: string;
  testing: string;
  progress: string;
  status: GlobalTaskStatus;
  completed_by: 'agent' | 'operator' | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  hidden_at: number | null;
}

interface DtoRow extends Row {
  project_name: string | null;
  conv_archived: number | null;
  parent_id: string | null;
  parent_title: string | null;
  parent_kind: string | null;
}

function toTask(r: Row): GlobalTask {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    conversationTitle: r.conversation_title,
    title: r.title,
    description: r.description,
    testing: r.testing,
    progress: r.progress,
    status: r.status,
    completedBy: r.completed_by ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? undefined,
    hiddenAt: r.hidden_at ?? undefined,
  };
}

function toDto(r: DtoRow, isLive: (cid: string) => boolean): GlobalTaskDto {
  return {
    ...toTask(r),
    projectName: r.project_name ?? '',
    conversationArchived: r.conv_archived === 1 ? true : undefined,
    parentConversationId: r.parent_id ?? undefined,
    parentConversationTitle: r.parent_title ?? undefined,
    fromSchedule: r.parent_kind === 'schedule_home' ? true : undefined,
    live: r.conversation_id ? isLive(r.conversation_id) : false,
  };
}

const DTO_SELECT = `
SELECT t.*, p.name AS project_name, c.archived AS conv_archived,
       c.parent_conversation_id AS parent_id, pc.title AS parent_title, pc.kind AS parent_kind
  FROM global_tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN conversations c ON c.id = t.conversation_id
  LEFT JOIN conversations pc ON pc.id = c.parent_conversation_id`;

function viewClause(view: GlobalTaskView): string {
  if (view === 'hidden') return 't.hidden_at IS NOT NULL';
  if (view === 'completed') return "t.status = 'completed' AND t.hidden_at IS NULL";
  return "t.status = 'in_progress' AND t.hidden_at IS NULL";
}

export function createGlobalTask(db: Database, t: NewGlobalTask): GlobalTask {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO global_tasks (
      id, project_id, conversation_id, session_id, conversation_title,
      title, description, testing, progress, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)
  `).run(
    id, t.projectId, t.conversationId, t.sessionId, t.conversationTitle,
    t.title, t.description, t.testing, t.progress, t.now, t.now,
  );
  return getGlobalTask(db, id)!;
}

export function getGlobalTask(db: Database, id: string): GlobalTask | undefined {
  const r = db.prepare('SELECT * FROM global_tasks WHERE id = ?').get(id) as Row | undefined;
  return r ? toTask(r) : undefined;
}

export function listConversationTasks(db: Database, conversationId: string): GlobalTask[] {
  const rows = db.prepare(
    `SELECT * FROM global_tasks
      WHERE conversation_id = ? AND hidden_at IS NULL
      ORDER BY updated_at DESC`,
  ).all(conversationId) as Row[];
  return rows.map(toTask);
}

export function openTaskIds(db: Database, conversationId: string): string[] {
  return (db.prepare(
    `SELECT id FROM global_tasks
      WHERE conversation_id = ? AND status = 'in_progress' AND hidden_at IS NULL`,
  ).all(conversationId) as { id: string }[]).map((r) => r.id);
}

export function agentUpdateGlobalTask(
  db: Database,
  id: string,
  patch: AgentTaskPatch,
  meta: { sessionId: string; conversationTitle: string; now: number },
): GlobalTask {
  const existing = getGlobalTask(db, id);
  if (!existing) throw new Error(`global task ${id} not found`);
  const title = patch.title ?? existing.title;
  const description = patch.description ?? existing.description;
  const testing = patch.testing ?? existing.testing;
  const progress = patch.progress ?? existing.progress;
  const status = patch.status ?? existing.status;
  let completedBy: 'agent' | 'operator' | null = existing.completedBy ?? null;
  let completedAt: number | null = existing.completedAt ?? null;
  if (patch.status === 'completed' && existing.status !== 'completed') {
    completedBy = 'agent';
    completedAt = meta.now;
  } else if (patch.status === 'in_progress' && existing.status !== 'in_progress') {
    completedBy = null;
    completedAt = null;
  }
  db.prepare(`
    UPDATE global_tasks
       SET title = ?, description = ?, testing = ?, progress = ?, status = ?,
           completed_by = ?, completed_at = ?,
           session_id = ?, conversation_title = ?, updated_at = ?
     WHERE id = ?
  `).run(
    title, description, testing, progress, status,
    completedBy, completedAt,
    meta.sessionId, meta.conversationTitle, meta.now, id,
  );
  return getGlobalTask(db, id)!;
}

export function operatorUpdateGlobalTask(
  db: Database,
  id: string,
  patch: { status?: GlobalTaskStatus; hidden?: boolean },
  now: number,
): GlobalTask | undefined {
  const existing = getGlobalTask(db, id);
  if (!existing) return undefined;
  let status = existing.status;
  let completedBy: 'agent' | 'operator' | null = existing.completedBy ?? null;
  let completedAt: number | null = existing.completedAt ?? null;
  let updatedAt = existing.updatedAt;
  let hiddenAt: number | null = existing.hiddenAt ?? null;
  if (patch.status !== undefined && patch.status !== existing.status) {
    status = patch.status;
    updatedAt = now;
    if (status === 'completed') {
      completedBy = 'operator';
      completedAt = now;
    } else {
      completedBy = null;
      completedAt = null;
    }
  }
  if (patch.hidden === true && hiddenAt == null) hiddenAt = now;
  if (patch.hidden === false) hiddenAt = null;
  db.prepare(`
    UPDATE global_tasks
       SET status = ?, completed_by = ?, completed_at = ?, updated_at = ?, hidden_at = ?
     WHERE id = ?
  `).run(status, completedBy, completedAt, updatedAt, hiddenAt, id);
  return getGlobalTask(db, id);
}

export function hideAllCompleted(db: Database, now: number): string[] {
  const ids = (db.prepare(
    `SELECT id FROM global_tasks WHERE status = 'completed' AND hidden_at IS NULL`,
  ).all() as { id: string }[]).map((r) => r.id);
  if (ids.length) {
    db.prepare(
      `UPDATE global_tasks SET hidden_at = ? WHERE status = 'completed' AND hidden_at IS NULL`,
    ).run(now);
  }
  return ids;
}

export function deleteGlobalTask(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM global_tasks WHERE id = ?').run(id).changes > 0;
}

export function deleteAllHidden(db: Database): string[] {
  const ids = (db.prepare(
    `SELECT id FROM global_tasks WHERE hidden_at IS NOT NULL`,
  ).all() as { id: string }[]).map((r) => r.id);
  if (ids.length) db.prepare('DELETE FROM global_tasks WHERE hidden_at IS NOT NULL').run();
  return ids;
}

export function listGlobalTaskDtos(
  db: Database,
  q: { view: GlobalTaskView; projectId?: string; isLive: (cid: string) => boolean },
): { tasks: GlobalTaskDto[]; truncated: boolean } {
  const where = [viewClause(q.view)];
  const params: unknown[] = [];
  if (q.projectId) {
    where.push('t.project_id = ?');
    params.push(q.projectId);
  }
  const rows = db.prepare(
    `${DTO_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC LIMIT ?`,
  ).all(...params, GLOBAL_TASK_LIMITS.listMax + 1) as DtoRow[];
  const truncated = rows.length > GLOBAL_TASK_LIMITS.listMax;
  const sliced = truncated ? rows.slice(0, GLOBAL_TASK_LIMITS.listMax) : rows;
  return { tasks: sliced.map((r) => toDto(r, q.isLive)), truncated };
}

export function getGlobalTaskDto(
  db: Database,
  id: string,
  isLive: (cid: string) => boolean,
): GlobalTaskDto | undefined {
  const r = db.prepare(`${DTO_SELECT} WHERE t.id = ?`).get(id) as DtoRow | undefined;
  return r ? toDto(r, isLive) : undefined;
}

export function countGlobalTasks(db: Database): GlobalTaskCounts {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(status = 'in_progress' AND hidden_at IS NULL), 0) AS inProgress,
      COALESCE(SUM(status = 'completed' AND hidden_at IS NULL), 0) AS completedVisible,
      COALESCE(SUM(hidden_at IS NOT NULL), 0) AS hidden
    FROM global_tasks
  `).get() as { inProgress: number; completedVisible: number; hidden: number };
  return {
    inProgress: Number(r.inProgress),
    completedVisible: Number(r.completedVisible),
    hidden: Number(r.hidden),
  };
}

export function sweepHiddenGlobalTasks(db: Database, hiddenBeforeMs: number): number {
  // Feature off = nothing touches task data, retention included: hidden rows
  // survive until the operator re-enables (settings toggle is the only sweep
  // gate, so the nightly pass is a no-op while disabled).
  if (!getGlobalTasksSettings(db).enabled) return 0;
  return db.prepare(
    'DELETE FROM global_tasks WHERE hidden_at IS NOT NULL AND hidden_at < ?',
  ).run(hiddenBeforeMs).changes;
}

export function hiddenSweepCutoff(now: number, days: number): number | null {
  if (days <= 0) return null;
  return now - days * 86_400_000;
}
