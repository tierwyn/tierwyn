import type {
  AgentStatus,
  ConversationUpdatedFrame,
  PublicNotificationSettings,
  ScheduleUpdatedFrame,
} from '@tierwyn/shared';
import { buildNotification, type NotificationCategory } from '@tierwyn/shared';

export interface DispatcherContext {
  settings: PublicNotificationSettings | null;
  deviceEnabled: boolean;
  selectedConversationId: string | null;
  /** id → { title, projectName, description } for whatever the client has loaded. */
  lookup: (conversationId: string) => { title?: string; projectName?: string; description?: string };
  /** projectId → name. Schedule frames carry a projectId but not always a conversationId. */
  lookupProjectName: (projectId: string) => string | undefined;
  onClick: (conversationId: string) => void;
}

const DEDUP_MS = 30_000;
const PRUNE_MS = 5 * 60_000;

const TERMINAL_RUN: ReadonlySet<string> = new Set(['succeeded', 'failed', 'timed_out', 'skipped']);

export class NotificationDispatcher {
  private readonly armed = new Set<string>();
  private readonly scheduleRunConversations = new Set<string>();
  private readonly recentTags = new Map<string, number>();

  constructor(private readonly ctx: () => DispatcherContext) {}

  /** Arm/disarm the "must have been running" gate. */
  observeStatus(conversationId: string, status: AgentStatus): void {
    if (status === 'running' || status === 'waiting') this.armed.add(conversationId);
  }

  handleConversationUpdated(frame: ConversationUpdatedFrame): void {
    const status = frame.status;
    if (status !== 'done' && status !== 'error') return;
    const cid = frame.conversationId;
    if (!this.passesGate('conversationComplete')) return;
    if (this.isViewing(cid)) return;
    if (!this.armed.has(cid)) return;
    this.armed.delete(cid);
    if (frame.interruptWorthy === false) return;
    if (this.scheduleRunConversations.has(cid)) return;
    const found = this.ctx().lookup(cid);
    const built = buildNotification({
      category: 'conversationComplete',
      conversationId: cid,
      conversationTitle: found.title,
      description: found.description,
      projectName: found.projectName,
      agentStatus: status,
    });
    if (!built) return;
    if (this.isDuplicate(built.tag)) return;
    this.show(built.title, built.body, built.tag, built.conversationId);
  }

  handleScheduleUpdated(frame: ScheduleUpdatedFrame): void {
    if (frame.conversationId) this.scheduleRunConversations.add(frame.conversationId);

    let category: NotificationCategory | null = null;
    if (frame.event === 'fired') category = 'scheduleFired';
    else if (frame.event === 'auto_disabled') category = 'scheduleDisabled';
    else if (frame.runStatus && TERMINAL_RUN.has(frame.runStatus)) category = 'scheduleRunEnded';
    if (!category) return;
    if (category === 'scheduleRunEnded' && frame.interruptWorthy === false) return;

    if (!this.passesGate(category)) return;
    if (frame.conversationId && this.isViewing(frame.conversationId)) return;

    const found = frame.conversationId ? this.ctx().lookup(frame.conversationId) : undefined;
    const built = buildNotification({
      category,
      conversationId: frame.conversationId,
      jobId: frame.jobId,
      jobName: frame.jobName,
      runId: frame.runId,
      runStatus: frame.runStatus,
      description: found?.description,
      projectName: found?.projectName ?? this.ctx().lookupProjectName(frame.projectId),
    });
    if (!built) return;
    if (this.isDuplicate(built.tag)) return;
    this.show(built.title, built.body, built.tag, built.conversationId);
  }

  private passesGate(category: NotificationCategory): boolean {
    const { settings, deviceEnabled } = this.ctx();
    if (!settings?.enabled || !deviceEnabled) return false;
    const categoryOn = category === 'grokBotApp' ? settings.agentMessage : settings[category];
    if (!categoryOn) return false;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    return true;
  }

  private isViewing(conversationId: string): boolean {
    return document.visibilityState === 'visible'
      && conversationId === this.ctx().selectedConversationId;
  }

  private isDuplicate(tag: string): boolean {
    const now = Date.now();
    for (const [t, ts] of this.recentTags) {
      if (now - ts > PRUNE_MS) this.recentTags.delete(t);
    }
    const prev = this.recentTags.get(tag);
    if (prev !== undefined && now - prev < DEDUP_MS) return true;
    this.recentTags.set(tag, now);
    return false;
  }

  private show(title: string, body: string, tag: string, conversationId?: string): void {
    const opts: NotificationOptions = { body, tag, data: { conversationId } };
    try {
      const n = new Notification(title, opts);
      n.onclick = () => {
        window.focus();
        if (conversationId) this.ctx().onClick(conversationId);
        n.close();
      };
    } catch {
      void navigator.serviceWorker?.ready
        .then((r) => r.showNotification(title, opts))
        .catch(() => { /* swallow */ });
    }
  }
}
