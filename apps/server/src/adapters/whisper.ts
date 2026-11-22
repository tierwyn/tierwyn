/**
 * Local whisper.cpp speech-to-text and transcript cleanup.
 *
 * Pipeline (called by `routes/transcribe.ts`):
 *   ffmpeg → 16kHz mono WAV → spawn whisper-cli → cleanTranscript → [optional] clean()
 *
 * Pure module — no Express coupling, so unit tests can exercise `cleanTranscript`
 * and `findBin` without spinning up a server. The route layer wires HTTP.
 */
import { spawn } from 'child_process';
import { buildChildEnv } from '../childEnv.js';
import { createWriteStream, renameSync, statSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir, availableParallelism } from 'os';
import { join, dirname } from 'path';
import { Readable } from 'stream';
import type {
  WhisperModel,
  WhisperModelInfo,
  WhisperConfigResponse,
  VoiceCleanupSettings,
  LlmCleanupTransport,
} from '@tierwyn/shared';
import type { Database } from 'better-sqlite3';
import { getVoiceSettings } from '../repositories/settings.js';

export const WHISPER_MODELS: readonly WhisperModel[] = ['base', 'small', 'medium'] as const;

/** Shared local whisper data dir so the 1.5 GB medium model isn't duplicated. */
export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'mewisper');
}

export function modelPath(model: WhisperModel): string {
  return join(dataDir(), 'models', `ggml-${model}.bin`);
}

export type BinResult = { ok: true; path: string };
export type BinError = { ok: false; error: string };

/**
 * Resolution order — port of `whisper.rs:32-56`:
 *   1. `WHISPER_BIN_PATH` env var (explicit override)
 *   2. bundled `~/.local/share/mewisper/bin/whisper-cli`
 *   3. `$PATH` scan for `whisper-cli` or `whisper-cpp`
 */
export function findBin(): BinResult | BinError {
  const envPath = process.env.WHISPER_BIN_PATH;
  if (envPath && envPath.length > 0) {
    try {
      if (statSync(envPath).isFile()) return { ok: true, path: envPath };
    } catch {
      return { ok: false, error: `WHISPER_BIN_PATH '${envPath}' does not exist` };
    }
  }
  const bundled = join(dataDir(), 'bin', 'whisper-cli');
  if (existsSync(bundled)) return { ok: true, path: bundled };
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(':')) {
    if (!dir) continue;
    for (const name of ['whisper-cli', 'whisper-cpp']) {
      const p = join(dir, name);
      try {
        if (statSync(p).isFile()) return { ok: true, path: p };
      } catch {
        // not present here — keep scanning
      }
    }
  }
  return {
    ok: false,
    error: `whisper-cli not found. Set WHISPER_BIN_PATH or install whisper.cpp to ${bundled} or on $PATH.`,
  };
}

/**
 * Strips whisper.cpp's inline annotation lines and collapses whitespace —
 * port of `whisper.rs:140-147`. Exported for direct unit testing.
 *
 * whisper emits things like `[BLANK_AUDIO]`, `(gentle music)`, `*sigh*` on
 * their own lines; drop those. Real transcript lines are joined with spaces
 * and any internal whitespace runs collapsed.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length === 0) return false;
      if (l.startsWith('[') && l.endsWith(']')) return false;
      if (l.startsWith('(') && l.endsWith(')')) return false;
      if (l.startsWith('*') && l.endsWith('*')) return false;
      return true;
    })
    .join(' ')
    .split(/\s+/)
    .join(' ')
    .trim();
}

export interface TranscribeOptions {
  bin: string;
  model: string;
  wav: string;
  /** ISO code or 'auto'. */
  language?: string;
  threads?: number;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  stderr: string;
}

/**
 * Spawn `whisper-cli` with the standard arg set:
 *   whisper-cli -m <model> -f <wav> -l <lang> -t <threads> -nt -np
 * `-nt` = no timestamps, `-np` = no progress. Returns cleaned transcript.
 *
 * Rejects on non-zero exit. Honours `signal` by SIGTERM-ing the child.
 */
export function transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    const lang = opts.language && opts.language.length > 0 ? opts.language : 'auto';
    const threads = String(opts.threads ?? defaultThreads());
    const args = ['-m', opts.model, '-f', opts.wav, '-l', lang, '-t', threads, '-nt', '-np'];
    const child = spawn(opts.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildEnv({ LC_ALL: 'C.UTF-8' }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(new Error(`failed to spawn ${opts.bin}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`whisper-cli exited ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      resolve({ text: cleanTranscript(stdout), stderr });
    });
  });
}

function defaultThreads(): number {
  // Default to 4 threads; clamp to a sane
  // upper bound so we don't oversubscribe on big boxes.
  const cpus = typeof availableParallelism === 'function' ? availableParallelism() : 4;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2)));
}

export interface ModelAvailability extends WhisperModelInfo {}

/** Returns the per-model availability for the settings UI. */
export function listModels(): WhisperModelInfo[] {
  return WHISPER_MODELS.map((id) => {
    let sizeBytes: number | null = null;
    try {
      sizeBytes = statSync(modelPath(id)).size;
    } catch {
      // missing — leave null
    }
    return { id, sizeBytes, available: sizeBytes !== null };
  });
}

/**
 * Snapshot of the whisper.cpp install — used by `GET /transcribe/config`.
 * Pulls the cleanup settings from the DB so the UI renders everything in one
 * round-trip.
 */
