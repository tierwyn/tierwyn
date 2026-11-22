/**
 * speak.ts — TTS wrapper: browser speechSynthesis + Piper/Kokoro sidecar audio.
 */

import type {
  TtsProvider,
  TtsRecording,
  TtsRecordingSource,
  TtsSummarizeKind,
  VoiceTtsSettings,
} from '@tierwyn/shared';
import {
  codeSpeakNotice,
  countLines,
  languageLabel,
} from '@tierwyn/shared';
import { ensureUnlockedAudio, ttsParkBeginJob, ttsParkRehydrate } from './ttsParkPlayer.js';

// Re-export for call-site compat (FileModal, tests).
export { codeSpeakNotice, countLines, languageLabel };

export const ttsSupported: boolean = typeof window !== 'undefined' && 'speechSynthesis' in window;

export type SpeakMode = 'as-is' | 'summarize' | 'explain-diff';

/** Optional meta for Piper/Kokoro persist (server ignores without conversationId or projectId). */
export interface SpeakMeta {
  conversationId?: string;
  /** Project-only path when speaking outside a chat (e.g. schedule FileModal). */
  projectId?: string;
  source?: TtsRecordingSource;
  /** Overridden by playWithMode's mode arg when both set; used by speakSidecar. */
  mode?: SpeakMode;
  title?: string;
}

function browserSynthAvailable(): boolean {
  return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis;
}

// ponytail: module-side config, pushed by App — live A/B without prop threading or a refetch per play.
let ttsConfig: VoiceTtsSettings | null = null;
// ponytail: single active sidecar element — one message reads at a time (matches speechSynthesis.cancel semantics).
let current: HTMLAudioElement | null = null;

export function setTtsConfig(cfg: VoiceTtsSettings | null): void {
  ttsConfig = cfg;
}

/** Resolve provider for a play click. Explicit arg wins (the B/P/K letter in the UI). */
export function resolveTtsProvider(override?: TtsProvider): TtsProvider {
  return override ?? ttsConfig?.provider ?? 'browser';
}

/**
 * Strip markdown so TTS reads conversational prose.
 * Only fenced code and GFM tables are skipped (spoken notice); lists, headings,
 * quotes, and other prose markdown stay — markers removed, content kept.
 */
