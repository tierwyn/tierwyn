// Gemini Image — agent-callable image generation via Gemini 3.x image models.
// Agents never see GEMINI_API_KEY; the capability returns an absolute file path only.

import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const EXTENDED_RATIOS = new Set([...ASPECT_RATIOS, '1:4', '4:1', '1:8', '8:1']);
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PROMPT_CHARS = 8_000;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 14 * 1024 * 1024;

// Each fetchMs stays under the manifest capability timeoutMs 180 000; the host
// default of 15 s would otherwise cut Pro off.
export const MODELS = {
  'gemini-3.1-flash-image': {
    id: 'gemini-3.1-flash-image',
    fetchMs: 90_000,
    sizes: new Set(['512', '1K', '2K', '4K']),
    ratios: EXTENDED_RATIOS,
    maxInputs: 14,
    thinking: true,
    search: true,
  },
  'gemini-3.1-flash-lite-image': {
    id: 'gemini-3.1-flash-lite-image',
    fetchMs: 30_000,
    sizes: new Set(['1K']),
    ratios: ASPECT_RATIOS,
    maxInputs: 14,
    thinking: true,
    search: false,
  },
  'gemini-3-pro-image': {
    id: 'gemini-3-pro-image',
    fetchMs: 170_000,
    sizes: new Set(['1K', '2K', '4K']),
    ratios: ASPECT_RATIOS,
    maxInputs: 14,
    thinking: false,
    search: true,
  },
};

export const DEFAULT_MODEL = 'gemini-3.1-flash-image';
export const MODEL_ALIASES = {
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
  'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image',
};

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resolveModel(name) {
  const raw = name === undefined ? DEFAULT_MODEL : name;
  if (typeof raw !== 'string' || !raw) {
    throw fail('bad_input', `unknown model; valid: ${Object.keys(MODELS).join(', ')}`);
  }
  const key = MODEL_ALIASES[raw] ?? raw;
  const spec = MODELS[key];
  if (!spec) throw fail('bad_input', `unknown model ${raw}; valid: ${Object.keys(MODELS).join(', ')}`);
  return { key, ...spec };
}

export function endpointFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`;
}

const ENDPOINT = endpointFor(MODELS[DEFAULT_MODEL]);

/** Validate and normalise image.generate input. Throws bad_input. */
export function validateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('bad_input', 'input must be a JSON object');
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw fail('bad_input', 'prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw fail('bad_input', `prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }
  const model = resolveModel(raw.model);
  let aspectRatio = raw.aspectRatio;
  if (aspectRatio !== undefined) {
    if (typeof aspectRatio !== 'string' || !model.ratios.has(aspectRatio)) {
      throw fail('bad_input', `aspectRatio is not supported by ${model.key}`);
    }
  }
  let imageSize;
  if (raw.imageSize !== undefined) {
    if (typeof raw.imageSize !== 'string') {
      throw fail('bad_input', `imageSize is not supported by ${model.key}`);
    }
    const size = raw.imageSize.trim().toUpperCase();
    if (!model.sizes.has(size)) {
      throw fail('bad_input', `imageSize is not supported by ${model.key}`);
    }
    imageSize = size;
  }
  let inputImages;
  if (raw.inputImages !== undefined) {
    if (!Array.isArray(raw.inputImages) || raw.inputImages.some((p) => typeof p !== 'string')) {
      throw fail('bad_input', 'inputImages must be an array of file paths');
    }
    if (raw.inputImages.length > model.maxInputs) {
      throw fail('bad_input', `inputImages is not supported by ${model.key} (max ${model.maxInputs})`);
    }
    inputImages = raw.inputImages;
  }
  let thinkingLevel;
  if (raw.thinkingLevel !== undefined) {
    const tl = typeof raw.thinkingLevel === 'string' ? raw.thinkingLevel.trim().toLowerCase() : '';
    if (!model.thinking || (tl !== 'minimal' && tl !== 'high')) {
      throw fail('bad_input', `thinkingLevel is not supported by ${model.key}`);
    }
    thinkingLevel = tl;
  }
  let googleSearch;
  if (raw.googleSearch !== undefined) {
    if (typeof raw.googleSearch !== 'boolean' || (raw.googleSearch === true && !model.search)) {
      throw fail('bad_input', `googleSearch is not supported by ${model.key}`);
    }
    if (raw.googleSearch) googleSearch = true;
  }
  return {
    prompt,
    model,
    aspectRatio,
    imageSize,
    inputImages,
    thinkingLevel,
    googleSearch,
    filename: sanitizeFilename(raw.filename),
  };
}

/** Normalise the output basename; undefined -> uuid.png. Throws bad_input. */
export function sanitizeFilename(name) {
  if (name === undefined) return `${randomUUID()}.png`;
  if (typeof name !== 'string') throw fail('bad_input', 'filename must be a string');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw fail('bad_input', 'filename must be a bare basename');
  }
  if (!FILENAME_RE.test(name)) {
    throw fail('bad_input', 'filename may only contain letters, digits, . _ -');
  }
  return name.toLowerCase().endsWith('.png') ? name : `${name}.png`;
}

