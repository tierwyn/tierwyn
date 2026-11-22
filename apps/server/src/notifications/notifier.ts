import type { Database } from 'better-sqlite3';
import webpush from 'web-push';
import { buildNotification, type NotificationInput } from '@tierwyn/shared';
import {
  getDecisionSettings, getNotificationSettings, updateNotificationSettings,
} from '../repositories/settings.js';
import { getConversation } from '../repositories/conversations.js';
import { lastAssistantText } from '../repositories/events.js';
import { redactAll } from '../secrets/redactAll.js';
import { assertOutboundUrl, OutboundUrlError } from '../net/outboundUrl.js';
import { decide, type Answer, type Question } from '../decide.js';
import {
  deletePushSubscription,
  listPushSubscriptions,
  type PushSubscriptionRow,
} from '../repositories/pushSubscriptions.js';

export const notifierDeps = {
  sendNotification: (subscription: webpush.PushSubscription, payload: string) =>
    webpush.sendNotification(subscription, payload),
  generateVAPIDKeys: () => webpush.generateVAPIDKeys(),
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  },
};

export function ensureVapidKeys(db: Database): { publicKey: string; privateKey: string; subject: string } {
  const s = getNotificationSettings(db);
  if (s.vapidPublicKey && s.vapidPrivateKey) {
    return { publicKey: s.vapidPublicKey, privateKey: s.vapidPrivateKey, subject: s.vapidSubject };
  }
  const keys = notifierDeps.generateVAPIDKeys();
  updateNotificationSettings(db, {
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
  });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: s.vapidSubject };
}

export const INTERRUPT_CONFIDENCE_FLOOR = 0.6;
/** Noul answers carry no confidence: "clearly no" = distance from the decision side. */
const NO_SIDE = 1 - INTERRUPT_CONFIDENCE_FLOOR;
const EXCERPT_MAX_CHARS = 1500;

/** Test seam, like notifierDeps. */
export const interruptDeps = { decide };

const QUESTIONS: Partial<Record<NotificationInput['category'], Record<string, Question>>> = {
  conversationComplete: {
    interrupt_worthy: {
      type: 'noul',
      instructions: 'Would a busy operator want to be interrupted by a notification that this agent conversation finished, right now?',
      criteria: {
        true: 'Result the operator should look at soon: a question, a decision needed, a failure, or a meaningful deliverable',
        false: 'Routine acknowledgement or trivial completion that can wait',
      },
    },
    needs_attention: {
      type: 'noul',
      instructions: 'Does the outcome need the operator: an unanswered question, work blocked on the operator, or failed/broken work?',
    },
    urgency: {
      type: 'score',
      instructions: 'How urgently should the operator look at this?',
      criteria: ['Calm success, can wait', 'Worth a look soon', 'Needs a tap now'],
    },
  },
  agentMessage: {
    interrupt_worthy: {
      type: 'noul',
      instructions: 'Would the operator want a phone notification for this unsolicited message from a remote agent right now?',
    },
    expects_reply: {
      type: 'noul',
      instructions: 'Does this message ask the operator something or wait for their reply or decision?',
    },
  },
  scheduleRunEnded: {
    interrupt_worthy: {
      type: 'noul',
      instructions: 'Would the operator want to be interrupted that this scheduled run ended with this outcome?',
    },
  },
};

/** true = interrupt, false = clearly not worth it, undefined = partial answer (fail-open). */
function worthyFromAnswers(category: NotificationInput['category'], a: Record<string, Answer>): boolean | undefined {
  const noul = (k: string) => (a[k]?.type === 'noul' ? a[k].noul : undefined);
  const iw = noul('interrupt_worthy');
  let verdict: boolean | undefined;
  if (iw === undefined) {
    verdict = undefined;
  } else if (category === 'conversationComplete') {
    const na = noul('needs_attention');
    const u = a.urgency;
    if (na === undefined) verdict = undefined;
    else if (na >= 0.5) verdict = true;
    else if (u?.type === 'score' && u.score >= 1 && u.confidence >= INTERRUPT_CONFIDENCE_FLOOR) verdict = true;
    else verdict = iw > NO_SIDE;
  } else if (category === 'agentMessage') {
    const er = noul('expects_reply');
    if (er === undefined) verdict = undefined;
    else verdict = er >= 0.5 ? true : iw > NO_SIDE;
  } else {
    verdict = iw > NO_SIDE;
  }
  // Content-free tuning log (open question 1 in the plan).
  console.log(`[decide] verdict category=${category} iw=${iw ?? '?'} na=${noul('needs_attention') ?? noul('expects_reply') ?? '-'} => ${verdict ?? 'open'}`);
  return verdict;
}

