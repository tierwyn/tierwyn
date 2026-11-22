import { randomUUID } from 'crypto';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import {
  TIMER_MAX_PROMPT_CHARS, resolveTimerFireAt, clampEffort, sanitisePromptOptions,
  PromptOptionError,
  type ConversationTimerResponse, type ConversationTimersResponse,
  type CreateConversationTimerRequest, type UpdateConversationTimerRequest,
  type EffortLevel, type TimerHandoffOverride,
  type PromptOptions,
  type AgentSelfTimersMode, type CreateAgentSelfTimerResponse,
  type PendingTimersResponse,
  PENDING_TIMERS_LIST_CAP,
  agentDeferCapError, selfTimerAllowed,
} from '@tierwyn/shared';
import { catalogue } from '../catalogue.js';
import { helpHint } from '../spawn/agentHelp.js';
import { getConversation, isPolicyRoot } from '../repositories/conversations.js';
import {
  createTimer, getTimer, listPendingTimers, cancelTimer, updateTimer,
  getPendingNonOperatorTimer, listAllPendingTimerSummaries,
  type TimerPatch,
} from '../repositories/conversationTimers.js';
import { validateDraftAttachments } from './conversations.js';
import { peekSpawnToken, touchSpawnToken } from '../spawn/tokens.js';
import { redactAll } from '../secrets/redactAll.js';
import { AGENT_SELF_TIMERS } from '../spawn/config.js';
import { getSession, lastSessionForConversation } from '../repositories/sessions.js';
import { getCompactionSettings } from '../repositories/settings.js';

interface Deps {
  getDb: () => Database;
  /** Injected in tests for deterministic bounds checks. */
  now?: () => number;
}


/**
 * Per-conversation prompt timers. Cookie-auth only — these routes are mounted
 * AFTER requireAuth in index.ts, so there is no bearer/agent path here on
 * purpose: a timer is an operator affordance, not an agent capability.
 */
const VALID_HANDOFF_OVERRIDES = new Set(['summary', 'transcript', 'fresh']);
const HANDOFF_OVERRIDE_ERROR = 'handoffOverride must be "summary", "transcript", "fresh" or null';

