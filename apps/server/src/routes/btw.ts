import { randomUUID } from 'crypto';
import type { Express, Request } from 'express';
import type { Database } from 'better-sqlite3';
import {
  DEFAULT_SIDECAR_MAX_INPUT_CHARS,
  DEFAULT_SIDECAR_TIMEOUTS,
  isSidecarAgentBackend,
  type BtwAvailability,
  type BtwQuery,
  type BtwUpdatedFrame,
  type Conversation,
  type SidecarSiteRoute,
} from '@tierwyn/shared';
import { sessionHub } from '../sessionHub.js';
import type { SessionManager } from '../sessionManager.js';
import { catalogue } from '../catalogue.js';
import { registry } from '../registry.js';
import { duplicateConversation, getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import {
  getBtwSettings, getBtwPrimingProfileId, getSidecarLlmSettings, getCompactionSettings,
} from '../repositories/settings.js';
import {
  insertBtw, completeBtw, failBtw, listBtwForConversation, getBtw, setBtwFork,
} from '../repositories/btw.js';
import { buildResumePlan } from '../compaction/compactor.js';
import { makeAdapterRunner } from '../compaction/runner.js';
import { estimateTokens } from '../compaction/tokenizer.js';
import { sidecarComplete, sidecarSiteReady } from '../sidecar.js';

interface Deps {
  getDb: () => Database;
  sessionManager: SessionManager;
  /** True when the request carries a valid operator session cookie. */
  isAuthed: (req: Request) => boolean;
}

export function btwAvailability(db: Database): BtwAvailability {
  if (getSidecarLlmSettings(db).btw.enabled === false) {
    return { ready: false, reason: 'BTW is disabled in Settings' };
  }
  if (!sidecarSiteReady(db, 'btw')) {
    return { ready: false, reason: 'BTW has no model configured' };
  }
  return { ready: true };
}

interface BtwJob {
  getDb: () => Database;
  parentId: string;
  btwId: string;
  question: string;
  projectRoot: string;
  inflightId: string | undefined;
  primingMode: string;
  primingMaxBytes: number;
  remoteHostId?: string | null;
}

/** Label + newlines around the question, plus a little wrapping slack. */
const BTW_PROMPT_OVERHEAD_BYTES = 2048;
/** Floor so an observer intro + rules still fit when the question is large. */
const BTW_MIN_PRIMING_BYTES = 2048;

function btwQuestionFitsBudget(question: string, budget: number): boolean {
  return Buffer.byteLength(question) + BTW_PROMPT_OVERHEAD_BYTES + BTW_MIN_PRIMING_BYTES <= budget;
}

function btwPrimingMaxBytes(question: string, budget: number): number {
  return Math.max(BTW_MIN_PRIMING_BYTES, budget - Buffer.byteLength(question) - BTW_PROMPT_OVERHEAD_BYTES);
}

function effectiveBtwBudget(route: Pick<SidecarSiteRoute, 'backend' | 'maxInputChars'>): number {
  const configured = route.maxInputChars ?? DEFAULT_SIDECAR_MAX_INPUT_CHARS.btw;
  // ponytail: Linux MAX_ARG_STRLEN is 128 KiB per argv string; argv oneShots
  // (claude -p) pass the whole prompt as one arg. Clamp agent backends to
  // 120k. Upgrade path: stdin-fed oneShot.
  return isSidecarAgentBackend(route.backend) ? Math.min(configured, 120_000) : configured;
}

async function runBtwJob(job: BtwJob): Promise<void> {
  const { getDb, parentId, btwId, question, projectRoot, inflightId, primingMode, primingMaxBytes, remoteHostId } = job;
  const db = getDb();
  const route = getSidecarLlmSettings(db).btw;
  const budget = effectiveBtwBudget(route);

  const emit = (status: BtwUpdatedFrame['status']): void => {
    const frame: BtwUpdatedFrame = { type: 'btw_updated', conversationId: parentId, btwId, status };
    sessionHub.broadcast(parentId, frame);
  };

  let primingPrompt = '';
  try {
    const runner = makeAdapterRunner({
      createAdapter: (t, opts) => registry.create(t, opts),
      resolveModel: (pid) => catalogue.getProfile(pid)?.model ?? '',
      cwd: remoteHostId ? undefined : projectRoot,
      toolFreeOnly: true,
    });
    const primingProfileOverride = getBtwPrimingProfileId(db);
    const focusQuestion = primingMode === 'question-aware' ? question : undefined;
    // Divide by the safety factor so transcript-mode's
    // `tokens <= window * factor` comparison uses the full budget/4 tokens,
    // not half of it. compactToolIo stays off on this path (transcript default).
    const safety = getCompactionSettings(db).transcriptContextSafetyFactor || 1;
    const plan = await buildResumePlan(db, parentId, {
      runner,
      estimate: (t) => estimateTokens(t),
      isNativeAvailable: async () => false,
      agentId: 'btw',
      inflightId,
      skipPersist: true,
      focusQuestion,
      profileOverride: primingProfileOverride,
      override: 'transcript',
      getTargetContextWindow: async () => Math.floor(budget / 4 / safety),
      priming: { framing: 'observer', maxBytes: primingMaxBytes },
    });
    primingPrompt = plan.mode === 'native' ? '' : (plan.primingPrompt ?? '');
  } catch {
    primingPrompt = '';
  }

  const prompt = [primingPrompt, `Operator's side question:\n${question}`].filter(Boolean).join('\n\n');
  try {
    const answer = await sidecarComplete(db, 'btw', prompt, {
      cwd: projectRoot,
      timeoutSecs: DEFAULT_SIDECAR_TIMEOUTS.btw,
      remoteHostId: remoteHostId ?? null,
    });
    completeBtw(db, btwId, { answer, model: route.model });
    emit('done');
  } catch (err: unknown) {
    failBtw(db, btwId, err instanceof Error ? err.message : String(err));
    emit('error');
  }
}

/** Lives here (not repositories/btw.ts) so conversations.ts → btw.ts stays acyclic. */
function forkBtwToConversation(db: Database, btw: BtwQuery): Conversation {
  const firstLine = btw.question.trim().split('\n')[0]!.slice(0, 60);
  return db.transaction(() => {
    const conv = duplicateConversation(db, btw.parentConvId, {
      title: `BTW: ${firstLine}`,
      untilTs: btw.createdAt,
      includeTools: true,
    });
    const existing = db.prepare(
      'SELECT id FROM sessions WHERE conversation_id = ? LIMIT 1',
    ).get(conv.id) as { id: string } | undefined;
    const stubId = existing?.id ?? createSession(db, { id: randomUUID(), conversationId: conv.id }).id;
    const last = db.prepare(
      'SELECT MAX(seq) AS n FROM events WHERE session_id = ?',
    ).get(stubId) as { n: number | null };
    const n = (last.n ?? -1) + 1;
    appendEvent(db, {
      sessionId: stubId,
      type: 'prompt',
      sender: 'user',
      seq: n,
      ts: btw.createdAt,
      payload: { text: btw.question },
    });
    appendEvent(db, {
      sessionId: stubId,
      type: 'message',
      sender: 'agent',
      seq: n + 1,
      ts: btw.completedAt ?? Date.now(),
      payload: { chunk: btw.answer, final: true },
    });
    setBtwFork(db, btw.id, conv.id);
    return getConversation(db, conv.id)!;
  })();
}

export function registerBtwRoutes(app: Express, deps: Deps): void {
  app.post('/conversations/:id/btw', async (req, res) => {
    const { getDb, sessionManager } = deps;
    const db = getDb();
    const parentId = req.params.id;

    if (!deps.isAuthed(req)) {
      res.status(401).json({ error: 'btw requires an operator session' }); return;
    }

    const { question } = req.body as { question?: string };
    if (!question?.trim()) {
      res.status(400).json({ error: 'question is required' }); return;
    }
    const budget = effectiveBtwBudget(getSidecarLlmSettings(db).btw);
    if (!btwQuestionFitsBudget(question, budget)) {
      res.status(400).json({
        error: `question is too long for the BTW input budget (max ~${budget} characters; raise it in Settings → Sidecar LLMs → BTW side question)`,
      }); return;
    }
    const parent = getConversation(db, parentId);
    if (!parent) { res.status(404).json({ error: 'conversation not found' }); return; }
    const project = getProject(db, parent.projectId);
    if (!project) { res.status(400).json({ error: 'project not found' }); return; }

    const availability = btwAvailability(db);
    if (!availability.ready) {
      const reason = availability.reason ?? 'BTW unavailable';
      res.status(503).json({ error: reason, reason }); return;
    }

    const route = getSidecarLlmSettings(db).btw;
    const activeSession = sessionManager.activeSessionForConversation(parentId);
    const inflightId = activeSession?.id;
    const settings = getBtwSettings(db);

    const btwId = randomUUID();
    insertBtw(db, {
      id: btwId,
      parentConvId: parentId,
      question,
      agentId: route.backend === 'direct' ? 'direct' : route.adapter!,
      model: route.model,
    });

    res.json({ id: btwId });

    void runBtwJob({
      getDb,
      parentId, btwId, question,
      projectRoot: project.rootPath,
      inflightId, primingMode: settings.primingMode,
      primingMaxBytes: btwPrimingMaxBytes(question, budget),
      remoteHostId: project.remoteHostId ?? null,
    }).catch((err: unknown) => {
      console.warn('[btw] background job failed:', err);
      try { failBtw(getDb(), btwId, err instanceof Error ? err.message : String(err)); } catch { /* */ }
      sessionHub.broadcast(parentId, {
        type: 'btw_updated', conversationId: parentId, btwId, status: 'error',
      });
    });
  });

  app.post('/conversations/:id/btw/:btwId/fork', (req, res) => {
    if (!deps.isAuthed(req)) {
      res.status(401).json({ error: 'btw requires an operator session' }); return;
    }
    const db = deps.getDb();
    const parentId = req.params.id;
    const btw = getBtw(db, req.params.btwId);
    if (!btw || btw.parentConvId !== parentId) {
      res.status(404).json({ error: 'btw query not found' }); return;
    }
    if (btw.status !== 'done' || !btw.answer) {
      res.status(409).json({ error: 'btw query is not done' }); return;
    }
    if (!getConversation(db, parentId)) {
      res.status(404).json({ error: 'conversation not found' }); return;
    }
    if (btw.forkedConvId) {
      const existing = getConversation(db, btw.forkedConvId);
      if (existing) {
        res.json({ conversation: existing }); return;
      }
    }
    const conversation = forkBtwToConversation(db, btw);
    res.json({ conversation });
  });

  app.get('/conversations/:id/btw', (req, res) => {
    if (!deps.isAuthed(req)) {
      res.status(401).json({ error: 'btw requires an operator session' }); return;
    }
    const db = deps.getDb();
    res.json({ queries: listBtwForConversation(db, req.params.id) });
  });
}
