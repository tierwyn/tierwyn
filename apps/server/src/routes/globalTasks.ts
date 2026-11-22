import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import type { Conversation, GlobalTaskStatus, GlobalTaskView, ServerFrame } from '@tierwyn/shared';
import { GLOBAL_TASK_LIMITS, globalTasksAllowed } from '@tierwyn/shared';
import { peekSpawnToken, touchSpawnToken } from '../spawn/tokens.js';
import { redactAll } from '../secrets/redactAll.js';
import { getConversation, isPolicyRoot } from '../repositories/conversations.js';
import { getGlobalTasksSettings, updateGlobalTasksSettings } from '../repositories/settings.js';
import {
  createGlobalTask, getGlobalTask, listConversationTasks, openTaskIds,
  agentUpdateGlobalTask, operatorUpdateGlobalTask, hideAllCompleted,
  deleteGlobalTask, deleteAllHidden, listGlobalTaskDtos, getGlobalTaskDto,
  countGlobalTasks, type AgentTaskPatch,
} from '../repositories/globalTasks.js';
import { helpHint } from '../spawn/agentHelp.js';

export interface GlobalTaskRouteDeps {
  getDb: () => Database;
  now?: () => number;
  isLive: (conversationId: string) => boolean;
  broadcastAll: (frame: ServerFrame) => void;
}

type Guarded = { token: string; entry: NonNullable<ReturnType<typeof peekSpawnToken>>; conv: Conversation; db: Database };

const AGENT_FIELDS = new Set(['title', 'description', 'testing', 'progress', 'status']);

function nowOf(deps: GlobalTaskRouteDeps): number {
  return deps.now ? deps.now() : Date.now();
}

export function broadcastTask(
  deps: GlobalTaskRouteDeps,
  db: Database,
  taskId: string,
  op: 'upsert' | 'delete',
): void {
  const counts = countGlobalTasks(db);
  if (op === 'delete') {
    deps.broadcastAll({ type: 'global_task_updated', taskId, op: 'delete', counts });
    return;
  }
  const task = getGlobalTaskDto(db, taskId, deps.isLive);
  deps.broadcastAll({ type: 'global_task_updated', taskId, op: 'upsert', task, counts });
}

function guard(req: Request, res: Response, deps: GlobalTaskRouteDeps): Guarded | undefined {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  const entry = peekSpawnToken(token);
  if (!token || !entry) { res.status(401).json({ error: 'a live session bearer token is required' }); return; }
  if (!entry.scope.has('tasks')) { res.status(403).json({ error: 'this token cannot write global tasks', decision: 'no_tasks_capability', ...helpHint('tasks') }); return; }
  if (req.params.id && entry.conversationId !== req.params.id) { res.status(403).json({ error: 'a conversation may only manage its own tasks', decision: 'cross_conversation', ...helpHint('tasks') }); return; }
  const convId = req.params.id ?? entry.conversationId;
  const db = deps.getDb();
  const s = getGlobalTasksSettings(db);
  if (!s.enabled) { res.status(403).json({ error: 'global tasks are disabled on this server', decision: 'global_tasks_off', ...helpHint('tasks') }); return; }
  const conv = getConversation(db, convId);
  if (!conv) { res.status(404).json({ error: 'conversation not found' }); return; }
  if (!globalTasksAllowed(s, isPolicyRoot(db, conv))) {
    res.status(403).json({ error: 'only top-level conversations record global tasks — report through your ## Result', decision: 'global_tasks_root_only', ...helpHint('tasks') }); return;
  }
  return { token, entry, conv, db };
}

/** Validates + normalises a body. `requireTitle` for POST. Returns an error string or the clean patch. */
export function parseAgentTaskBody(body: unknown, opts: { create: boolean }): { ok: true; patch: AgentTaskPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'JSON object body required' };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!AGENT_FIELDS.has(k) || (opts.create && k === 'status')) return { ok: false, error: `field '${k}' is not accepted` };
  const patch: AgentTaskPatch = {};
  if ('title' in b) {
    if (typeof b.title !== 'string') return { ok: false, error: 'title must be a string' };
    const t = redactAll(b.title).replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, error: 'title must not be empty' };
    if (t.length > GLOBAL_TASK_LIMITS.title) return { ok: false, error: `title too long (max ${GLOBAL_TASK_LIMITS.title})` };
    patch.title = t;
  } else if (opts.create) return { ok: false, error: 'title is required' };
  for (const k of ['description', 'testing', 'progress'] as const) {
    if (!(k in b)) continue;
    if (typeof b[k] !== 'string') return { ok: false, error: `${k} must be a string` };
    const v = redactAll(b[k] as string).trim();
    if (v.length > GLOBAL_TASK_LIMITS.text) return { ok: false, error: `${k} too long (max ${GLOBAL_TASK_LIMITS.text})` };
    patch[k] = v;
  }
  if ('status' in b) {
    if (b.status !== 'in_progress' && b.status !== 'completed') return { ok: false, error: "status must be 'in_progress' or 'completed'" };
    patch.status = b.status;
  }
  if (!opts.create && Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };
  return { ok: true, patch };
}

