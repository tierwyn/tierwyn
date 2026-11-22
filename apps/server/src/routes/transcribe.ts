/**
 * Speech-to-text HTTP routes — multipart upload → ffmpeg → whisper-cli →
 * [optional cleanup LLM] → `{ text }`.
 *
 * Routes:
 *   POST /transcribe                              — main STT
 *   POST /transcribe/arm                          — arm/disarm in-flight auto-send
 *   POST /transcribe/cancel                       — abort an in-flight job (click-to-stop)
 *   GET  /transcribe/config                       — binary/model presence + cleanup cfg
 *   POST /transcribe/test                         — cleanup test-connection
 *   POST /transcribe/model/download?model=...     — start HF model download
 *   GET  /transcribe/model/download/progress?model=...  — poll download progress
 *
 * Auth is applied globally by `requireAuth` in index.ts (registered before this
 * module). Mirrors `routes/files.ts` shape: a `registerTranscribeRoutes(app)`
 * called from index.ts.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import type { WhisperModel, WhisperDownloadProgress, ServerFrame, DraftProcessing } from '@tierwyn/shared';
import { DEFAULT_SIDECAR_TIMEOUTS } from '@tierwyn/shared';
import {
  WHISPER_MODELS,
  findBin,
  modelPath,
  transcribe,
  ensureModel,
  readConfig,
  testCleanupConnection,
  type DownloadEvent,
} from '../adapters/whisper.js';
import { sidecarComplete, sidecarSiteReady } from '../sidecar.js';
import { getVoiceSettings, getSidecarLlmSettings, updateVoiceSettings } from '../repositories/settings.js';
import {
  appendDraft, getDraft, deleteDraft, beginProcessing, endProcessing, draftCanUndo,
  stashDraftPreTextValue, setDraftAutoSend, draftAutoSendCtx, effectiveProcessing,
  forceReleaseTranscribing,
} from '../repositories/drafts.js';
import type { SessionManager } from '../sessionManager.js';
import { continueEnhanceUnderLock } from './enhance.js';

/** 25 MB upload cap — matches the Express JSON body limit at index.ts:172. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Base server-side cap on audio transcode + Whisper transcribe.
 *  120 s of audio × base ≈ 30 s transcribe; 120 s gives ample headroom for audio processing. */
export const TRANSCRIBE_BASE_TIMEOUT_MS = 120_000;

/** Backward compatibility alias for tests and external consumers. */
export const TRANSCRIBE_TIMEOUT_MS = TRANSCRIBE_BASE_TIMEOUT_MS;

/**
 * Request timeout for transcribe = base 120s (audio transcode + Whisper)
 * + configured cleanup LLM timeout.
 * Read per-request so settings changes take effect without server restart.
 */
export function transcribeTimeoutMs(db: Database): number {
  const route = getSidecarLlmSettings(db).transcribe;
  const voice = getVoiceSettings(db);
  const cleanupSecs = route.timeoutSecs
    ?? voice.cleanup.timeoutSecs
    ?? DEFAULT_SIDECAR_TIMEOUTS.transcribe;
  return TRANSCRIBE_BASE_TIMEOUT_MS + (cleanupSecs * 1000);
}

/** Below this many trimmed chars, a transcript is treated as likely-silence and
 *  is NOT auto-sent — it still lands in the draft for manual review (D6).
 *  ponytail: length gate only; whisper silence hallucinations ≥2 chars ("you",
 *  "thanks") still pass. Upgrade path: gate on whisper no_speech_prob (-oj JSON). */
const AUTO_SEND_MIN_CHARS = 2;