export function speakable(md: string): string {
  let text = md;

  // ponytail: announce skip + fence info-string language; never read the source aloud.
  text = text.replace(/```([^\n`]*)\n?[\s\S]*?```/g, (_m, info: string) => {
    const lang = String(info).trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9_+#-]/g, '') ?? '';
    return lang ? ` (${lang} code block skipped) ` : ' (code block skipped) ';
  });

  // Unwrap math delimiters — keep the expression text; only code/tables are skipped.
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, ' $1 ');
  text = text.replace(/\$([^\$\n]+)\$/g, ' $1 ');

  // ponytail: tool tags must never be read aloud — strip block + contents. The antml: prefix is Claude Code-specific; both forms covered.
  text = text.replace(/<(antml:)?tool_call>[\s\S]*?<\/\1?tool_call>/g, ' ');
  text = text.replace(/<(antml:)?tool_result>[\s\S]*?<\/\1?tool_result>/g, ' ');
  text = text.replace(/<(antml:)?(function_calls|invoke|parameter|param)[^>]*>[\s\S]*?<\/\1?\2>/g, ' ');

  text = text.replace(/^>\s*\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|INFO)\][^\n]*$/gim, '');

  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/^---\n[\s\S]*?\n---/m, ' ');

  // ponytail: contiguous GFM pipe-table rows → one skip notice (not silent drop).
  text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*\n?)+/gm, ' (table skipped) \n');

  // Bare URLs → short spoken stand-in; markdown [label](url) keeps the label below.
  text = text.replace(/(?<![\(\[])https?:\/\/[^\s)\]]+/g, ' (link) ');

  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^>\s*/gm, '');
  // Lists / headings / quotes: strip markers only — item text is spoken.
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');
  text = text.replace(/[*_~|]/g, '');
  text = text.replace(/\n{2,}/g, '. ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/\s{2,}/g, ' ');

  return text.trim();
}

function speakBrowser(text: string, onEnd?: () => void): void {
  // ponytail: ttsSupported now only guards the browser branch.
  if (!browserSynthAvailable()) return;

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language;

  if (onEnd) {
    utterance.onend = () => onEnd();
    utterance.onerror = () => onEnd();
  }

  speechSynthesis.speak(utterance);
}

async function speakSidecar(
  text: string,
  provider: 'piper' | 'kokoro',
  onEnd?: () => void,
  meta?: SpeakMeta,
): Promise<boolean> {
  stopSpeaking();

  try {
    const body: Record<string, string> = { text, provider };
    if (meta?.conversationId) body.conversationId = meta.conversationId;
    if (meta?.projectId) body.projectId = meta.projectId;
    if (meta?.source) body.source = meta.source;
    if (meta?.mode) body.mode = meta.mode;
    if (meta?.title) body.title = meta.title;

    const res = await fetch('/tts/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (!res.ok) {
      // Honor the B/P/K letter: do NOT silently switch to browser when K/P is shown.
      // Silent fallback made refresh/sidecar failures sound like browser TTS with letter still K.
      let detail = '';
      try { detail = await res.text(); } catch { /* body already consumed */ }
      console.error(
        '[tts] sidecar', provider, 'returned', res.status, detail.slice(0, 200),
        '— not falling back to browser (letter shows', provider, ')',
      );
      onEnd?.();
      return false;
    }

    const audio = new Audio(URL.createObjectURL(await res.blob()));
    current = audio;
    audio.onended = audio.onerror = () => {
      URL.revokeObjectURL(audio.src);
      if (current === audio) current = null;
      onEnd?.();
    };
    await audio.play();
    return true;
  } catch (err) {
    console.error('[tts] sidecar', provider, 'threw', err, '— not falling back to browser');
    onEnd?.();
    return false;
  }
}

// ponytail: one synth entrypoint — provider logic stays DRY across the 3 callers.
// `providerOverride` is the letter next to the speaker (B/P/K); always preferred over module config.
async function synthText(
  text: string,
  onEnd?: () => void,
  providerOverride?: TtsProvider,
  meta?: SpeakMeta,
): Promise<void> {
  const stripped = speakable(text);
  if (!stripped) return;

  const provider = resolveTtsProvider(providerOverride);

  if (provider === 'piper' || provider === 'kokoro') {
    await speakSidecar(stripped, provider, onEnd, meta);
    return;
  }

  stopSpeaking();
  speakBrowser(stripped, onEnd);
}

/** Payload for the explain-diff speak mode (D3: rides in the summarizeOpts slot). */
export interface ExplainDiffOpts {
  /** Unified diff text — required for mode 'explain-diff'. */
  diff: string;
  filename: string;
  lang?: string;
  /** Current file text (working tree) or blob at sha (history). */
  fileContext?: string;
  diffSource: 'working-tree' | 'commit';
  sha?: string;
  truncated?: boolean;
}

export interface SummarizeForSpeechOpts extends Partial<ExplainDiffOpts> {
  kind?: TtsSummarizeKind;
  filename?: string;
  lang?: string;
  /** Optional focus steering for 'summarize' (ignored by as-is / explain-diff). */
  guidance?: string;
  /** Target spoken length in minutes, 1–30. Server clamps. */
  targetMinutes?: number;
}

/** Whether "Explain changes" should be offered: a real diff, a tracked file,
 *  and a configured summarize LLM. Pure so it is testable in the node-env suite. */
export function explainDiffAvailable(args: {
  diff?: string | null;
  isTracked?: boolean;
  summarizeConfigured: boolean;
}): boolean {
  if (!args.summarizeConfigured) return false;
  if (args.isTracked === false) return false;
  return (args.diff ?? '').trim().length > 0;
}

/** Monotonic play id — ignore late browser-path summarize results after a newer play starts. */
let playGeneration = 0;

/**
 * POST /tts/summarize — returns spoken rewrite, or throws with a message.
 *
 * Production FileModal no longer uses this (server owns summarize via speak-record).
 * Kept for tests, browser-provider summarize, and any future non-durable caller.
 */
export async function summarizeForSpeech(
  md: string,
  opts?: SummarizeForSpeechOpts,
  mode: SpeakMode = 'summarize',
): Promise<string> {
  const payload: Record<string, unknown> = { text: md };
  if (mode === 'explain-diff') {
    payload.mode = 'explain-diff';
    payload.diff = opts?.diff ?? '';
    if (opts?.fileContext) payload.fileContext = opts.fileContext;
    if (opts?.diffSource) payload.diffSource = opts.diffSource;
    if (opts?.sha) payload.sha = opts.sha;
    if (opts?.truncated) payload.truncated = true;
  }
  if (opts?.kind) payload.kind = opts.kind;
  if (opts?.filename) payload.filename = opts.filename;
  if (opts?.lang) payload.lang = opts.lang;
  if (opts?.guidance) payload.guidance = opts.guidance;
  if (typeof opts?.targetMinutes === 'number') payload.targetMinutes = opts.targetMinutes;

  const res = await fetch('/tts/summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({})) as { text?: string; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `summarize failed (${res.status})`);
  }
  const out = typeof body.text === 'string' ? body.text.trim() : '';
  if (!out) throw new Error('summarize returned empty text');
  return out;
}

/**
 * Server-owned speak+record pipeline (Piper/Kokoro + conversationId and/or projectId).
 * POST /tts/speak-record returns 202 { jobId } immediately; the park player polls
 * the job and plays when done. Summarize failures fail closed server-side (row → error).
 *
 * Returns true when the job was accepted (park owns playback). False on 4xx/5xx
 * or if the short handshake fetch aborts before a jobId is confirmed.
 */
async function speakRecord(
  text: string,
  provider: 'piper' | 'kokoro',
  mode: SpeakMode,
  meta: SpeakMeta,
  summarizeOpts?: SummarizeForSpeechOpts,
  onEnd?: () => void,
): Promise<boolean> {
  lastSpeakArgs = [text, provider, mode, meta, summarizeOpts, onEnd];
  stopSpeaking();
  ensureUnlockedAudio();

  try {
    const body: Record<string, unknown> = {
      text,
      provider,
      mode,
    };
    if (meta.conversationId) body.conversationId = meta.conversationId;
    if (meta.projectId) body.projectId = meta.projectId;
    if (meta.source) body.source = meta.source;
    if (meta.title) body.title = meta.title;
    if (summarizeOpts?.kind) body.kind = summarizeOpts.kind;
    if (summarizeOpts?.filename) body.filename = summarizeOpts.filename;
    if (summarizeOpts?.lang) body.lang = summarizeOpts.lang;
    if (summarizeOpts?.guidance) body.guidance = summarizeOpts.guidance;
    if (typeof summarizeOpts?.targetMinutes === 'number') body.targetMinutes = summarizeOpts.targetMinutes;
    if (mode === 'explain-diff') {
      if (summarizeOpts?.diff) body.diff = summarizeOpts.diff;
      if (summarizeOpts?.fileContext) body.fileContext = summarizeOpts.fileContext;
      if (summarizeOpts?.diffSource) body.diffSource = summarizeOpts.diffSource;
      if (summarizeOpts?.sha) body.sha = summarizeOpts.sha;
      if (summarizeOpts?.truncated) body.truncated = true;
    }

    // Handshake is short (validate + allocate row → 202). Park unlocks autoplay
    // in beginJob which runs immediately after this resolve.
    const res = await fetch('/tts/speak-record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json() as { error?: string };
        detail = j.error ?? '';
      } catch {
        try { detail = await res.text(); } catch { /* ignore */ }
      }
      console.error(
        '[tts] speak-record', provider, 'returned', res.status, detail.slice(0, 200),
      );
      // Surface 429 / other failures on the park bar so the user sees something.
      const provisional: TtsRecording = {
        id: `error-${Date.now()}`,
        project_id: meta.projectId ?? '',
        conversation_id: meta.conversationId ?? null,
        created_at: Date.now(),
        source: meta.source ?? 'other',
        mode,
        provider,
        voice: '',
        title: meta.title ?? '',
        spoken_text: text,
        path: '',
        bytes: 0,
        status: 'error',
        error: detail || `speak-record failed (${res.status})`,
        updated_at: Date.now(),
        ephemeral: 0,
      };
      ttsParkRehydrate(provisional);
      onEnd?.();
      return false;
    }

    const payload = await res.json() as { jobId?: string; status?: string };
    const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
    if (!jobId) {
      console.error('[tts] speak-record missing jobId');
      onEnd?.();
      return false;
    }

    const provisionalRec: TtsRecording = {
      id: jobId,
      project_id: meta.projectId ?? '',
      conversation_id: meta.conversationId ?? null,
      created_at: Date.now(),
      source: meta.source ?? 'other',
      mode,
      provider,
      voice: '',
      title: meta.title ?? '',
      spoken_text: text,
      path: '',
      bytes: 0,
      status: 'running',
      error: null,
      updated_at: Date.now(),
      ephemeral: 0,
    };

    // Park owns polling + playback (silent-WAV gesture unlock runs inside beginJob).
    ttsParkBeginJob(jobId, provisionalRec, onEnd);
    return true;
  } catch (err) {
    // Handshake aborted (rare — response is fast). Job may still exist server-side.
    console.error('[tts] speak-record', provider, 'threw', err);
    const provisional: TtsRecording = {
      id: `error-${Date.now()}`,
      project_id: meta.projectId ?? '',
      conversation_id: meta.conversationId ?? null,
      created_at: Date.now(),
      source: meta.source ?? 'other',
      mode,
      provider,
      voice: '',
      title: meta.title ?? '',
      spoken_text: text,
      path: '',
      bytes: 0,
      status: 'error',
      error: "couldn't confirm job — check Recordings",
      updated_at: Date.now(),
      ephemeral: 0,
    };
    ttsParkRehydrate(provisional);
    onEnd?.();
    return false;
  }
}

/**
 * Stop any current speech, then play. `summarize` uses the LLM then speakable();
 * on LLM failure the play fails closed — nothing is read aloud and the error
 * rethrows (browser path only — durable speak-record rows fail server-side and
 * surface on the park bar).
 * Optional `summarizeOpts` (e.g. kind: 'code') is forwarded to POST /tts/summarize
 * (or /tts/speak-record when piper/kokoro + conversationId or projectId).
 * Optional `meta` tags Piper/Kokoro synth for the project/conversation recordings library.
 *
 * When provider is piper|kokoro and meta has conversationId or projectId, uses a
 * single POST /tts/speak-record so the server finishes summarize+synth+persist even
 * if the user navigates away mid-request.
 */
export async function playWithMode(
  md: string,
  mode: SpeakMode,
  onEnd?: () => void,
  provider?: TtsProvider,
  summarizeOpts?: SummarizeForSpeechOpts,
  meta?: SpeakMeta,
): Promise<void> {
  const gen = ++playGeneration;
  stopSpeaking();

  const resolvedProvider = resolveTtsProvider(provider);
  const conversationId = meta?.conversationId?.trim() || undefined;
  const projectId = meta?.projectId?.trim() || undefined;
  const durableMeta: SpeakMeta | undefined =
    conversationId || projectId
      ? { ...meta, conversationId, projectId }
      : undefined;

  // Durable path: server owns the full pipeline (survives SPA navigation).
  // Summarize/explain-diff failures land the row in error; the park bar surfaces it.
  if (
    (resolvedProvider === 'piper' || resolvedProvider === 'kokoro') &&
    durableMeta
  ) {
    const serverMode: SpeakMode = durableMeta.mode ?? mode;
    // As-is: strip markdown client-side (speakable lives here).
    // LLM modes (summarize / explain-diff): raw text — do NOT run speakable() on a diff.
    // ponytail: callers pass the diff as both `md` and opts.diff so the recording
    // row's placeholder text is meaningful without a special-case handshake.
    const textForServer =
      serverMode === 'as-is' ? speakable(md) : md;
    if (!textForServer) {
      onEnd?.();
      return;
    }

    const ok = await speakRecord(
      textForServer,
      resolvedProvider,
      serverMode,
      durableMeta,
      serverMode === 'as-is' ? undefined : summarizeOpts,
      onEnd,
    );

    if (gen !== playGeneration) {
      onEnd?.();
      return;
    }

    if (!ok) onEnd?.();
    return;
  }

  let text = md;
  if (mode === 'summarize' || mode === 'explain-diff') {
    try {
      text = await summarizeForSpeech(md, summarizeOpts, mode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[tts]', mode, 'failed — failing closed:', msg);
      onEnd?.();
      throw new Error(`${mode} failed: ${msg}`);
    }
  }

  if (gen !== playGeneration) {
    onEnd?.();
    return;
  }
  const synthMeta: SpeakMeta | undefined = meta
    ? { ...meta, mode: meta.mode ?? mode }
    : undefined;
  await synthText(text, onEnd, provider, synthMeta);
}

/** Args of the most recent speakRecord call — backs the park-bar Retry button. */
let lastSpeakArgs: Parameters<typeof speakRecord> | null = null;

export function hasTtsSpeakRetry(): boolean {
  return lastSpeakArgs !== null;
}

export async function retryLastSpeakRecord(): Promise<boolean> {
  if (!lastSpeakArgs) return false;
  return speakRecord(...lastSpeakArgs);
}

/**
 * Speak the given markdown string aloud, cancelling any current utterance first.
 * Pass `provider` from the B/P/K control so the engine matches the letter after refresh.
 */
export async function speak(
  md: string,
  onEnd?: () => void,
  provider?: TtsProvider,
  meta?: SpeakMeta,
): Promise<void> {
  await playWithMode(md, 'as-is', onEnd, provider, undefined, meta);
}

/** Concatenate message chunks and speak as one utterance. */
export async function speakChunks(
  chunks: string[],
  onEnd?: () => void,
  provider?: TtsProvider,
  mode: SpeakMode = 'as-is',
  meta?: SpeakMeta,
  summarizeOpts?: SummarizeForSpeechOpts,
): Promise<void> {
  const filtered = chunks.filter(Boolean);
  if (filtered.length === 0) return;
  await playWithMode(filtered.join('\n\n'), mode, onEnd, provider, mode === 'as-is' ? undefined : summarizeOpts, meta);
}

/** Speak the current text selection; returns false if selection was empty. */
export async function speakSelection(
  selection: Selection | null | undefined,
  onEnd?: () => void,
  provider?: TtsProvider,
  mode: SpeakMode = 'as-is',
  meta?: SpeakMeta,
): Promise<boolean> {
  const text = selection?.toString()?.trim();
  if (!text) return false;
  await playWithMode(text, mode, onEnd, provider, undefined, {
    ...meta,
    source: meta?.source ?? 'selection',
  });
  return true;
}

/**
 * Cancel any ongoing speech immediately.
 */
export function stopSpeaking(): void {
  if (browserSynthAvailable()) speechSynthesis.cancel();
  if (current) {
    current.pause();
    URL.revokeObjectURL(current.src);
    current = null;
  }
}

/** Role prefix for multi-item “to end” joins (helps LLM summarize; fine for as-is). */
export type SpeakRole = 'user' | 'agent' | 'subagent';

/** Flat transcript item for TTS scope (“this message” / “from here to end”). */
export interface SpeakScopeItem {
  type: string;
  /** Speakable text: prompt text, agent markdown, or stripped spawn-result text. */
  chunk: string;
  /**
   * Spawn breadcrumb cards. Non-result markers are never spoken.
   * Result markers are spoken (chunk = stripped result prose).
   */
  isSpawnMarker?: boolean;
  /** When isSpawnMarker, the spawnMarker.kind — only `'result'` is speakable. */
  spawnKind?: string;
  /** Optional role for multi-item join prefixes (`User:` / `Agent:` / `Subagent:`). */
  role?: SpeakRole;
}

/** Strip the UI prefix from spawn result marker text before TTS/rendering.
 *  Markers come in variants — `◀ result:`, `⚠ ◀ result (degenerate):`,
 *  `◀ result (follow-up[, failed]):`, `◀ result (manual push):` — strip them
 *  all (the manual-push variant leaked raw into the result card,
 *  which also broke the leading `## Result` heading parse). */
