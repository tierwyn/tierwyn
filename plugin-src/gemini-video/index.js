// Gemini Video — agent-callable video generation & editing via Google Gemini Omni (Interactions API).
// Agents never see GEMINI_API_KEY; the capability returns an absolute file path only.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const INTERACTION_ID_RE = /^[A-Za-z0-9._-]{1,256}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PROMPT_CHARS = 8_000;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 14 * 1024 * 1024;
const MAX_INPUT_IMAGES = 2;
const MIN_DURATION_S = 3;
const MAX_DURATION_S = 15;
const MAX_INTERPOLATION_DURATION_S = 10;

export const ASPECT_RATIOS = new Set(['16:9', '9:16']);
export const RESOLUTIONS = new Set(['360p', '720p', '1080p', '4K']);

// Each fetchMs stays under the manifest capability timeoutMs (300 000, the host maximum).
export const MODELS = {
  'gemini-omni-1.2-flash': { id: 'gemini-omni-1.2-flash', fetchMs: 285_000 },
  'gemini-omni-1.2-flash-ext': { id: 'gemini-omni-1.2-flash-ext', fetchMs: 285_000 },
};
export const DEFAULT_MODEL = 'gemini-omni-1.2-flash';
const MIME = { mp4: 'video/mp4', webm: 'video/webm' };
const PENDING_STATUSES = new Set(['in_progress', 'queued', 'pending']);

let pollIntervalMs = 4_000;
export function setPollIntervalMsForTests(ms) {
  pollIntervalMs = ms;
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseDuration(raw) {
  if (raw === undefined) return undefined;
  let seconds;
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    seconds = raw;
  } else if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d{1,2})s?$/i);
    if (!m) throw fail('bad_input', `duration must be an integer ${MIN_DURATION_S}–${MAX_DURATION_S} (or "3s"–"15s")`);
    seconds = Number(m[1]);
  } else {
    throw fail('bad_input', `duration must be an integer ${MIN_DURATION_S}–${MAX_DURATION_S} (or "3s"–"15s")`);
  }
  if (seconds < MIN_DURATION_S || seconds > MAX_DURATION_S) {
    throw fail('bad_input', `duration must be between ${MIN_DURATION_S} and ${MAX_DURATION_S} seconds`);
  }
  return seconds;
}

function parseResolution(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw fail('bad_input', `resolution must be one of: ${[...RESOLUTIONS].join(', ')}`);
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase() === '4k' ? '4K' : trimmed.toLowerCase();
  if (!RESOLUTIONS.has(normalized)) {
    throw fail('bad_input', `resolution must be one of: ${[...RESOLUTIONS].join(', ')}`);
  }
  return normalized;
}

/** Validate and normalise video.generate input. Throws bad_input. */
export function validateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_input', 'input must be a JSON object');
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw fail('bad_input', 'prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) throw fail('bad_input', `prompt too long (max ${MAX_PROMPT_CHARS} chars)`);

  const modelKey = raw.model === undefined ? DEFAULT_MODEL : raw.model;
  const model = typeof modelKey === 'string' ? MODELS[modelKey] : undefined;
  if (!model) throw fail('bad_input', `unknown model; valid: ${Object.keys(MODELS).join(', ')}`);

  let aspectRatio;
  if (raw.aspectRatio !== undefined) {
    if (typeof raw.aspectRatio !== 'string' || !ASPECT_RATIOS.has(raw.aspectRatio)) {
      throw fail('bad_input', `aspectRatio must be one of: ${[...ASPECT_RATIOS].join(', ')}`);
    }
    aspectRatio = raw.aspectRatio;
  }

  const resolution = parseResolution(raw.resolution);
  const durationSeconds = parseDuration(raw.duration);

  let inputImages;
  if (raw.inputImages !== undefined) {
    if (!Array.isArray(raw.inputImages) || raw.inputImages.some((p) => typeof p !== 'string')) {
      throw fail('bad_input', 'inputImages must be an array of file paths');
    }
    if (raw.inputImages.length > MAX_INPUT_IMAGES) {
      throw fail('bad_input', `inputImages supports at most ${MAX_INPUT_IMAGES} images (first and last frame)`);
    }
    if (raw.inputImages.length === 2 && durationSeconds !== undefined && durationSeconds > MAX_INTERPOLATION_DURATION_S) {
      throw fail('bad_input', `duration must be ${MIN_DURATION_S}–${MAX_INTERPOLATION_DURATION_S}s when using first and last frames`);
    }
    if (raw.inputImages.length > 0) inputImages = raw.inputImages;
  }

  let previousInteractionId;
  if (raw.previousInteractionId !== undefined) {
    if (typeof raw.previousInteractionId !== 'string' || !INTERACTION_ID_RE.test(raw.previousInteractionId.trim())) {
      throw fail('bad_input', 'previousInteractionId must be a valid interaction id');
    }
    previousInteractionId = raw.previousInteractionId.trim();
  }

  return {
    prompt,
    model,
    aspectRatio,
    resolution,
    durationSeconds,
    inputImages,
    previousInteractionId,
    filename: sanitizeStem(raw.filename),
  };
}