function capBlocked(db: Database, conversationId: string): { error: string; openTaskIds: string[] } | undefined {
  const ids = openTaskIds(db, conversationId);
  if (ids.length >= GLOBAL_TASK_LIMITS.openPerConversation) {
    return { error: 'at most 3 open tasks per conversation — update one instead', openTaskIds: ids };
  }
  return undefined;
}

export function registerAgentGlobalTaskRoutes(app: Express, deps: GlobalTaskRouteDeps): void {
  const handleGet = (req: Request, res: Response) => {
    const g = guard(req, res, deps);
    if (!g) return;
    touchSpawnToken(g.token);
    res.json({ tasks: listConversationTasks(g.db, g.conv.id) });
  };

  const handlePost = (req: Request, res: Response) => {
    const g = guard(req, res, deps);
    if (!g) return;
    const parsed = parseAgentTaskBody(req.body, { create: true });
    if (!parsed.ok) { res.status(400).json({ error: parsed.error, ...helpHint('tasks') }); return; }
    const cap = capBlocked(g.db, g.conv.id);
    if (cap) { res.status(409).json({ ...cap, ...helpHint('tasks') }); return; }
    const t = nowOf(deps);
    const task = createGlobalTask(g.db, {
      projectId: g.conv.projectId,
      conversationId: g.conv.id,
      sessionId: g.entry.sessionId,
      conversationTitle: g.conv.title,
      title: parsed.patch.title!,
      description: parsed.patch.description ?? '',
      testing: parsed.patch.testing ?? '',
      progress: parsed.patch.progress ?? '',
      now: t,
    });
    touchSpawnToken(g.token);
    broadcastTask(deps, g.db, task.id, 'upsert');
    res.status(201).json({ task });
  };

  const handlePatch = (req: Request, res: Response) => {
    const g = guard(req, res, deps);
    if (!g) return;
    const taskId = req.params.taskId;
    if (typeof taskId !== 'string') { res.status(400).json({ error: 'invalid taskId', ...helpHint('tasks') }); return; }
    const parsed = parseAgentTaskBody(req.body, { create: false });
    if (!parsed.ok) { res.status(400).json({ error: parsed.error, ...helpHint('tasks') }); return; }
    const existing = getGlobalTask(g.db, taskId);
    if (!existing || existing.conversationId !== g.conv.id) {
      res.status(404).json({ error: 'task not found' }); return;
    }
    if (existing.hiddenAt != null) {
      res.status(409).json({ error: 'task was reviewed and hidden by the operator — open a new task', decision: 'task_hidden', ...helpHint('tasks') }); return;
    }
    if (existing.status === 'completed' && parsed.patch.status === 'in_progress') {
      const cap = capBlocked(g.db, g.conv.id);
      if (cap) { res.status(409).json({ ...cap, ...helpHint('tasks') }); return; }
    }
    const task = agentUpdateGlobalTask(g.db, existing.id, parsed.patch, {
      sessionId: g.entry.sessionId,
      conversationTitle: g.conv.title,
      now: nowOf(deps),
    });
    touchSpawnToken(g.token);
    broadcastTask(deps, g.db, task.id, 'upsert');
    res.json({ task });
  };

  // Direct routes (scoped to the authenticated session)
  app.get('/tasks/agent', handleGet);
  app.post('/tasks/agent', handlePost);
  app.patch('/tasks/agent/:taskId', handlePatch);

  // Scoped routes for backward compatibility
  app.get('/conversations/:id/tasks/agent', handleGet);
  app.post('/conversations/:id/tasks/agent', handlePost);
  app.patch('/conversations/:id/tasks/agent/:taskId', handlePatch);
}

const VIEWS = new Set<GlobalTaskView>(['in_progress', 'completed', 'hidden']);
const OPERATOR_PATCH_KEYS = new Set(['status', 'hidden']);

