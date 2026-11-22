import type { HelperStatus, NormalisedEvent } from '@tierwyn/shared';

export interface HelperRun {
  key: string;
  toolUseId?: string;
  parentKey?: string;
  depth: number;
  label: string;
  description: string;
  status: HelperStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  toolUses: number;
  lastToolName?: string;
  summary?: string;
  /** Full prompt the helper was launched with (from the Agent/Task tool_call). */
  prompt?: string;
  source: 'adapter' | 'transcript';
}

const TERMINAL_HELPER: ReadonlySet<HelperStatus> = new Set(['completed', 'failed', 'stopped']);

export interface TodoItem {
  id?: string | number;
  content?: string;
  status?: string;
  activeForm?: string;
  description?: string;
  title?: string;
}

const TODO_KEYS = ['todos', 'tasks', 'todolist'];

// A subagent launch is any tool call carrying `subagent_type`, regardless of the
// tool's name. Claude Code names it `Task`; other CLIs may use a different name.
function isSubagentCall(name: string, input: Record<string, unknown> | undefined): boolean {
  return name === 'Task' || name === 'Agent' || typeof input?.subagent_type === 'string';
}

function truncateDesc(raw: string): string {
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

function callDescription(input: Record<string, unknown> | undefined): string {
  const raw =
    (typeof input?.description === 'string' && input.description) ||
    (typeof input?.prompt === 'string' && input.prompt) ||
    '';
  return truncateDesc(raw);
}

function callPrompt(input: Record<string, unknown> | undefined): string | undefined {
  return typeof input?.prompt === 'string' && input.prompt.trim() ? input.prompt : undefined;
}

function isTodosArray(v: unknown): v is TodoItem[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object');
}

/** Normalize agent-specific status enums (e.g. TODO_STATUS_COMPLETED → completed). */
export function normalizeTodoStatus(status?: string | null): string {
  if (!status) return 'pending';
  let s = String(status).trim().toLowerCase();
  if (s.startsWith('todo_status_')) s = s.slice('todo_status_'.length);
  if (s === 'complete') return 'completed';
  return s;
}

export function isTodoDone(status?: string | null): boolean {
  const s = normalizeTodoStatus(status);
  return s === 'completed' || s === 'done' || s === 'success';
}

/** Best human label for a todo item — Grok merge patches often omit content. */
export function todoLabel(todo: TodoItem): string {
  if (typeof todo.content === 'string' && todo.content.trim()) return todo.content.trim();
  if (typeof todo.description === 'string' && todo.description.trim()) return todo.description.trim();
  if (typeof todo.title === 'string' && todo.title.trim()) return todo.title.trim();
  if (typeof todo.activeForm === 'string' && todo.activeForm.trim()) return todo.activeForm.trim();
  if (todo.id != null && String(todo.id).length > 0) return `Task ${todo.id}`;
  return 'Task';
}

function todosFromInput(input: Record<string, unknown>): TodoItem[] | null {
  for (const k of TODO_KEYS) {
    const v = input[k];
    if (isTodosArray(v)) return v as TodoItem[];
  }
  return null;
}

/** Drop null/undefined/empty-string keys so status-only patches don't wipe content. */
function compactTodo(t: TodoItem): TodoItem {
  const out: TodoItem = {};
  for (const [k, v] of Object.entries(t) as [keyof TodoItem, TodoItem[keyof TodoItem]][]) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)[k] = v;
  }
  return out;
}

/** Apply a merge:true patch list onto the previous full todo list by id. */
export function applyTodoMerge(prev: TodoItem[], patches: TodoItem[]): TodoItem[] {
  const result = prev.map((t) => ({ ...t }));
  const indexById = new Map<string, number>();
  result.forEach((t, i) => {
    if (t.id != null) indexById.set(String(t.id), i);
  });

  for (const raw of patches) {
    const patch = compactTodo(raw);
    if (patch.id != null && indexById.has(String(patch.id))) {
      const i = indexById.get(String(patch.id))!;
      result[i] = { ...result[i], ...patch };
    } else if (patch.id != null) {
      indexById.set(String(patch.id), result.length);
      result.push({ ...patch });
    } else {
      result.push({ ...patch });
    }
  }
  return result;
}