export function registerConversationTimerRoutes(app: Express, deps: Deps): void {
  const now = (): number => (deps.now ? deps.now() : Date.now());

  app.get('/timers/pending', (_req, res) => {
    const { timers, truncated } = listAllPendingTimerSummaries(deps.getDb(), PENDING_TIMERS_LIST_CAP);
    const body: PendingTimersResponse = { now: now(), truncated, timers };
    res.json(body);
  });

  app.get('/conversations/:id/timers', (req, res) => {

    const db = deps.getDb();
    if (!getConversation(db, req.params.id)) {
      res.status(404).json({ error: 'conversation not found' }); return;
    }
    const body: ConversationTimersResponse = { timers: listPendingTimers(db, req.params.id) };
    res.json(body);
  });

  app.post('/conversations/:id/timers', (req, res) => {
    const db = deps.getDb();
    const conversation = getConversation(db, req.params.id);
    if (!conversation) { res.status(404).json({ error: 'conversation not found' }); return; }

    const input = (req.body ?? {}) as CreateConversationTimerRequest;

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }
    if (prompt.length > TIMER_MAX_PROMPT_CHARS) {
      res.status(400).json({ error: `prompt too long (max ${TIMER_MAX_PROMPT_CHARS})` }); return;
    }

    // Profile is snapshotted at create time from the composer selection. It is
    // re-resolved at fire time — this check only rejects obvious garbage now.
    const profileId = typeof input.profileId === 'string' ? input.profileId : '';
    const profile = profileId ? catalogue.getProfile(profileId) : undefined;
    if (!profile || !profile.enabled) {
      res.status(400).json({ error: `unknown or disabled profile: ${profileId || '(missing)'}` }); return;
    }

    const when = resolveTimerFireAt({
      fireInMs: input.fireInMs, fireAtMs: input.fireAtMs, now: now(),
    });
    if (!when.ok) { res.status(400).json({ error: when.error }); return; }

    // Every snapshot field is validated against the TIMER's profile, not the
    // composer's — the operator may have picked a different agent in the modal.
    const effort = clampEffort(profile.agentType, input.effort as EffortLevel | undefined) ?? null;

    let options: PromptOptions | null = null;
    try {
      options = sanitisePromptOptions(profile.agentType, input.options) ?? null;
    } catch (e) {
      const message = e instanceof PromptOptionError ? e.message : 'invalid prompt options';
      res.status(400).json({ error: message }); return;
    }

    const atts = validateDraftAttachments(input.attachments);
    if (!atts.ok) { res.status(400).json({ error: atts.reason }); return; }

    const rawOverride = input.handoffOverride ?? null;
    if (rawOverride !== null && !VALID_HANDOFF_OVERRIDES.has(rawOverride as string)) {
      res.status(400).json({ error: HANDOFF_OVERRIDE_ERROR });
      return;
    }
    const handoffOverride = rawOverride as TimerHandoffOverride | null;

    const timer = createTimer(db, {
      id: randomUUID(),
      conversationId: conversation.id,
      prompt,
      profileId,
      fireAtMs: when.fireAtMs,
      createdAt: now(),
      effort,
      options,
      attachments: atts.attachments,
      handoffOverride,
    });
    const body: ConversationTimerResponse = { timer };
    res.status(201).json(body);
  });

  app.delete('/conversations/:id/timers/:timerId', (req, res) => {
    const db = deps.getDb();
    const timer = getTimer(db, req.params.timerId);
    // Cross-conversation access is a 404, not a 403 — the id is not this
    // conversation's to know about.
    if (!timer || timer.conversationId !== req.params.id) {
      res.status(404).json({ error: 'timer not found' }); return;
    }
    if (timer.firedAt !== null || timer.cancelledAt !== null) {
      res.status(409).json({ error: 'timer already fired or cancelled' }); return;
    }
    // cancelTimer is a CAS (WHERE cancelled_at IS NULL AND fired_at IS NULL).
    // claimDueTimers can stamp fired_at between getTimer and this UPDATE.
    if (!cancelTimer(db, timer.id, now())) {
      res.status(409).json({ error: 'timer already fired or cancelled' }); return;
    }
    res.status(204).end();
  });

  app.patch('/conversations/:id/timers/:timerId', (req, res) => {
    const db = deps.getDb();
    const timer = getTimer(db, req.params.timerId);
    if (!timer || timer.conversationId !== req.params.id) {
      res.status(404).json({ error: 'timer not found' }); return;
    }
    if (timer.firedAt !== null || timer.cancelledAt !== null) {
      res.status(409).json({ error: 'timer already fired or cancelled' }); return;
    }

    const input = (req.body ?? {}) as UpdateConversationTimerRequest;
    const patch: TimerPatch = {};

    if ('prompt' in input && input.prompt !== undefined) {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }
      if (prompt.length > TIMER_MAX_PROMPT_CHARS) {
        res.status(400).json({ error: `prompt too long (max ${TIMER_MAX_PROMPT_CHARS})` }); return;
      }
      patch.prompt = prompt;
    }

    const storedProfile = catalogue.getProfile(timer.profileId);
    let effectiveProfile = storedProfile;
    let profileChanged = false;
    if ('profileId' in input && input.profileId !== undefined) {
      const profileId = typeof input.profileId === 'string' ? input.profileId : '';
      const profile = profileId ? catalogue.getProfile(profileId) : undefined;
      if (!profile || !profile.enabled) {
        res.status(400).json({ error: `unknown or disabled profile: ${profileId || '(missing)'}` });
        return;
      }
      effectiveProfile = profile;
      patch.profileId = profileId;
      profileChanged = profileId !== timer.profileId;
    }

    const hasIn = input.fireInMs !== undefined;
    const hasAt = input.fireAtMs !== undefined;
    if (hasIn || hasAt) {
      const when = resolveTimerFireAt({
        fireInMs: input.fireInMs, fireAtMs: input.fireAtMs, now: now(),
      });
      if (!when.ok) { res.status(400).json({ error: when.error }); return; }
      patch.fireAtMs = when.fireAtMs;
    }

    const agentType = effectiveProfile?.agentType ?? '';
    if ('effort' in input) {
      patch.effort = clampEffort(agentType, input.effort as EffortLevel | undefined) ?? null;
    } else if (profileChanged) {
      patch.effort = clampEffort(agentType, timer.effort as EffortLevel | undefined) ?? null;
    }

    if ('options' in input) {
      try {
        patch.options = sanitisePromptOptions(agentType, input.options) ?? null;
      } catch (e) {
        const message = e instanceof PromptOptionError ? e.message : 'invalid prompt options';
        res.status(400).json({ error: message }); return;
      }
    } else if (profileChanged && agentType !== storedProfile?.agentType) {
      patch.options = null;
    }

    if ('attachments' in input && input.attachments !== undefined) {
      const atts = validateDraftAttachments(input.attachments);
      if (!atts.ok) { res.status(400).json({ error: atts.reason }); return; }
      patch.attachments = atts.attachments;
    }

    if ('handoffOverride' in input) {
      const rawOverride = input.handoffOverride ?? null;
      if (rawOverride !== null && !VALID_HANDOFF_OVERRIDES.has(rawOverride as string)) {
        res.status(400).json({ error: HANDOFF_OVERRIDE_ERROR });
        return;
      }
      patch.handoffOverride = rawOverride as TimerHandoffOverride | null;
    }

    const updated = updateTimer(db, timer.id, patch);
    if (!updated) {
      res.status(409).json({ error: 'timer already fired or cancelled' }); return;
    }
    const body: ConversationTimerResponse = { timer: updated };
    res.json(body);
  });
}