/** Normalise the output stem (extension stripped); undefined -> uuid. Throws bad_input. */
export function sanitizeStem(name) {
  if (name === undefined) return randomUUID();
  if (typeof name !== 'string') throw fail('bad_input', 'filename must be a string');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw fail('bad_input', 'filename must be a bare basename');
  }
  if (!FILENAME_RE.test(name)) throw fail('bad_input', 'filename may only contain letters, digits, . _ -');
  return name.replace(/\.(mp4|webm)$/i, '');
}

/** Artifacts root: <dirname(TIERWYN_DB)>/artifacts (same convention as gemini-image / gemini-music). */
export function resolveArtifactsDir(env = process.env) {
  return join(dirname(resolve(env.TIERWYN_DB ?? './data/tierwyn.db')), 'artifacts');
}

function sniffImageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function confinedToShard(realFile, shardReal) {
  const rel = relative(shardReal, realFile);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Read keyframe input images from the caller's artifacts shard. Throws bad_input. */
export function loadInputImages(paths, artifactsShardDir) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  let shardReal;
  try {
    shardReal = realpathSync(artifactsShardDir);
  } catch {
    throw fail('bad_input', `inputImages must be files in your artifacts dir (${artifactsShardDir})`);
  }
  const out = [];
  let total = 0;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) {
      throw fail('bad_input', `inputImages must be files in your artifacts dir (${artifactsShardDir})`);
    }
    let real;
    try {
      real = realpathSync(p);
    } catch {
      throw fail('bad_input', `inputImages must be files in your artifacts dir (${artifactsShardDir})`);
    }
    if (!confinedToShard(real, shardReal)) {
      throw fail('bad_input', `inputImages must be files in your artifacts dir (${artifactsShardDir})`);
    }
    let buf;
    try {
      buf = readFileSync(real);
    } catch {
      throw fail('bad_input', `inputImages must be files in your artifacts dir (${artifactsShardDir})`);
    }
    if (buf.length > MAX_IMAGE_BYTES) throw fail('bad_input', 'inputImages file exceeds 7 MB');
    total += buf.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw fail('bad_input', 'inputImages total exceeds 14 MB');
    const mimeType = sniffImageMime(buf);
    if (!mimeType) throw fail('bad_input', 'inputImages must be PNG, JPEG, or WEBP');
    out.push({ mimeType, data: buf.toString('base64') });
  }
  return out;
}

/** Build the interactions.create body. Never contains the key. */
export function buildRequest({ prompt, model, aspectRatio, resolution, durationSeconds, images, previousInteractionId }) {
  const input =
    images && images.length > 0
      ? [
          ...images.map((img) => ({ type: 'image', mime_type: img.mimeType, data: img.data })),
          { type: 'text', text: prompt },
        ]
      : prompt;
  const responseFormat = {
    type: 'video',
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(durationSeconds ? { duration: `${durationSeconds}s` } : {}),
  };
  return {
    model: model.id,
    input,
    response_format: responseFormat,
    background: true,
    store: true,
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
  };
}