function parseOperatorPatch(body: unknown):
  | { ok: true; patch: { status?: GlobalTaskStatus; hidden?: boolean } }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'JSON object body required' };
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) return { ok: false, error: 'nothing to update' };
  for (const k of keys) if (!OPERATOR_PATCH_KEYS.has(k)) return { ok: false, error: `field '${k}' is not accepted` };
  const patch: { status?: GlobalTaskStatus; hidden?: boolean } = {};
  if ('status' in b) {
    if (b.status !== 'in_progress' && b.status !== 'completed') return { ok: false, error: "status must be 'in_progress' or 'completed'" };
    patch.status = b.status;
  }
  if ('hidden' in b) {
    if (typeof b.hidden !== 'boolean') return { ok: false, error: 'hidden must be a boolean' };
    patch.hidden = b.hidden;
  }
  return { ok: true, patch };
}

export function registerGlobalTaskRoutes(app: Express, deps: GlobalTaskRouteDeps): void {
  // The operator surface disappears with the feature: while disabled, every
  // /tasks* data route answers 403 (same decision as the agent guard) so the
  // log cannot be read, mutated, or swept over the API. Only the settings
  // routes stay reachable — they are how the operator turns it back on.
  const rejectIfDisabled = (res: Response): boolean => {
    if (getGlobalTasksSettings(deps.getDb()).enabled) return false;
    res.status(403).json({ error: 'global tasks are disabled on this server', decision: 'global_tasks_off' });
    return true;
  };

  app.get('/tasks/count', (_req, res) => {
    if (rejectIfDisabled(res)) return;
    res.json(countGlobalTasks(deps.getDb()));
  });

  app.post('/tasks/hide-completed', (_req, res) => {
    if (rejectIfDisabled(res)) return;
    const db = deps.getDb();
    const ids = hideAllCompleted(db, nowOf(deps));
    const counts = countGlobalTasks(db);
    for (const id of ids) {
      const task = getGlobalTaskDto(db, id, deps.isLive);
      deps.broadcastAll({ type: 'global_task_updated', taskId: id, op: 'upsert', task, counts });
    }
    res.json({ hidden: ids.length });
  });

  app.get('/tasks', (req, res) => {
    if (rejectIfDisabled(res)) return;
    const raw = typeof req.query.view === 'string' ? req.query.view : 'in_progress';
    if (!VIEWS.has(raw as GlobalTaskView)) { res.status(400).json({ error: 'bad view' }); return; }
    const view = raw as GlobalTaskView;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
    const db = deps.getDb();
    const { tasks, truncated } = listGlobalTaskDtos(db, { view, projectId, isLive: deps.isLive });
    res.json({
      tasks,
      counts: countGlobalTasks(db),
      now: nowOf(deps),
      truncated,
    });
  });

  app.patch('/tasks/:id', (req, res) => {
    if (rejectIfDisabled(res)) return;
    const parsed = parseOperatorPatch(req.body);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const db = deps.getDb();
    const task = operatorUpdateGlobalTask(db, req.params.id, parsed.patch, nowOf(deps));
    if (!task) { res.status(404).json({ error: 'task not found' }); return; }
    broadcastTask(deps, db, task.id, 'upsert');
    res.json({ task: getGlobalTaskDto(db, task.id, deps.isLive) });
  });

  app.delete('/tasks/:id', (req, res) => {
    if (rejectIfDisabled(res)) return;
    const db = deps.getDb();
    if (!getGlobalTask(db, req.params.id)) { res.status(404).json({ error: 'task not found' }); return; }
    deleteGlobalTask(db, req.params.id);
    broadcastTask(deps, db, req.params.id, 'delete');
    res.json({ ok: true });
  });

  app.delete('/tasks', (req, res) => {
    if (rejectIfDisabled(res)) return;
    if (req.query.view !== 'hidden') { res.status(400).json({ error: "view must be 'hidden'" }); return; }
    const db = deps.getDb();
    const ids = deleteAllHidden(db);
    const counts = countGlobalTasks(db);
    for (const id of ids) {
      deps.broadcastAll({ type: 'global_task_updated', taskId: id, op: 'delete', counts });
    }
    res.json({ deleted: ids.length });
  });

  app.get('/settings/global-tasks', (_req, res) => {
    res.json(getGlobalTasksSettings(deps.getDb()));
  });

  app.post('/settings/global-tasks', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'JSON object body required' }); return;
    }
    res.json(updateGlobalTasksSettings(deps.getDb(), req.body));
  });
}