/** Artifacts root: <dirname(TIERWYN_DB)>/artifacts (same convention as tts-recordings). */
export function resolveArtifactsDir(env = process.env) {
  return join(dirname(resolve(env.TIERWYN_DB ?? './data/tierwyn.db')), 'artifacts');
}

function sniffMime(buf) {
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

/** Read remix inputs from the caller's artifacts shard. Throws bad_input. */
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
    const mimeType = sniffMime(buf);
    if (!mimeType) throw fail('bad_input', 'inputImages must be PNG, JPEG, or WEBP');
    out.push({ mimeType, data: buf.toString('base64') });
  }
  return out;
}

/** Build the generateContent request body. Never contains the key. */
export function buildGeminiRequest({ prompt, aspectRatio, imageSize, images, thinkingLevel, googleSearch }) {
  const imageParts = (images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
  const imageConfig = {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
  return {
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel: thinkingLevel.toUpperCase() } } : {}),
    },
    ...(googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
}

/** Pull the last non-thought inline PNG/JPEG out of a generateContent response. Throws upstream_error. */
export function extractImage(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  const block = body?.promptFeedback?.blockReason;
  if (!Array.isArray(parts)) {
    throw fail(
      'upstream_error',
      typeof block === 'string' ? `gemini: blocked (${block})` : 'gemini: no image in response',
    );
  }
  let chosen = null;
  for (const p of parts) {
    if (p?.thought === true) continue;
    const inline = p?.inlineData ?? p?.inline_data;
    if (inline?.thought === true) continue;
    if (inline?.data) chosen = inline;
  }
  if (!chosen) throw fail('upstream_error', 'gemini: no image in response');
  const mime = chosen.mimeType ?? chosen.mime_type;
  const buf = Buffer.from(chosen.data, 'base64');
  if (buf.length === 0) throw fail('upstream_error', 'gemini: no image in response');
  if (mime === 'image/png') {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw fail('upstream_error', 'gemini: not a valid PNG');
    }
    return { buf, mime: 'image/png', ext: 'png' };
  }
  if (mime === 'image/jpeg') {
    if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      throw fail('upstream_error', 'gemini: not a valid JPEG');
    }
    return { buf, mime: 'image/jpeg', ext: 'jpg' };
  }
  throw fail('upstream_error', `gemini: unexpected image type ${mime}`);
}

export { ASPECT_RATIOS, ENDPOINT };

export default {
  activate(ctx) {
    ctx.capability('image.generate', async (input, caller) => {
      // 1. validate (bad_input) — before touching the key or the network
      const { prompt, model, aspectRatio, imageSize, inputImages, thinkingLevel, googleSearch, filename } =
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
      // 4. filename must not exist yet — fail before spending a paid Gemini call
      const stem = filename.replace(/\.png$/i, '');
      if (existsSync(join(dir, `${stem}.png`)) || existsSync(join(dir, `${stem}.jpg`))) {
        throw fail('bad_input', `filename already exists: ${filename}`);
      }
      // 5. call Gemini — fetch and body read share the per-model AbortSignal
      let image;
      try {
        const res = await ctx.http.fetch(endpointFor(model), {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildGeminiRequest({ prompt, aspectRatio, imageSize, images, thinkingLevel, googleSearch }),
          ),
          signal: AbortSignal.timeout(model.fetchMs),
        });
        if (!res.ok) throw fail('upstream_error', `gemini (${model.key}): HTTP ${res.status}`);
        image = extractImage(await res.json());
      } catch (err) {
        // DOMException TimeoutError carries numeric code 23 — host would call it upstream_error.
        // The signal also governs the body read, so a stalled multi-MB download lands here too.
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw fail('timeout', `gemini (${model.key}): request timed out after ${model.fetchMs / 1000}s`);
        }
        // Non-JSON 200 body (e.g. an HTML error page): never leak upstream text to the caller.
        if (err instanceof SyntaxError) throw fail('upstream_error', 'gemini: invalid JSON response');
        throw err; // host-allow-list / rate-limit errors and our coded errors pass through unchanged
      }
      // 6. write
      const path = join(dir, `${stem}.${image.ext}`);
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(path, image.buf, { flag: 'wx' }); // 'wx' backstop for a collision racing the check above
      } catch (err) {
        if (err?.code === 'EEXIST') throw fail('bad_input', `filename already exists: ${filename}`);
        throw err;
      }
      ctx.log.info(`image.generate wrote ${image.buf.length} bytes to ${shard}/${stem}.${image.ext}`);
      // 7. output — never bytes, never the key
      return { path, mime: image.mime, bytes: image.buf.length };
    });
  },
};
