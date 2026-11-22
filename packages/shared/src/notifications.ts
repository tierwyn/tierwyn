import type { AgentStatus } from './events.js';
import type { RunStatus } from './domain.js';

export type NotificationCategory =
  | 'conversationComplete' | 'scheduleFired' | 'scheduleRunEnded' | 'scheduleDisabled'
  | 'agentMessage' | 'grokBotApp';

export interface NotificationInput {
  category: NotificationCategory;
  /** Deep-link target. Omitted for scheduleDisabled (no conversation). */
  conversationId?: string;
  /** Conversation title for conversationComplete. */
  conversationTitle?: string;
  /**
   * One-line conversation description. Body-only, all categories.
   * Operator-approved: preferred over projectName in the detail slot.
   */
  description?: string;
  /** Body-only fallback detail when there is no description. All categories. */
  projectName?: string;
  jobId?: string;
  jobName?: string;
  runId?: string;
  runStatus?: RunStatus;
  /** done | error, for conversationComplete. */
  agentStatus?: AgentStatus;
}

export interface BuiltNotification {
  title: string;
  body: string;
  tag: string;
  /** Relative URL for the SW openWindow path. '/' when there is no conversation. */
  url: string;
  conversationId?: string;
}

const TITLE_MAX = 80;
const BODY_MAX = 120;

const RUN_ENDED_BODY: Partial<Record<RunStatus, string>> = {
  succeeded: 'Run succeeded',
  failed: 'Run failed',
  timed_out: 'Run timed out',
  skipped: 'Run skipped',
};

function singleLineClamp(raw: string, max: number): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Body suffix: description wins, project name is the fallback, neither → no suffix. */
function withDetail(base: string, input: NotificationInput): string {
  const detail = input.description?.trim() || input.projectName?.trim();
  return detail ? `${base} · ${detail}` : base;
}

function jobTitle(jobName?: string): string {
  return `⏱ ${jobName?.trim() || 'Agent run'}`;
}

function deepLink(conversationId?: string): { url: string; conversationId?: string } {
  if (!conversationId) return { url: '/' };
  return { url: `/?c=${conversationId}`, conversationId };
}

function built(title: string, body: string, tag: string, conversationId?: string): BuiltNotification {
  return {
    title: singleLineClamp(title, TITLE_MAX),
    body: singleLineClamp(body, BODY_MAX),
    tag,
    ...deepLink(conversationId),
  };
}

/** Pure. Returns null when the input cannot produce a safe, meaningful notification. */
export function buildNotification(input: NotificationInput): BuiltNotification | null {
  switch (input.category) {
    case 'conversationComplete': {
      if (input.agentStatus !== 'done' && input.agentStatus !== 'error') return null;
      if (!input.conversationId) return null;
      const title = input.conversationTitle?.trim() || 'Conversation';
      const verb = input.agentStatus === 'error' ? 'Failed' : 'Completed';
      return built(title, withDetail(verb, input), `tierwyn:conv:${input.conversationId}`, input.conversationId);
    }
    case 'scheduleFired': {
      if (!input.runId) return null;
      return built(jobTitle(input.jobName), withDetail('Run started', input), `tierwyn:run:${input.runId}:fired`, input.conversationId);
    }
    case 'scheduleRunEnded': {
      if (!input.runId) return null;
      const phrase = input.runStatus ? RUN_ENDED_BODY[input.runStatus] : undefined;
      if (!phrase) return null;
      return built(jobTitle(input.jobName), withDetail(phrase, input), `tierwyn:run:${input.runId}:ended`, input.conversationId);
    }
    case 'scheduleDisabled': {
      if (!input.jobId) return null;
      return built(jobTitle(input.jobName), withDetail('Schedule auto-disabled', input), `tierwyn:job:${input.jobId}:disabled`);
    }
    case 'agentMessage': {
      if (!input.conversationId) return null;
      const title = input.conversationTitle?.trim() || 'Agent';
      return built(title, withDetail('New message', input), `tierwyn:conv:${input.conversationId}:msg`, input.conversationId);
    }
    case 'grokBotApp': {
      const body = input.description?.trim() || 'Grok Bot status';
      return built('Grok Bot', body, 'tierwyn:grokbot:app');
    }
    default:
      return null;
  }
}