const FORBIDDEN_SELF_TIMER_FIELDS = ['profileId', 'role', 'prompt', 'effort', 'options', 'attachments', 'notifyParent', 'origin'] as const;

/** Agent self-timers. Bearer-only, mounted BEFORE requireAuth (index.ts).
 *  The caller may only wake ITSELF: token conversation must equal :id. */
export function registerAgentSelfTimerRoutes(
  app: Express,
  deps: { getDb: () => Database; now?: () => number; selfTimersMode?: () => AgentSelfTimersMode },
): void {
  const now = (): number => (deps.now ? deps.now() : Date.now());
  const mode = deps.selfTimersMode ?? (() => AGENT_SELF_TIMERS);

  app.post('/conversations/:id/timers/agent', (req, res) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const entry = peekSpawnToken(token);
    if (!entry) { res.status(401).json({ error: 'a live session bearer token is required' }); return; }
    if (!entry.scope.has('schedule')) { res.status(403).json({ error: 'this token cannot set timers', ...helpHint('timer') }); return; }
    if (entry.conversationId !== req.params.id) {
      res.status(403).json({ error: 'a conversation may only set timers on itself', decision: 'cross_conversation', ...helpHint('timer') }); return;
    }
    const m = mode();
    if (m === 'off') {
      res.status(403).json({ error: 'agent self-timers are disabled on this server (TIERWYN_AGENT_SELF_TIMERS=off)', decision: 'self_timers_off', ...helpHint('timer') }); return;
    }
    const db = deps.getDb();
    const conversation = getConversation(db, req.params.id);
    if (!conversation) { res.status(404).json({ error: 'conversation not found' }); return; }
    if (!selfTimerAllowed(m, isPolicyRoot(db, conversation))) {
      res.status(403).json({
        error: 'only top-level conversations may set self-timers (TIERWYN_AGENT_SELF_TIMERS=level0) — ask your parent to defer you via /spawn/<you>/message with fireInMs',
        decision: 'self_timers_root_only',
        ...helpHint('timer'),
      }); return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const bad = FORBIDDEN_SELF_TIMER_FIELDS.find((k) => k in body);
    if (bad) {
      res.status(400).json({ error: `field '${bad}' is not accepted — self-timers fire on this conversation's current profile with plain text`, ...helpHint('timer') }); return;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { res.status(400).json({ error: 'text is required', ...helpHint('timer') }); return; }

    const t = now();
    const when = resolveTimerFireAt({ fireInMs: body.fireInMs as number | undefined, fireAtMs: body.fireAtMs as number | undefined, now: t });
    if (!when.ok) { res.status(400).json({ error: when.error, ...helpHint('timer') }); return; }
    const capErr = agentDeferCapError(when.fireAtMs - t, getCompactionSettings(db).usageAutoResumeMaxDeferMs);
    if (capErr) { res.status(400).json({ ...capErr, ...helpHint('timer') }); return; }

    const prompt = `⏰ Self-timer you set at ${new Date(t).toISOString()}:\n\n${redactAll(text)}`;
    if (prompt.length > TIMER_MAX_PROMPT_CHARS) {
      res.status(400).json({ error: `prompt too long (max ${TIMER_MAX_PROMPT_CHARS})`, ...helpHint('timer') }); return;
    }

    const profileId = getSession(db, entry.sessionId)?.agentModelId
      ?? lastSessionForConversation(db, conversation.id)?.agentModelId;
    const profile = profileId ? catalogue.getProfile(profileId) : undefined;
    if (!profileId || !profile || !profile.enabled) {
      res.status(400).json({ error: 'no current profile to schedule onto', ...helpHint('timer') }); return;
    }

    const conflict = (): void => {
      const p = getPendingNonOperatorTimer(db, conversation.id);
      res.status(409).json({
        error: 'a timer is already pending for this conversation',
        ...(p ? { timerId: p.id, fireAtMs: p.fireAtMs, origin: p.origin } : {}),
        ...helpHint('timer'),
      });
    };
    if (getPendingNonOperatorTimer(db, conversation.id)) { conflict(); return; }
    let timer;
    try {
      timer = createTimer(db, {
        conversationId: conversation.id, prompt, profileId, fireAtMs: when.fireAtMs,
        createdAt: t, origin: 'agent-self', attempt: 1,
      });
    } catch (e) {
      // Unique pending-agent-timer index (migration 132) backstops the check-then-insert race.
      if (e instanceof Error && /UNIQUE constraint/.test(e.message)) { conflict(); return; }
      throw e;
    }
    touchSpawnToken(token);
    const out: CreateAgentSelfTimerResponse = { ok: true, timer };
    res.status(201).json(out);
  });
}

