export type GlobalTaskStatus = 'in_progress' | 'completed';
export type GlobalTaskView = 'in_progress' | 'completed' | 'hidden';

export interface GlobalTask {
  id: string;
  projectId: string;
  conversationId?: string;      // absent once the conversation is deleted
  sessionId?: string;
  conversationTitle: string;    // snapshot
  title: string;
  description: string;
  testing: string;
  progress: string;
  status: GlobalTaskStatus;
  completedBy?: 'agent' | 'operator';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  hiddenAt?: number;
}

export interface GlobalTaskDto extends GlobalTask {
  projectName: string;               // '' if somehow missing
  conversationArchived?: boolean;    // true only when the conversation exists and is archived
  parentConversationId?: string;
  parentConversationTitle?: string;
  fromSchedule?: boolean;            // true when the conversation's parent is a schedule_home
  live: boolean;                     // conversation has an in-flight session right now
}

export interface GlobalTaskCounts { inProgress: number; completedVisible: number; hidden: number }

export interface GlobalTasksResponse { tasks: GlobalTaskDto[]; counts: GlobalTaskCounts; now: number; truncated: boolean }

export interface GlobalTasksSettings {
  enabled: boolean;                  // default true
  scope: 'roots' | 'all';            // default 'roots'
  staleAfterHours: number;           // default 48; 0 = never stale; int 0..8760
  autoDeleteHiddenAfterDays: number; // default 30; 0 = never; int 0..3650
}

export const GLOBAL_TASKS_DEFAULTS: GlobalTasksSettings = { enabled: true, scope: 'roots', staleAfterHours: 48, autoDeleteHiddenAfterDays: 30 };
export const GLOBAL_TASK_LIMITS = { title: 200, text: 4000, openPerConversation: 3, listMax: 500 } as const;

export function isTaskStale(t: Pick<GlobalTask, 'status' | 'updatedAt'>, now: number, staleAfterHours: number): boolean {
  return t.status === 'in_progress' && staleAfterHours > 0 && now - t.updatedAt > staleAfterHours * 3_600_000;
}

function intIn(v: unknown, max: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : dflt;
}

export function sanitiseGlobalTasksSettings(raw: unknown): GlobalTasksSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = GLOBAL_TASKS_DEFAULTS;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    scope: r.scope === 'all' || r.scope === 'roots' ? r.scope : d.scope,
    staleAfterHours: intIn(r.staleAfterHours, 8760, d.staleAfterHours),
    autoDeleteHiddenAfterDays: intIn(r.autoDeleteHiddenAfterDays, 3650, d.autoDeleteHiddenAfterDays),
  };
}

export function globalTasksAllowed(s: Pick<GlobalTasksSettings, 'enabled' | 'scope'>, isRoot: boolean): boolean {
  return s.enabled && (s.scope === 'all' || isRoot);
}