export function readConfig(db: Database): WhisperConfigResponse {
  const bin = findBin();
  return {
    binaryFound: bin.ok,
    binaryPath: bin.ok ? bin.path : null,
    binaryError: bin.ok ? null : bin.error,
    models: listModels(),
    cleanup: getVoiceSettings(db).cleanup,
  };
}

// ── Model download ──────────────────────────────────────────────────────────

export interface DownloadEvent {
  model: WhisperModel;
  downloaded: number;
  total: number;
  pct: number;
  done: boolean;
  error: string | null;
}

function modelUrl(model: WhisperModel): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

/**
 * Stream-downloads `ggml-{model}.bin` if missing — port of `whisper.rs:59-114`.
 * Calls `onProgress` at ≥0.5% increments (or every ~256 KB on small files).
 * Writes to a `.part` tmp file and atomically renames on completion; a failed
 * download restarts from zero (no HTTP Range resume).
 *
 * Resolves to the final path. Rejects on HTTP error / network interruption.
 * `signal` aborts the fetch and deletes the `.part`.
 */
export async function ensureModel(
  model: WhisperModel,
  onProgress: (e: DownloadEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!WHISPER_MODELS.includes(model)) {
    throw new Error(`unknown model '${model}'`);
  }
  const dest = modelPath(model);
  if (existsSync(dest)) return dest;

  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  const resp = await fetch(modelUrl(model), { signal });
  if (!resp.ok) {
    throw new Error(`model download failed: HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get('content-length') ?? 0);
  const body = resp.body;
  if (!body) throw new Error('model download: no response body');

  const file = createWriteStream(part);
  let downloaded = 0;
  let lastPct = -0.5;

  await new Promise<void>((resolve, reject) => {
    const reader = Readable.fromWeb(body as unknown as import('stream/web').ReadableStream<Uint8Array>);
    reader.on('data', (chunk: Buffer) => {
      file.write(chunk);
      downloaded += chunk.length;
      const pct = total > 0 ? (downloaded / total) * 100 : 0;
      if (pct - lastPct >= 0.5) {
        lastPct = pct;
        onProgress({ model, downloaded, total, pct, done: false, error: null });
      }
    });
    reader.on('error', (err) => {
      file.destroy();
      try { unlinkSync(part); } catch { /* may not exist */ }
      reject(err);
    });
    reader.on('end', () => {
      file.end(() => resolve());
    });
  });

  renameSync(part, dest);
  onProgress({ model, downloaded, total: total || downloaded, pct: 100, done: true, error: null });
  return dest;
}

// ── Optional LLM cleanup ────────────────────────────────────────────────────

async function cleanOpenAICompatible(cfg: LlmCleanupTransport, text: string, signal: AbortSignal): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'user', content: text },
    ],
  };
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
  if (cfg.apiKey && cfg.apiKey.length > 0) {
    (init.headers as Record<string, string>).authorization = `Bearer ${cfg.apiKey}`;
  }
  const resp = await fetch(url, init);
  const json = await resp.json().catch(() => null) as
    | { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
    | null;
  if (!resp.ok) {
    const msg = json?.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`cleanup ${msg}`);
  }
  const out = json?.choices?.[0]?.message?.content?.trim();
  if (!out || out.length === 0) {
    throw new Error('cleanup returned empty text');
  }
  return out;
}

/** Gemini cleanup — port of `cleanup.rs:58-86`. */
async function cleanGemini(cfg: LlmCleanupTransport, text: string, signal: AbortSignal): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
  const safetySettings = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ].map((category) => ({ category, threshold: 'BLOCK_NONE' }));
  const contents = [{ role: 'user', parts: [{ text }] }];
  const body = {
    systemInstruction: { parts: [{ text: cfg.systemPrompt }] },
    contents,
    generationConfig: { temperature: 0 },
    safetySettings,
  };
  type GeminiJson = {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  let json: GeminiJson | null = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    lastStatus = resp.status;
    json = await resp.json().catch(() => null) as GeminiJson | null;
    if (resp.ok) break;
    if (resp.status < 500 || resp.status >= 600) break;
    if (attempt < 1) await new Promise((r) => setTimeout(r, 1000));
  }
  if (lastStatus < 200 || lastStatus >= 300) {
    const msg = json?.error?.message ?? `HTTP ${lastStatus}`;
    throw new Error(`Gemini ${msg}`);
  }
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const out = parts
    .filter((p) => p && p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
  if (!out || out.length === 0) {
    throw new Error('Gemini: no text in response');
  }
  return out;
}

export async function clean(cfg: LlmCleanupTransport, text: string): Promise<string> {
  const secs = Math.max(1, cfg.timeoutSecs);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, secs * 1000);
  try {
    const out = cfg.provider === 'gemini'
      ? await cleanGemini(cfg, text, controller.signal)
      : await cleanOpenAICompatible(cfg, text, controller.signal);
    return out.trim();
  } catch (e) {
    // A fired timeout surfaces as a bare "This operation was aborted" DOMException
    // — translate it to something the operator can act on (endpoint slow/unreachable).
    if (timedOut) throw new Error(`cleanup timed out after ${secs}s (endpoint slow or unreachable — check ${cfg.provider} baseUrl/model)`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Test-connection — port of `cleanup.rs:24-28`. Returns a latency-prefixed
 * reply string so the UI can show "OK (123 ms): <reply>".
 */
export async function testCleanupConnection(cfg: LlmCleanupTransport): Promise<string> {
  const start = Date.now();
  const reply = await clean(cfg, 'hello this is a test of the connection');
  return `OK (${Date.now() - start} ms): ${reply}`;
}
