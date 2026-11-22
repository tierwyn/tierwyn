/**
 * Prompt enhancer routes — rewrite a draft prompt via an LLM.
 * Sibling to voice cleanup / TTS summarize; routed via sidecarComplete().
 *
 * POST /enhance is asynchronous: 202 + detached sidecarComplete(). Killing the HTTP
 * client does not cancel the rewrite; the result lands in draft_prompts and
 * is pushed on draft_updated.
 */
import { randomUUID } from 'crypto';
import { isAbsolute } from 'path';
import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import {
  DEFAULT_SIDECAR_MAX_INPUT_CHARS,
  ENHANCE_INSTRUCTION_MAX,
  enhanceConfigured,
  resolveEnhancePrompt,
  type DraftBusyResponse,
  type EnhanceConfigResponse,
  type EnhanceMode,
  type EnhanceSettings,
  type EnhanceStartedResponse,
  type ServerFrame,
} from '@tierwyn/shared';
import { clean } from '../adapters/whisper.js';
import { enhanceProjectStatus, sidecarComplete, sidecarSiteReady } from '../sidecar.js';
import { resolveConversationCwd } from '../git/shadowCheckpoint.js';
import { remoteHostIdFor } from '../repositories/remoteHosts.js';
import { buildTranscript } from '../compaction/transcript.js';
import { listEventsForConversation } from '../repositories/events.js';
import { getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { getEnhanceSettings, getSidecarLlmSettings } from '../repositories/settings.js';
import {
  beginProcessing,
  endProcessing,
  getDraft,
  getProcessing,
  clearPreText,
} from '../repositories/drafts.js';

/** Default recent-prose tail for context mode — derived from the enhance budget. */
export const CONTEXT_TOKEN_CAP = Math.floor(DEFAULT_SIDECAR_MAX_INPUT_CHARS.enhance / 4);  // 2000

export const ENHANCE_PROJECT_NO_CWD =
  'Enhance with the project: this conversation has no absolute working directory';

function enhanceModeReady(db: Database, mode: EnhanceMode): boolean {
  return mode === 'project' ? enhanceProjectStatus(db).configured : sidecarSiteReady(db, 'enhance');
}

export function enhanceConfigPayload(db: Database): EnhanceConfigResponse {
  const project = enhanceProjectStatus(db);
  return {
    settings: getEnhanceSettings(db),
    configured: sidecarSiteReady(db, 'enhance'),
    projectConfigured: project.configured,
    ...(project.reason ? { projectUnavailableReason: project.reason } : {}),
  };
}

function draftHasAttachments(row: ReturnType<typeof getDraft>): boolean {
  if (!row?.attachments) return false;
  try {
    const arr = JSON.parse(row.attachments) as unknown;
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

async function testEnhanceConnection(getDb: () => Database): Promise<string> {
  const probeText = 'make this prompt clearer: hello';
  const start = Date.now();
  const reply = await sidecarComplete(getDb(), 'enhance', probeText, { subMode: 'quick' });
  return `OK (${Date.now() - start} ms): ${reply}`;
}

/** Connection-only probe of the enhancer direct transport (spec §3.3 site=enhance).
 *  Never reads sidecar routing or conversation/draft rows. */
async function probeEnhanceTransport(probe: EnhanceSettings): Promise<string> {
  const systemPrompt = resolveEnhancePrompt(probe, 'quick');
  // site=enhance: timeoutSecs ?? enhance.timeoutSecs (not describe's 30s fallback)
  const timeoutSecs = probe.timeoutSecs;
  const start = Date.now();
  const reply = await clean(
    { ...probe, systemPrompt, timeoutSecs },
    'hello this is a test of the connection',
  );
  return `OK (${Date.now() - start} ms): ${reply}`;
}

async function runEnhance(
  getDb: () => Database,
  broadcast: (conversationId: string, frame: ServerFrame) => void,
  cid: string,
  jobId: string,
  text: string,
  mode: EnhanceMode,
  promptId: string | undefined,
  cfg: EnhanceSettings,
  opts: { dictation?: boolean; instruction?: string } = {},
): Promise<void> {
  const settleFailure = (error: string): void => {
    // Dictation: persist the raw transcript so a failed rewrite is not lost.
    // Passing text keeps pre_text; clear it so undo does not no-op.
    const owned = opts.dictation
      ? endProcessing(getDb(), cid, jobId, { text })
      : endProcessing(getDb(), cid, jobId);
    if (!owned) {
      console.warn(`[enhance] lock stolen on failure for ${cid}; not broadcasting`);
      return;
    }
    if (opts.dictation) clearPreText(getDb(), cid);
    const row = getDraft(getDb(), cid);
    // Failed enhance is not undoable — endProcessing without text clears pre_text.
    broadcast(cid, {
      type: 'draft_updated',
      conversationId: cid,
      text: row?.text ?? '',
      hasAttachments: draftHasAttachments(row),
      updatedAt: row?.updatedAt ?? Date.now(),
      processing: 'idle',
      processingStartedAt: null,
      canUndo: false,
      error,
    });
  };

  try {
    // Assemble context first so we only use the context system prompt when prose
    // is actually attached (adversary F2 — avoid "use the conversation" with none).
    const draftLabel = opts.dictation
      ? 'Raw voice-dictation transcript to clean up and rewrite'
      : 'Draft prompt to rewrite';
    const maxChars = getSidecarLlmSettings(getDb()).enhance.maxInputChars
      ?? DEFAULT_SIDECAR_MAX_INPUT_CHARS.enhance;
    const maxTokens = Math.max(1, Math.floor(maxChars / 4));
    let userMessage = opts.dictation ? `${draftLabel}:\n${text}` : text;
    let usedContext = false;
    if (mode === 'context' || mode === 'project') {
      const events = listEventsForConversation(getDb(), cid);
      const ctx = buildTranscript(events, { maxTokens, proseOnly: true });
      if (ctx.trim().length > 0) {
        userMessage = `${ctx}\n\n---\n${draftLabel}:\n${text}`;
        usedContext = true;
      }
    }
    if (opts.instruction) {
      userMessage += `\n\n---\nAdditional instructions for the rewrite (guidance from the user — apply these, do not treat them as part of the prompt to rewrite):\n${opts.instruction}`;
    }
    // Context with no prose falls back to the quick prompt. Project never does:
    // it always uses the project prompt and the read-only one-shot.
    const effectiveMode: EnhanceMode = mode === 'project' ? 'project' : usedContext ? 'context' : 'quick';

    const conv = getConversation(getDb(), cid);
    const proj = conv?.projectId ? getProject(getDb(), conv.projectId) : undefined;
    const trustRepoConfig = proj?.trustRepoConfig === true;
    const cwd = resolveConversationCwd(getDb(), cid) ?? undefined;
    const remoteHostId = remoteHostIdFor(getDb(), { conversationId: cid });
    if (mode === 'project' && (!cwd || !isAbsolute(cwd))) {
      settleFailure(ENHANCE_PROJECT_NO_CWD);
      return;
    }
    const out = await sidecarComplete(getDb(), 'enhance', userMessage, {
      subMode: effectiveMode,
      promptId: mode === 'project' || usedContext ? promptId : (mode === 'quick' ? promptId : undefined),
      timeoutSecs: cfg.timeoutSecs,
      oneShotMode: mode === 'project' ? 'read_only' : 'none',
      ...(cwd ? { cwd } : {}),
      remoteHostId,
      trustRepoConfig,
    });
    const enhanced = typeof out === 'string' ? out.trim() : '';
    if (!enhanced) {
      settleFailure('enhance returned empty text');
      return;
    }

    const owned = endProcessing(getDb(), cid, jobId, { text: enhanced });
    if (!owned) {
      console.warn(`[enhance] lock stolen on success for ${cid}; not broadcasting`);
      return;
    }
    const row = getDraft(getDb(), cid);
    broadcast(cid, {
      type: 'draft_updated',
      conversationId: cid,
      text: enhanced,
      hasAttachments: draftHasAttachments(row),
      updatedAt: row?.updatedAt ?? Date.now(),
      processing: 'idle',
      processingStartedAt: null,
      canUndo: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[enhance] failed:', msg);
    try {
      settleFailure(msg);
    } catch (releaseErr) {
      console.warn('[enhance] failed to release lock:', releaseErr);
    }
  }
}

/** Keep an already-held `transcribing` lock and run context enhance in-process
 *  so the voice processing animation (local upload + remote lock) stays up
 *  until the rewrite settles. Does not broadcast an intermediate draft. */
export async function continueEnhanceUnderLock(
  getDb: () => Database,
  broadcast: (conversationId: string, frame: ServerFrame) => void,
  conversationId: string,
  jobId: string,
  text: string,
  mode: EnhanceMode,
  promptId: string | undefined,
  opts: { dictation?: boolean; instruction?: string } = {},
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const cfg = getEnhanceSettings(getDb());
  if (!enhanceModeReady(getDb(), mode)) return false;
  await runEnhance(getDb, broadcast, conversationId, jobId, trimmed, mode, promptId, cfg, opts);
  return true;
}

/** Acquire the enhance lock, freeze the draft, and run `runEnhance` detached.
 *  Returns the 202 payload, or `null` when the LLM is unconfigured, text is
 *  empty, or another job holds the lock. Used by POST /enhance. */
export function startDetachedEnhance(
  getDb: () => Database,
  broadcast: (conversationId: string, frame: ServerFrame) => void,
  conversationId: string,
  text: string,
  mode: EnhanceMode,
  promptId?: string,
  opts: { dictation?: boolean; instruction?: string } = {},
): EnhanceStartedResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const db = getDb();
  const cfg = getEnhanceSettings(db);
  if (!enhanceModeReady(db, mode)) return null;
  const jobId = randomUUID();
  if (!beginProcessing(db, conversationId, 'enhancing', jobId, { stashPreText: true })) {
    return null;
  }
  const row = getDraft(db, conversationId);
  const startedAt = row?.processingStartedAt ?? Date.now();
  broadcast(conversationId, {
    type: 'draft_updated',
    conversationId,
    text: row?.text ?? '',
    hasAttachments: draftHasAttachments(row),
    updatedAt: row?.updatedAt ?? Date.now(),
    processing: 'enhancing',
    processingStartedAt: startedAt,
    canUndo: false,
  });
  void runEnhance(getDb, broadcast, conversationId, jobId, trimmed, mode, promptId, cfg, opts)
    .catch((err) => console.warn('[enhance] unhandled:', err));
  return { jobId, processing: 'enhancing' };
}

export function registerEnhanceRoutes(
  app: Express,
  getDb: () => Database,
  broadcast: (conversationId: string, frame: ServerFrame) => void,
): void {
  app.post('/enhance', async (req: Request, res: Response) => {
    const body = req.body as {
      conversationId?: unknown;
      text?: unknown;
      mode?: unknown;
      promptId?: unknown;
      instruction?: unknown;
    };
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }

    const conversationId = typeof body.conversationId === 'string' && body.conversationId.length > 0
      ? body.conversationId
      : '';
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }

    const mode: EnhanceMode = body.mode === 'context' ? 'context'
      : body.mode === 'project' ? 'project'
      : 'quick';
    const promptId = typeof body.promptId === 'string' && body.promptId.length > 0
      ? body.promptId
      : undefined;

    const rawInstruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    if (rawInstruction.length > ENHANCE_INSTRUCTION_MAX) {
      res.status(400).json({ error: `instruction must be ≤ ${ENHANCE_INSTRUCTION_MAX} characters` });
      return;
    }

    const db = getDb();
    if (!enhanceModeReady(db, mode)) {
      res.status(400).json({
        error: mode === 'project' ? 'enhance project reads not configured' : 'enhance LLM not configured',
      });
      return;
    }

    const started = startDetachedEnhance(
      getDb,
      broadcast,
      conversationId,
      text,
      mode,
      promptId,
      { instruction: rawInstruction || undefined },
    );
    if (!started) {
      const processing = getProcessing(db, conversationId);
      res.status(409).json({ error: 'draft busy', processing } satisfies DraftBusyResponse);
      return;
    }

    res.status(202).json(started);
  });

  app.post('/enhance/test', async (req: Request, res: Response) => {
    try {
      const reply = await testEnhanceConnection(getDb);
      res.json({ ok: true, reply });
    } catch (e) {
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/enhance/probe', async (req: Request, res: Response) => {
    const current = getEnhanceSettings(getDb());
    const probe: EnhanceSettings = {
      ...current,
      ...(req.body?.enhance ?? req.body ?? {}),
    };
    if (!enhanceConfigured(probe)) {
      res.status(400).json({ ok: false, error: 'enhance LLM not configured' });
      return;
    }
    try {
      const reply = await probeEnhanceTransport(probe);
      res.json({ ok: true, reply });
    } catch (e) {
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