function scrubExcerpt(text: string): string {
  return redactAll(text)
    .replace(/```[\s\S]*?```/g, '[code]')
    // An unpaired fence (odd count, or a window that starts mid-fence) drops everything after it.
    .replace(/```[\s\S]*$/, '[code]')
    .replace(/`[^`\n]*`/g, '[code]')
    // Over-scrub path-like text: Windows drives, absolute POSIX (any depth, incl. /etc), bare a/b/c.
    .replace(/\b[A-Za-z]:[\\/][^\s"'`)]*/g, '[path]')
    .replace(/(?<![\w.@-])(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*/g, '[path]')
    .replace(/(?<![\w./~@-])[\w.@-]+(?:\/[\w.@-]+){2,}/g, '[path]');
}

/** The only content that leaves the machine for the interrupt filter. */
function buildInterruptState(db: Database, input: NotificationInput): Record<string, unknown> {
  const conv = input.conversationId ? getConversation(db, input.conversationId) : undefined;
  const origin = input.category === 'scheduleRunEnded' ? 'schedule_run'
    : input.category === 'agentMessage' ? 'remote_agent'
    : conv?.parentConversationId ? 'spawn_child'
    : 'operator_chat';
  const excerpt = input.conversationId ? lastAssistantText(db, input.conversationId) ?? '' : '';
  return {
    event: input.category === 'scheduleRunEnded' ? 'schedule_run_ended'
      : input.category === 'agentMessage' ? 'agent_message'
      : 'conversation_complete',
    status: input.agentStatus ?? input.runStatus,
    origin,
    title: conv?.title ? redactAll(conv.title).slice(0, 120) : undefined,
    description: (() => {
      const raw = input.description ?? conv?.description;
      return raw ? redactAll(raw).slice(0, 200) : undefined;
    })(),
    jobName: input.jobName,
    lastAssistantExcerpt: scrubExcerpt(excerpt).slice(-EXCERPT_MAX_CHARS),
  };
}

function eligible(input: NotificationInput): boolean {
  if (input.category === 'conversationComplete') return input.agentStatus === 'done';
  if (input.category === 'scheduleRunEnded') return input.runStatus === 'succeeded' || input.runStatus === 'skipped';
  return input.category === 'agentMessage';
}

/** Sync undefined = Jev not applicable (caller behaves exactly as today). The promise never rejects;
 *  it resolves undefined on null/partial answers (fail-open to notify). */
export function judgeInterrupt(db: Database, input: NotificationInput): Promise<boolean | undefined> | undefined {
  try {
    if (!eligible(input)) return undefined;
    const settings = getDecisionSettings(db);
    if (!settings.enabled || !settings.apiKey) return undefined;
    const notif = getNotificationSettings(db);
    const categoryOn = input.category === 'agentMessage' || input.category === 'grokBotApp' ? notif.agentMessage : notif[input.category];
    if (!notif.enabled || !categoryOn) return undefined;
    // agentMessage is push-only: with no key or subscriber nothing could be delivered, so don't send anything out.
    if (input.category === 'agentMessage' && (!notif.vapidPrivateKey || listPushSubscriptions(db).length === 0)) return undefined;
    const questions = QUESTIONS[input.category];
    if (!questions) return undefined;
    const state = buildInterruptState(db, input);
    return interruptDeps.decide(state, questions, { settings, consumer: 'notify', conversationId: input.conversationId })
      .then((r) => (r ? worthyFromAnswers(input.category, r.answers) : undefined))
      .catch(() => undefined);
  } catch (err) {
    console.warn('[notifications] judgeInterrupt failed:', err);
    return undefined;
  }
}

/** Fire-and-forget wrapper for call sites that have no client frame to stamp. */
export function decideThenNotify(db: Database, input: NotificationInput): void {
  const p = judgeInterrupt(db, input);
  if (!p) { notifyOperator(db, input); return; }
  void p.then((w) => notifyOperator(db, input, w), () => notifyOperator(db, input));
}

/** Fire-and-forget. Never throws. `interruptWorthy === false` (Jev verdict) suppresses delivery. */
export function notifyOperator(db: Database, input: NotificationInput, interruptWorthy?: boolean): void {
  try {
    if (interruptWorthy === false) return;
    const settings = getNotificationSettings(db);
    const categoryOn = input.category === 'grokBotApp' ? settings.agentMessage : settings[input.category];
    if (!settings.enabled || !categoryOn || !settings.vapidPrivateKey) return;
    const built = buildNotification(input);
    if (!built) return;
    const subs = listPushSubscriptions(db);
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      title: redactAll(built.title),
      body: redactAll(built.body),
      tag: built.tag,
      data: { conversationId: built.conversationId },
    });
    void deliver(db, settings.vapidSubject, settings.vapidPublicKey, settings.vapidPrivateKey, subs, payload)
      .catch((err) => console.warn('[notifications] deliver failed:', err));
  } catch (err) {
    console.warn('[notifications] notifyOperator failed:', err);
  }
}

async function deliver(
  db: Database,
  subject: string,
  publicKey: string,
  privateKey: string,
  subs: PushSubscriptionRow[],
  payload: string,
): Promise<void> {
  notifierDeps.setVapidDetails(subject, publicKey, privateKey);
  await Promise.all(subs.map(async (row) => {
    try {
      await assertOutboundUrl(row.endpoint, 'public-only', { httpsOnly: true });
    } catch (err) {
      if (err instanceof OutboundUrlError) {
        deletePushSubscription(db, row.endpoint);
        return;
      }
      throw err;
    }
    try {
      await notifierDeps.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
      );
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 404 || status === 410) {
        deletePushSubscription(db, row.endpoint);
        return;
      }
      console.warn('[notifications] push send failed:', err);
    }
  }));
}