export function collectHelpers(events: NormalisedEvent[], opts: { live: boolean }): HelperRun[] {
  type Snap = { payload: Extract<NormalisedEvent, { type: 'helper' }>['payload']; ts: number; seq: number };
  const byTask = new Map<string, Snap>();
  const endedAt = new Map<string, number>();
  const calls: Extract<NormalisedEvent, { type: 'tool_call' }>[] = [];
  const results = new Map<string, Extract<NormalisedEvent, { type: 'tool_result' }>>();
  const childToolCount = new Map<string, number>();

  for (const e of events) {
    if (e.type === 'helper') {
      const id = e.payload.taskId;
      const prev = byTask.get(id);
      if (!prev || e.seq > prev.seq || (e.seq === prev.seq && e.ts >= prev.ts)) {
        byTask.set(id, { payload: e.payload, ts: e.ts, seq: e.seq });
      }
      if (TERMINAL_HELPER.has(e.payload.status) && !endedAt.has(id)) endedAt.set(id, e.ts);
      continue;
    }
    if (e.type === 'tool_call') {
      calls.push(e);
      const pid = e.payload.parentToolUseId;
      if (pid) childToolCount.set(pid, (childToolCount.get(pid) ?? 0) + 1);
    } else if (e.type === 'tool_result' && !e.payload.parentToolUseId) {
      results.set(e.payload.toolUseId, e);
    }
  }

  const claimed = new Set<string>();
  for (const { payload } of byTask.values()) {
    if (payload.toolUseId) claimed.add(payload.toolUseId);
  }

  const callById = new Map(calls.map((c) => [c.payload.toolUseId, c]));
  const runs: HelperRun[] = [];

  for (const [taskId, { payload }] of byTask) {
    runs.push({
      key: taskId,
      toolUseId: payload.toolUseId,
      depth: 0,
      label: payload.label,
      description: truncateDesc(payload.description),
      prompt: callPrompt(payload.toolUseId ? callById.get(payload.toolUseId)?.payload.input : undefined),
      status: payload.status,
      startedAt: payload.startedAt,
      endedAt: endedAt.get(taskId),
      durationMs: payload.usage?.durationMs,
      totalTokens: payload.usage?.totalTokens,
      toolUses: payload.usage?.toolUses ?? (payload.toolUseId ? (childToolCount.get(payload.toolUseId) ?? 0) : 0),
      lastToolName: payload.lastToolName,
      summary: payload.summary,
      source: 'adapter',
      ...(payload.parentTaskId && byTask.has(payload.parentTaskId) ? { parentKey: payload.parentTaskId } : {}),
    });
  }

  for (const e of calls) {
    const { name, input, toolUseId } = e.payload;
    if (!toolUseId || !isSubagentCall(name, input) || claimed.has(toolUseId)) continue;
    const result = results.get(toolUseId);
    // An async launch with no adapter snapshot predates helper events (or its
    // task_started was lost): its lifecycle is unknowable, so never claim
    // "running" — otherwise every historical background Agent call lights up
    // whenever the conversation is live. ponytail: shown as completed (unknown).
    const completed = !!result;
    runs.push({
      key: toolUseId,
      toolUseId,
      depth: 0,
      label: (typeof input?.subagent_type === 'string' && input.subagent_type) || 'helper',
      description: callDescription(input),
      prompt: callPrompt(input),
      status: completed ? 'completed' : 'running',
      summary: result?.payload.content || undefined,
      startedAt: e.ts,
      endedAt: completed ? result!.ts : undefined,
      toolUses: childToolCount.get(toolUseId) ?? 0,
      source: 'transcript',
    });
  }

  const byKey = new Map(runs.map((r) => [r.key, r]));
  const byToolUseId = new Map<string, HelperRun>();
  for (const r of runs) {
    if (r.toolUseId) byToolUseId.set(r.toolUseId, r);
  }

  for (const r of runs) {
    if (r.parentKey) continue;
    const call = r.toolUseId ? callById.get(r.toolUseId) : undefined;
    const pid = call?.payload.parentToolUseId;
    if (!pid) continue;
    const parent = byToolUseId.get(pid) ?? byKey.get(pid);
    if (parent && parent.key !== r.key) r.parentKey = parent.key;
  }

  for (const r of runs) {
    let depth = 0;
    let k = r.parentKey;
    const seen = new Set<string>();
    while (k && depth < 5 && !seen.has(k)) {
      seen.add(k);
      const p = byKey.get(k);
      if (!p) break;
      depth++;
      k = p.parentKey;
    }
    r.depth = depth;
    if (!opts.live && r.status === 'running') r.status = 'stopped';
  }

  const children = new Map<string, HelperRun[]>();
  const roots: HelperRun[] = [];
  const startOf = (r: HelperRun) => r.startedAt ?? 0;
  for (const r of runs) {
    if (r.parentKey && byKey.has(r.parentKey)) {
      const list = children.get(r.parentKey) ?? [];
      list.push(r);
      children.set(r.parentKey, list);
    } else {
      roots.push(r);
    }
  }
  const byStart = (a: HelperRun, b: HelperRun) => startOf(a) - startOf(b) || a.key.localeCompare(b.key);
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);

  const ordered: HelperRun[] = [];
  const walk = (r: HelperRun) => {
    ordered.push(r);
    for (const c of children.get(r.key) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  return ordered;
}

export function runningHelperCount(runs: HelperRun[]): number {
  return runs.reduce((n, r) => n + (r.status === 'running' ? 1 : 0), 0);
}

export function helpersSignature(runs: HelperRun[]): string {
  return runs.map((r) =>
    [r.key, r.status, r.summary ?? '', r.toolUses, r.lastToolName ?? '', r.endedAt ?? ''].join(':'),
  ).join('|');
}

export function helperThread(events: NormalisedEvent[], toolUseId: string | undefined): NormalisedEvent[] {
  if (!toolUseId) return [];
  return events.filter((e): e is Extract<NormalisedEvent, { type: 'message' | 'tool_call' | 'tool_result' }> =>
    isHelperInner(e) && e.payload.parentToolUseId === toolUseId,
  );
}

/** Inner helper stream (message / tool_call / tool_result with parentToolUseId). */
/** Main-agent view of a transcript: drops `helper` snapshots and helper inner
 *  events so copy / info / todos / turn rendering never attribute a helper's
 *  work to the main agent. */
export function mainAgentEvents<T extends NormalisedEvent>(events: readonly T[]): T[] {
  return events.filter((e) => e.type !== 'helper' && !isHelperInner(e));
}

export function isHelperInner(
  e: NormalisedEvent,
): e is Extract<NormalisedEvent, { type: 'message' | 'tool_call' | 'tool_result' }> {
  return (e.type === 'message' || e.type === 'tool_call' || e.type === 'tool_result')
    && !!e.payload.parentToolUseId;
}

/**
 * Resolve the current todo list from transcript tool_calls.
 * Grok (and Claude) often send `todo_write` with `merge: true` and only
 * `{id, status}` patches — those must be folded onto the last full list
 * so the task panel still shows content labels.
 */
export function latestTodos(events: NormalisedEvent[]): TodoItem[] | null {
  let state: TodoItem[] | null = null;

  for (const e of mainAgentEvents(events)) {
    if (e.type !== 'tool_call') continue;
    const input = e.payload.input as Record<string, unknown> | undefined;
    if (!input) continue;
    const todos = todosFromInput(input);
    if (!todos) continue;

    if (input.merge === true && state) {
      state = applyTodoMerge(state, todos);
    } else {
      state = todos.map((t) => ({ ...t }));
    }
  }

  return state;
}