export function spawnResultSpeakText(text: string): string {
  return text.replace(/^⚠?\s*◀\s*result(?:\s*\([^)]*\))?:\s*/i, '').trim();
}

/** Whether an index item is included in “this message” / “from here to end”. */
export function isSpeakableScopeItem(it: SpeakScopeItem): boolean {
  if (!it.chunk) return false;
  if (it.type === 'prompt') return true;
  if (it.type === 'message') {
    if (it.isSpawnMarker) return it.spawnKind === 'result';
    return true;
  }
  return false;
}

function formatChunkWithRole(it: SpeakScopeItem): string {
  const body = it.chunk;
  if (!body) return '';
  if (it.role === 'user') return `User: ${body}`;
  if (it.role === 'agent') return `Agent: ${body}`;
  if (it.role === 'subagent') return `Subagent: ${body}`;
  return body;
}

/**
 * Collect speakable transcript chunks from `fromIndex` through the end of the list.
 * Includes user/parent prompts, agent messages, and spawn Result markers.
 * Skips tools, non-result spawn cards, and empty chunks.
 * When items carry `role`, prefixes each chunk (`User:` / `Agent:` / `Subagent:`).
 *
 * Name kept for call-site compat; also covers prompts + result markers (v2).
 */
export function collectMessageChunksFromIndex(
  items: ReadonlyArray<SpeakScopeItem>,
  fromIndex: number,
): string[] {
  if (fromIndex < 0 || fromIndex >= items.length) return [];
  const out: string[] = [];
  for (let i = fromIndex; i < items.length; i++) {
    const it = items[i];
    if (!isSpeakableScopeItem(it)) continue;
    const formatted = formatChunkWithRole(it);
    if (formatted) out.push(formatted);
  }
  return out;
}

/** Alias — same as collectMessageChunksFromIndex (prompts + messages + results). */
export const collectSpeakChunksFromIndex = collectMessageChunksFromIndex;

/** Join message chunks for multi-message TTS scope. */
export function joinSpeakChunks(chunks: string[]): string {
  return chunks.filter(Boolean).join('\n\n');
}