function draftHasAttachments(row: ReturnType<typeof getDraft>): boolean {
  if (!row?.attachments) return false;
  try {
    const arr = JSON.parse(row.attachments) as unknown;
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

function draftUpdatedFrame(
  conversationId: string,
  row: ReturnType<typeof getDraft>,
  processing: DraftProcessing,
  extras: {
    text?: string;
    hasAttachments?: boolean;
    updatedAt?: number;
    canUndo?: boolean;
    processingStartedAt?: number | null;
    error?: string;
  } = {},
): ServerFrame {
  return {
    type: 'draft_updated',
    conversationId,
    text: extras.text ?? row?.text ?? '',
    hasAttachments: extras.hasAttachments ?? draftHasAttachments(row),
    updatedAt: extras.updatedAt ?? row?.updatedAt ?? Date.now(),
    processing,
    processingStartedAt: extras.processingStartedAt !== undefined
      ? extras.processingStartedAt
      : (processing === 'idle' ? null : Date.now()),
    canUndo: extras.canUndo ?? draftCanUndo(row, processing),
    ...(extras.error !== undefined ? { error: extras.error } : {}),
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

function isWhisperModel(v: unknown): v is WhisperModel {
  return typeof v === 'string' && (WHISPER_MODELS as readonly string[]).includes(v);
}

/** Parse the optional per-request cleanup controls from the query string.
 *  `skipCleanup` (Fast mode) disables LLM cleanup for this request only;
 *  `promptId` overrides the settings-selected prompt. Exported for unit tests. */
export function parseCleanupFlags(q: Record<string, unknown>): {
  skipCleanup: boolean;
  promptId?: string;
  enhanceContext: boolean;
  enhanceProject: boolean;
  /** Which rewrite to run under the held lock. Project wins when both flags are set. */
  enhanceMode: 'context' | 'project' | null;
} {
  const s = q.skipCleanup;
  const skipCleanup = s === '1' || s === 'true';
  const promptId = typeof q.promptId === 'string' && q.promptId.length > 0 ? q.promptId : undefined;
  const e = q.enhanceContext;
  const enhanceContext = e === '1' || e === 'true';
  const p = q.enhanceProject;
  const enhanceProject = p === '1' || p === 'true';
  const enhanceMode = enhanceProject ? 'project' : enhanceContext ? 'context' : null;
  return { skipCleanup, promptId, enhanceContext, enhanceProject, enhanceMode };
}

/** In-memory download tracker — single-user, no DB row needed; polled by the
 *  client at ~1 Hz. Cleared when a download completes (the file is on disk). */
interface DownloadState {
  model: WhisperModel;
  progress: WhisperDownloadProgress;
}
const downloads = new Map<WhisperModel, DownloadState>();

// In-flight auto-send arm slot — mirrors `downloads` Map.
type ArmSlot = {
  armed: boolean;
  ctx: { profileId: string; agent: string; model: string } | null;
  abort: () => void;
  jobId: string | null;
};
const inFlight = new Map<string, ArmSlot>();   // key: conversationId
// ponytail: one mic ⇒ ≤1 transcription per conversation in flight. Slot is created
// at /transcribe entry, cleared in finally. Slow enhance awaits rewrite on the same
// request so cancel still hits this slot.

function eventToProgress(e: DownloadEvent): WhisperDownloadProgress {
  return {
    model: e.model,
    downloaded: e.downloaded,
    total: e.total,
    pct: e.pct,
    done: e.done,
    error: e.error,
  };
}

/**
 * Run ffmpeg to transcode the uploaded webm/mp4/ogg to 16 kHz mono PCM WAV —
 * the format whisper.cpp's miniaudio decoder handles reliably (mirrors
 * 16 kHz mono WAV). Returns a promise that rejects on non-zero exit.
 */
function transcodeToWav(input: string, output: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y', '-i', input,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      output,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`ffmpeg failed to spawn: ${err.message}`));
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(-400) || '(no stderr)'}`));
        return;
      }
      resolve();
    });
  });
}

export function registerTranscribeRoutes(
  app: Express,
  getDb: () => Database,
  broadcast: (conversationId: string, frame: ServerFrame) => void,
  sessionManager: Pick<SessionManager, 'autoSendTranscript'>,
): void {
  // ── POST /transcribe ────────────────────────────────────────────────────
  app.post('/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: 'no audio upload — field name must be "audio"' });
      return;
    }

    const modelRaw = req.query.model;
    const model = isWhisperModel(modelRaw) ? modelRaw : null;
    if (!model) {
      res.status(400).json({ error: `model query param must be one of ${WHISPER_MODELS.join('/')}` });
      return;
    }
    const language = typeof req.query.language === 'string' && req.query.language.length > 0
      ? req.query.language
      : 'auto';
    const conversationId =
      typeof req.query.conversationId === 'string' && req.query.conversationId.trim()
        ? req.query.conversationId.trim()
        : null;

    const bin = findBin();
    if (!bin.ok) {
      res.status(500).json({ error: 'whisper-cli binary not available', detail: bin.error });
      return;
    }
    const modelFile = modelPath(model);
    try {
      // Stat the model file directly — readConfig() would also list the other
      // models; we only care about this one.
      const { statSync } = await import('fs');
      statSync(modelFile);
    } catch {
      res.status(400).json({ error: 'model not available', model, detail: `download via POST /transcribe/model/download?model=${model}` });
      return;
    }

    // Scratch dir keeps cleanup to one rmSync — ffmpeg input + wav land here.
    const scratch = mkdtempSync(join(tmpdir(), 'tierwyn-transcribe-'));
    const wav = join(scratch, 'out.wav');

    const controller = new AbortController();
    // Register an armable slot AFTER scratch-dir + bin/model checks succeed, so a
    // throw from mkdtempSync (or any pre-await failure) can't leave a stale slot.
    // POST /transcribe/arm flips it while ffmpeg/whisper run. POST /transcribe/cancel
    // aborts `controller` (explicit operator click — not disconnect, which is D1).
    // Cleared in finally.
    if (conversationId) {
      inFlight.set(conversationId, {
        armed: false,
        ctx: null,
        abort: () => { try { controller.abort('cancelled'); } catch { /* already */ } },
        jobId: null,
      });
    }

    const jobId = randomUUID();
    if (conversationId) {
      const slot = inFlight.get(conversationId);
      if (slot) slot.jobId = jobId;
    }
    let holdsLock = false;
    if (conversationId) {
      holdsLock = beginProcessing(getDb(), conversationId, 'transcribing', jobId);
      if (holdsLock) {
        const row = getDraft(getDb(), conversationId);
        broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'transcribing'));
      } else {
        // Enhance is running — should be impossible via the UI. Still transcribe
        // (durability floor) but do not freeze or call endProcessing: a settle
        // frame with processing:'idle' would wrongly unfreeze the enhance.
        console.warn(`[transcribe] draft busy for ${conversationId}; transcribing without freeze`);
      }
    }

    const timer = setTimeout(() => controller.abort(), transcribeTimeoutMs(getDb()));
    // Do NOT abort whisper on client disconnect (D1). Only the timeout or an
    // explicit POST /transcribe/cancel aborts. Disconnect still settles.
    const userCancelled = (): boolean =>
      controller.signal.aborted && controller.signal.reason === 'cancelled';
    const throwIfCancelled = (): void => {
      if (userCancelled()) {
        const err = new Error('cancelled');
        err.name = 'AbortError';
        throw err;
      }
    };

    const releaseAndSettle = (error?: string): void => {
      if (!conversationId || !holdsLock) return;
      endProcessing(getDb(), conversationId, jobId);
      holdsLock = false;
      const row = getDraft(getDb(), conversationId);
      broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'idle', {
        processingStartedAt: null,
        ...(error !== undefined ? { error } : {}),
      }));
    };

    try {
      await transcodeToWav(file.path, wav, controller.signal);
      throwIfCancelled();
      const { text: raw } = await transcribe({
        bin: bin.path,
        model: modelFile,
        wav,
        language,
        signal: controller.signal,
      });
      throwIfCancelled();

      // Optional cleanup. "Never eat words": on failure, return the raw
      // transcript with a warning rather than failing the request. Fast mode
      // (skipCleanup) bypasses cleanup entirely, even if cleanup.enabled.
      const { skipCleanup, promptId, enhanceMode } = parseCleanupFlags(req.query as Record<string, unknown>);
      let text = raw;
      // Slow enhance (context or project): skip the cleanup LLM — one enhance
      // does cleanup + rewrite in one turn. Fast already sets skipCleanup;
      // force it here so a missing client flag cannot double-call.
      if (!skipCleanup && !enhanceMode && sidecarSiteReady(getDb(), 'transcribe') && raw.length > 0) {
        try {
          text = await sidecarComplete(getDb(), 'transcribe', raw, {
            ...(promptId ? { promptId } : {}),
          });
        } catch (e) {
          // ponytail: cleanup is best-effort — the raw transcript is already usable,
          // so log the failure server-side instead of surfacing a useless UI warning.
          console.warn(`[transcribe] cleanup skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throwIfCancelled();

      let autoSent = false;
      let autoSendError: string | undefined;

      if (conversationId && text.length > 0) {
        try {
          const slot = inFlight.get(conversationId);

          // Slow enhance (context or project) must enhance first — never auto-send the raw clip.
          if (slot?.armed && text.trim().length >= AUTO_SEND_MIN_CHARS && !enhanceMode) {
            const updatedAt = appendDraft(getDb(), conversationId, text);
            // R12: release before settle so frames hardcode idle.
            if (holdsLock) {
              endProcessing(getDb(), conversationId, jobId);
              holdsLock = false;
            }
            // Send the FULL draft (typed + this transcript) — auto "hit send" (D2).
            const fullDraft = getDraft(getDb(), conversationId)?.text ?? text;
            const outcome = sessionManager.autoSendTranscript(conversationId, fullDraft, slot.ctx);
            if (outcome === 'dropped') {
              autoSendError = 'no agent profile to send to';
              const row = getDraft(getDb(), conversationId);
              // Always settle — every device must unfreeze (D7).
              broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'idle', {
                text: fullDraft,
                updatedAt,
                processingStartedAt: null,
              }));
            } else {
              autoSent = true;
              deleteDraft(getDb(), conversationId);                        // sent → clear (D3)
              broadcast(conversationId, draftUpdatedFrame(conversationId, null, 'idle', {
                text: '',
                hasAttachments: false,
                updatedAt: Date.now(),
                canUndo: false,
                processingStartedAt: null,
              }));
            }
          } else if (enhanceMode && holdsLock) {
            // Slow enhance (context or project): do not append the raw clip to
            // `text` (a reload would paint it as an editable "cleanup" draft).
            // Enhance the in-memory full draft; keep `transcribing` until the rewrite settles.
            const prior = getDraft(getDb(), conversationId)?.text ?? '';
            const full = prior.trim() ? `${prior} ${text}` : text;
            stashDraftPreTextValue(getDb(), conversationId, full);
            clearTimeout(timer);
            const ok = await continueEnhanceUnderLock(
              getDb,
              broadcast,
              conversationId,
              jobId,
              full,
              enhanceMode,
              undefined,
              { dictation: true },
            );
            holdsLock = false;
            if (ok) {
              const row = getDraft(getDb(), conversationId);
              text = row?.text ?? full;
              const live = inFlight.get(conversationId);
              const ctx = live?.armed ? live.ctx : draftAutoSendCtx(row);
              const armed = Boolean(live?.armed || row?.autoSend);
              if (armed && text.trim().length >= AUTO_SEND_MIN_CHARS) {
                const outcome = sessionManager.autoSendTranscript(conversationId, text, ctx);
                if (outcome === 'dropped') {
                  autoSendError = 'no agent profile to send to';
                } else {
                  autoSent = true;
                  deleteDraft(getDb(), conversationId);
                  broadcast(conversationId, draftUpdatedFrame(conversationId, null, 'idle', {
                    text: '',
                    hasAttachments: false,
                    updatedAt: Date.now(),
                    canUndo: false,
                    processingStartedAt: null,
                  }));
                }
              }
            } else {
              endProcessing(getDb(), conversationId, jobId, { text: full });
              const row = getDraft(getDb(), conversationId);
              broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'idle', {
                text: full,
                processingStartedAt: null,
              }));
            }
          } else {
            // Append-only: always broadcast the settled draft (plan §6.2 invert
            // of "no broadcast while connected"). Applying the full text is idempotent.
            const updatedAt = appendDraft(getDb(), conversationId, text);
            if (holdsLock) {
              endProcessing(getDb(), conversationId, jobId);
              holdsLock = false;
            }
            const row = getDraft(getDb(), conversationId)!;
            broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'idle', {
              updatedAt,
              processingStartedAt: null,
            }));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[transcribe] draft/auto-send skipped (${conversationId}): ${msg}`);
          // Lock may still be held if appendDraft threw before R12 release.
          // finally would drop the DB lock with no settle frame → frozen UI.
          if (holdsLock) {
            releaseAndSettle(msg);
          } else {
            const row = getDraft(getDb(), conversationId);
            broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'idle', {
              processingStartedAt: null,
              error: msg,
            }));
          }
        }
      } else if (conversationId && holdsLock) {
        // Empty transcript (or no text): still unfreeze subscribers.
        releaseAndSettle();
      }

      if (!res.writableEnded) res.json({ text, autoSent, ...(autoSendError ? { autoSendError } : {}) });
    } catch (e) {
      if (userCancelled()) {
        // Operator click — settle idle with no transcript and no error banner.
        releaseAndSettle();
        if (!res.writableEnded) res.json({ cancelled: true, text: '' });
      } else {
        const msg = controller.signal.aborted
          ? 'transcription timed out or client disconnected'
          : (e instanceof Error ? e.message : String(e));
        releaseAndSettle(msg);
        if (controller.signal.aborted) {
          if (!res.writableEnded) res.status(504).json({ error: msg });
        } else {
          if (!res.writableEnded) res.status(502).json({ error: msg });
        }
      }
    } finally {
      clearTimeout(timer);
      if (conversationId && holdsLock) endProcessing(getDb(), conversationId, jobId);
      if (conversationId) inFlight.delete(conversationId);
      // multer tmp file + wav + scratch dir
      try { rmSync(file.path, { force: true }); } catch { /* best-effort */ }
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ── POST /transcribe/arm ────────────────────────────────────────────────
  // Flip an in-flight transcription's arm slot. Never creates a slot — late
  // arms after /transcribe finished hit 404 and store nothing (cannot mis-fire
  // on a later recording).
  app.post('/transcribe/arm', (req: Request, res: Response) => {
    const body = req.body as {
      conversationId?: unknown;
      profileId?: unknown;
      agent?: unknown;
      agentModel?: unknown;
      armed?: unknown;
    } | undefined;
    const conversationId =
      typeof body?.conversationId === 'string' && body.conversationId.trim()
        ? body.conversationId.trim()
        : '';
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    const slot = inFlight.get(conversationId);
    if (!slot) {
      res.status(404).json({ error: 'no transcription in flight' });
      return;
    }
    const armed = body?.armed !== false;
    if (armed) {
      const profileId = typeof body?.profileId === 'string' ? body.profileId : '';
      const agent = typeof body?.agent === 'string' ? body.agent : '';
      const agentModel = typeof body?.agentModel === 'string' ? body.agentModel : '';
      if (!profileId || !agent || !agentModel) {
        res.status(400).json({ error: 'profileId, agent, and agentModel required when arming' });
        return;
      }
      slot.armed = true;
      slot.ctx = { profileId, agent, model: agentModel };
      setDraftAutoSend(getDb(), conversationId, slot.ctx);
    } else {
      slot.armed = false;
      // Leave ctx in place — disarm is undoable and re-arm may reuse the same profile.
      setDraftAutoSend(getDb(), conversationId, null);
    }
    res.json({ armed: slot.armed });
  });

  // ── POST /transcribe/cancel ─────────────────────────────────────────────
  // Explicit operator abort (voice-strip click). Does not run on disconnect (D1).
  // Kills ffmpeg/whisper via the in-flight AbortController; the /transcribe
  // request then settles idle with no transcript.
  app.post('/transcribe/cancel', (req: Request, res: Response) => {
    const body = req.body as { conversationId?: unknown } | undefined;
    const conversationId =
      typeof body?.conversationId === 'string' && body.conversationId.trim()
        ? body.conversationId.trim()
        : '';
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    const slot = inFlight.get(conversationId);
    if (!slot) {
      // No tracked job: the lock row may be orphaned (server restarted mid-job
      // or the settle broadcast was missed). A live 'transcribing' lock with no
      // slot can never settle on its own — force-release so the composer
      // unfreezes instead of waiting out the 180 s stale TTL (a page refresh
      // re-reads the same row). 'enhancing' locks are left to enhance's own
      // runner; pre_text is preserved so a Slow enhance stash stays undoable.
      const db = getDb();
      if (effectiveProcessing(getDraft(db, conversationId)) === 'transcribing'
        && forceReleaseTranscribing(db, conversationId)) {
        broadcast(conversationId, draftUpdatedFrame(conversationId, getDraft(db, conversationId), 'idle', {
          processingStartedAt: null,
        }));
        res.json({ cancelled: true, forced: true });
        return;
      }
      res.status(404).json({ error: 'no transcription in flight' });
      return;
    }
    slot.abort();
    if (slot.jobId) {
      const owned = endProcessing(getDb(), conversationId, slot.jobId);
      if (owned) {
        const row = getDraft(getDb(), conversationId);
        broadcast(conversationId, draftUpdatedFrame(conversationId, row, 'idle', {
          processingStartedAt: null,
        }));
      }
    }
    inFlight.delete(conversationId);
    res.json({ cancelled: true });
  });

  // ── GET /transcribe/config ──────────────────────────────────────────────
  app.get('/transcribe/config', (_req, res) => {
    res.json(readConfig(getDb()));
  });

  // ── POST /transcribe/test ───────────────────────────────────────────────
  // Body = partial VoiceCleanupSettings (merged with current). Runs the
  // cleanup LLM against a fixed probe string and returns the latency + reply.
  app.post('/transcribe/test', async (req, res) => {
    const db = getDb();
    const current = getVoiceSettings(db);
    const probe = {
      ...current.cleanup,
      ...(req.body?.cleanup ?? {}),
    };
    try {
      const reply = await testCleanupConnection(probe);
      res.json({ ok: true, reply });
    } catch (e) {
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── POST /transcribe/model/download ─────────────────────────────────────
  app.post('/transcribe/model/download', (req, res) => {
    const model = isWhisperModel(req.query.model) ? (req.query.model as WhisperModel) : null;
    if (!model) {
      res.status(400).json({ error: `model must be one of ${WHISPER_MODELS.join('/')}` });
      return;
    }
    if (downloads.has(model)) {
      const existing = downloads.get(model)!;
      if (!existing.progress.done && existing.progress.error === null) {
        res.status(409).json({ error: 'download already in progress', progress: existing.progress });
        return;
      }
    }
    downloads.set(model, {
      model,
      progress: { model, downloaded: 0, total: 0, pct: 0, done: false, error: null },
    });
    // Fire-and-forget — the route returns immediately, client polls progress.
    ensureModel(model, (e) => {
      const state = downloads.get(model);
      if (state) state.progress = eventToProgress(e);
    })
      .then(() => {
        // Leave the terminal progress in place for one last poll, then clear.
        setTimeout(() => { downloads.delete(model); }, 5_000);
      })
      .catch((e) => {
        const state = downloads.get(model);
        if (state) {
          state.progress = {
            ...state.progress,
            done: true,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        setTimeout(() => { downloads.delete(model); }, 30_000);
      });
    res.json({ ok: true, model });
  });

  // ── GET /transcribe/model/download/progress ─────────────────────────────
  app.get('/transcribe/model/download/progress', (req, res) => {
    const model = isWhisperModel(req.query.model) ? (req.query.model as WhisperModel) : null;
    if (!model) {
      res.status(400).json({ error: `model must be one of ${WHISPER_MODELS.join('/')}` });
      return;
    }
    const state = downloads.get(model);
    if (!state) {
      // No download in-flight — the client treats this as "done or never
      // started"; it should refetch /transcribe/config to see if the file
      // is now on disk.
      res.json({
        model,
        downloaded: 0,
        total: 0,
        pct: 0,
        done: true,
        error: null,
      });
      return;
    }
    res.json(state.progress);
  });
}