export function sniffVideo(buf) {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

/** Pull the last video block (inline base64 or downloadable URI) out of an interaction. Throws upstream_error. */
export function extractVideo(body) {
  const steps = Array.isArray(body?.steps) ? body.steps : [];
  const blocks = [];
  for (const s of steps) if (s?.type === 'model_output' && Array.isArray(s.content)) blocks.push(...s.content);
  if (Array.isArray(body?.outputs)) blocks.push(...body.outputs);
  if (body?.output_video && typeof body.output_video === 'object') blocks.push({ type: 'video', ...body.output_video });

  let video = null;
  for (const b of blocks) {
    if (b?.type === 'video' && ((typeof b.data === 'string' && b.data) || (typeof b.uri === 'string' && b.uri))) {
      video = b;
    }
  }
  if (!video) {
    const reason = body?.status && body.status !== 'completed' ? ` (status ${body.status})` : '';
    throw fail('upstream_error', `gemini: no video in response${reason}`);
  }
  if (typeof video.data === 'string' && video.data) {
    const buf = Buffer.from(video.data, 'base64');
    const ext = sniffVideo(buf);
    if (!ext) throw fail('upstream_error', 'gemini: response video is not MP4 or WebM');
    return { kind: 'inline', buf, ext, mime: MIME[ext] };
  }
  return { kind: 'uri', uri: video.uri };
}

function normalizeDownloadUri(uri) {
  if (/\/v1beta\/files\/[^/:?]+$/.test(uri)) return `${uri}:download?alt=media`;
  return uri;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default {
  activate(ctx) {
    ctx.capability('video.generate', async (input, caller) => {
      // 1. validate (bad_input) — before touching the key or the network
      const { prompt, model, aspectRatio, resolution, durationSeconds, inputImages, previousInteractionId, filename } =
        validateInput(input);
      // 2. shard
      let shard;
      if (caller?.kind === 'operator') shard = 'operator';
      else if (typeof caller?.conversationId === 'string' && caller.conversationId) shard = caller.conversationId;
      else throw fail('bad_input', 'agent caller has no conversation id');
      const dir = join(resolveArtifactsDir(), shard);
      const images = inputImages?.length ? loadInputImages(inputImages, dir) : [];
      // 3. key
      const key = ctx.credentials.get('GEMINI_API_KEY');
      if (!key) throw fail('credential_missing', 'Gemini key not configured — set GEMINI_API_KEY in Settings → Plugins');
      // 4. filename must not exist yet — fail before spending a paid Gemini Omni call
      if (existsSync(join(dir, `${filename}.mp4`)) || existsSync(join(dir, `${filename}.webm`))) {
        throw fail('bad_input', `filename already exists: ${filename}`);
      }
      // 5. submit interaction + poll until completed + download if URI delivery
      const deadline = Date.now() + model.fetchMs;
      const remainingMs = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw fail('timeout', `gemini (${model.id}): request timed out after ${model.fetchMs / 1000}s`);
        return left;
      };

      let interaction;
      let out;
      try {
        const res = await ctx.http.fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(
            buildRequest({ prompt, model, aspectRatio, resolution, durationSeconds, images, previousInteractionId }),
          ),
          signal: AbortSignal.timeout(remainingMs()),
        });
        if (!res.ok) throw fail('upstream_error', `gemini (${model.id}): HTTP ${res.status}`);
        interaction = await res.json();

        while (PENDING_STATUSES.has(interaction?.status)) {
          const id = typeof interaction?.id === 'string' && interaction.id ? interaction.id : null;
          if (!id) throw fail('upstream_error', `gemini (${model.id}): missing interaction id for polling`);
          const wait = Math.min(pollIntervalMs, remainingMs());
          if (wait > 0) await sleep(wait);
          const pollRes = await ctx.http.fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: { 'x-goog-api-key': key, Accept: 'application/json' },
            signal: AbortSignal.timeout(remainingMs()),
          });
          if (!pollRes.ok) throw fail('upstream_error', `gemini (${model.id}): poll HTTP ${pollRes.status}`);
          interaction = await pollRes.json();
        }

        const extracted = extractVideo(interaction);
        if (extracted.kind === 'inline') {
          out = extracted;
        } else {
          const dlRes = await ctx.http.fetch(normalizeDownloadUri(extracted.uri), {
            method: 'GET',
            headers: { 'x-goog-api-key': key },
            signal: AbortSignal.timeout(remainingMs()),
          });
          if (!dlRes.ok) throw fail('upstream_error', `gemini (${model.id}): download HTTP ${dlRes.status}`);
          const buf = Buffer.from(await dlRes.arrayBuffer());
          const ext = sniffVideo(buf);
          if (!ext) throw fail('upstream_error', 'gemini: downloaded video is not MP4 or WebM');
          out = { buf, ext, mime: MIME[ext] };
        }
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw fail('timeout', `gemini (${model.id}): request timed out after ${model.fetchMs / 1000}s`);
        }
        if (err instanceof SyntaxError) throw fail('upstream_error', 'gemini: invalid JSON response');
        throw err;
      }

      // 6. write
      const path = join(dir, `${filename}.${out.ext}`);
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(path, out.buf, { flag: 'wx' });
      } catch (err) {
        if (err?.code === 'EEXIST') throw fail('bad_input', `filename already exists: ${filename}`);
        throw err;
      }
      const interactionId = typeof interaction?.id === 'string' && interaction.id ? interaction.id : undefined;
      ctx.log.info(`video.generate (${model.id}) wrote ${out.buf.length} bytes to ${shard}/${filename}.${out.ext}`);
      // 7. output — never bytes, never the key
      return {
        path,
        mime: out.mime,
        bytes: out.buf.length,
        model: model.id,
        ...(interactionId ? { interactionId } : {}),
      };
    });
  },
};
