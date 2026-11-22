/**
 * Piper voice catalogue + local install management — mirrors `adapters/whisper.ts`.
 *
 * Lists `~/piper-voices/*.onnx`, downloads curated voices from HF, no Express coupling.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

export interface PiperVoiceCatalogueEntry {
  id: string;
  label: string;
  language: string;
  quality: string;
  onnxPath: string;
  jsonPath: string;
}

export interface PiperInstalledVoice {
  id: string;
  label: string;
  installed: true;
}

export interface PiperCatalogueVoice extends PiperVoiceCatalogueEntry {
  installed: boolean;
}

export interface PiperDownloadEvent {
  id: string;
  downloaded: number;
  total: number;
  pct: number;
  done: boolean;
  error: string | null;
}

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';

/** ponytail: fixed path matches the Flask wrapper; override via PIPER_VOICES_DIR like WHISPER_BIN_PATH. */
export function voicesDir(): string {
  const env = process.env.PIPER_VOICES_DIR;
  if (env && env.length > 0) return env;
  return join(homedir(), 'piper-voices');
}

function catalogueFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // ponytail: dist/adapters in prod, src/adapters in vitest — one hop up covers each layout.
  const fromDist = join(here, '../piper-voices.json');
  if (existsSync(fromDist)) return fromDist;
  return join(here, '../../piper-voices.json');
}

export function loadCatalogue(): PiperVoiceCatalogueEntry[] {
  const raw = readFileSync(catalogueFilePath(), 'utf8');
  return JSON.parse(raw) as PiperVoiceCatalogueEntry[];
}

function parseSidecarLabel(id: string): string {
  try {
    const jsonPath = join(voicesDir(), `${id}.onnx.json`);
    const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      dataset?: string;
      quality?: string;
      language?: { name_english?: string };
    };
    const parts: string[] = [];
    if (meta.language?.name_english) parts.push(meta.language.name_english);
    if (meta.dataset) parts.push(meta.dataset);
    if (meta.quality) parts.push(meta.quality);
    if (parts.length > 0) return parts.join(' · ');
  } catch {
    // ponytail: best-effort metadata parse — never throw on a malformed sidecar.
  }
  return id;
}

/** Returns installed voices from `~/piper-voices/*.onnx`. */
export function listInstalledVoices(): PiperInstalledVoice[] {
  const dir = voicesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.onnx'))
    .map((f) => {
      const id = f.slice(0, -'.onnx'.length);
      return { id, label: parseSidecarLabel(id), installed: true as const };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Curated catalogue annotated with whether each voice is installed locally. */
export function catalogueVoices(): PiperCatalogueVoice[] {
  const installed = new Set(listInstalledVoices().map((v) => v.id));
  return loadCatalogue().map((entry) => ({
    ...entry,
    installed: installed.has(entry.id),
  }));
}

async function streamDownload(
  url: string,
  dest: string,
  onChunk: (downloaded: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`voice download failed: HTTP ${resp.status}`);
  }
  const body = resp.body;
  if (!body) throw new Error('voice download: no response body');

  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const file = createWriteStream(part);
  let downloaded = 0;

  await new Promise<void>((resolve, reject) => {
    const reader = Readable.fromWeb(body as unknown as import('stream/web').ReadableStream<Uint8Array>);
    reader.on('data', (chunk: Buffer) => {
      file.write(chunk);
      downloaded += chunk.length;
      onChunk(downloaded);
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
  return downloaded;
}

/**
 * Stream-downloads a curated voice (.onnx + .onnx.json) if missing.
 * Progress is weighted on the .onnx file; the small sidecar follows.
 * ponytail: no HTTP Range resume (matches whisper deferral).
 */
export async function downloadVoice(
  id: string,
  onProgress: (e: PiperDownloadEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const entry = loadCatalogue().find((v) => v.id === id);
  if (!entry) {
    throw new Error(`unknown voice '${id}'`);
  }

  mkdirSync(voicesDir(), { recursive: true });
  const onnxDest = join(voicesDir(), `${id}.onnx`);
  const jsonDest = join(voicesDir(), `${id}.onnx.json`);

  if (existsSync(onnxDest) && existsSync(jsonDest)) {
    onProgress({ id, downloaded: 0, total: 0, pct: 100, done: true, error: null });
    return;
  }

  let onnxSize = 0;
  try {
    const head = await fetch(`${HF_BASE}${entry.onnxPath}`, { method: 'HEAD', signal });
    onnxSize = Number(head.headers.get('content-length') ?? 0);
  } catch {
    // ponytail: HEAD is best-effort — progress bar works without a total.
  }

  let downloaded = 0;
  let lastPct = -0.5;
  const emit = (done: boolean) => {
    const total = onnxSize || downloaded;
    const pct = total > 0 ? Math.min(100, (downloaded / total) * 100) : (done ? 100 : 0);
    if (done || pct - lastPct >= 0.5) {
      lastPct = pct;
      onProgress({ id, downloaded, total: total || downloaded, pct, done, error: null });
    }
  };

  if (!existsSync(onnxDest)) {
    const onnxBytes = await streamDownload(
      `${HF_BASE}${entry.onnxPath}`,
      onnxDest,
      (n) => { downloaded = n; emit(false); },
      signal,
    );
    downloaded = onnxBytes;
    if (onnxSize === 0) onnxSize = onnxBytes;
  }

  if (!existsSync(jsonDest)) {
    await streamDownload(
      `${HF_BASE}${entry.jsonPath}`,
      jsonDest,
      () => { /* sidecar is tiny — progress already dominated by .onnx */ },
      signal,
    );
  }

  onProgress({
    id,
    downloaded: onnxSize || downloaded,
    total: onnxSize || downloaded,
    pct: 100,
    done: true,
    error: null,
  });
}
