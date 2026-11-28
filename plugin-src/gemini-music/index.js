// Gemini Music — agent-callable music generation via Google Lyria (Gemini Interactions API).
// Agents never see GEMINI_API_KEY; the capability returns an absolute file path only.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_PROMPT_CHARS = 8_000;
const MAX_LYRICS_CHARS = 8_000;
const INSTRUMENTAL_SUFFIX = '\n\nInstrumental only, no vocals.';

// Each fetchMs stays under the manifest capability timeoutMs (300 000, the host maximum).
export const MODELS = {
  'lyria-3.5': { id: 'lyria-3.5', fetchMs: 290_000, formats: new Set(['mp3', 'wav']) },
  'lyria-3-clip-preview': { id: 'lyria-3-clip-preview', fetchMs: 120_000, formats: new Set(['mp3']) },
};
export const DEFAULT_MODEL = 'lyria-3.5';
const MIME = { mp3: 'audio/mp3', wav: 'audio/wav' };

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Validate and normalise music.generate input. Throws bad_input. */
export function validateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_input', 'input must be a JSON object');
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw fail('bad_input', 'prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) throw fail('bad_input', `prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  const modelKey = raw.model === undefined ? DEFAULT_MODEL : raw.model;
  const model = typeof modelKey === 'string' ? MODELS[modelKey] : undefined;
  if (!model) throw fail('bad_input', `unknown model; valid: ${Object.keys(MODELS).join(', ')}`);
  const format = raw.format === undefined ? 'mp3' : raw.format;
  if (typeof format !== 'string' || !model.formats.has(format)) {
    throw fail('bad_input', `format must be one of: ${[...model.formats].join(', ')} for ${model.id}`);
  }
  if (raw.instrumental !== undefined && typeof raw.instrumental !== 'boolean') {
    throw fail('bad_input', 'instrumental must be a boolean');
  }
  return {
    prompt: raw.instrumental ? prompt + INSTRUMENTAL_SUFFIX : prompt,
    model,
    format,
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
  return name.replace(/\.(mp3|wav)$/i, '');
}

/** Artifacts root: <dirname(TIERWYN_DB)>/artifacts (same convention as gemini-image). */
export function resolveArtifactsDir(env = process.env) {
  return join(dirname(resolve(env.TIERWYN_DB ?? './data/tierwyn.db')), 'artifacts');
}

/** Build the interactions.create body. Never contains the key. */
export function buildRequest({ prompt, model, format }) {
  return {
    model: model.id,
    input: prompt,
    // Lyria 3 Clip only emits MP3, so only send a format when asking 3.5 for WAV.
    ...(format === 'wav' ? { response_format: { type: 'audio', mime_type: 'audio/wav' } } : {}),
  };
}

function sniffAudio(buf) {
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') {
    return 'wav';
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  return null;
}

/** Pull the last audio block and all text (lyrics / structure) out of an interaction. Throws upstream_error. */
export function extractAudio(body) {
  const steps = Array.isArray(body?.steps) ? body.steps : [];
  const blocks = [];
  for (const s of steps) if (s?.type === 'model_output' && Array.isArray(s.content)) blocks.push(...s.content);
  if (Array.isArray(body?.outputs)) blocks.push(...body.outputs); // older response shape
  let audio = null;
  const text = [];
  for (const b of blocks) {
    if (b?.type === 'audio' && typeof b.data === 'string' && b.data) audio = b;
    else if (b?.type === 'text' && typeof b.text === 'string') text.push(b.text);
  }
  if (!audio) {
    const reason = body?.status && body.status !== 'completed' ? ` (status ${body.status})` : '';
    throw fail('upstream_error', `gemini: no audio in response${reason}`);
  }
  const buf = Buffer.from(audio.data, 'base64');
  const ext = sniffAudio(buf);
  if (!ext) throw fail('upstream_error', 'gemini: response audio is not MP3 or WAV');
  const lyrics = text.join('\n').trim();
  return { buf, ext, mime: MIME[ext], lyrics: lyrics ? lyrics.slice(0, MAX_LYRICS_CHARS) : undefined };
}

export default {
  activate(ctx) {
    ctx.capability('music.generate', async (input, caller) => {
      // 1. validate (bad_input) — before touching the key or the network
      const { prompt, model, format, filename } = validateInput(input);
      // 2. shard
      let shard;
      if (caller?.kind === 'operator') shard = 'operator';
      else if (typeof caller?.conversationId === 'string' && caller.conversationId) shard = caller.conversationId;
      else throw fail('bad_input', 'agent caller has no conversation id');
      const dir = join(resolveArtifactsDir(), shard);
      // 3. key
      const key = ctx.credentials.get('GEMINI_API_KEY');
      if (!key) throw fail('credential_missing', 'Gemini key not configured — set GEMINI_API_KEY in Settings → Plugins');
      // 4. filename must not exist yet — fail before spending a paid Lyria call
      if (existsSync(join(dir, `${filename}.mp3`)) || existsSync(join(dir, `${filename}.wav`))) {
        throw fail('bad_input', `filename already exists: ${filename}`);
      }
      // 5. call Lyria — fetch and body read share the per-model AbortSignal
      let out;
      try {
        const res = await ctx.http.fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(buildRequest({ prompt, model, format })),
          signal: AbortSignal.timeout(model.fetchMs),
        });
        if (!res.ok) throw fail('upstream_error', `gemini (${model.id}): HTTP ${res.status}`);
        out = extractAudio(await res.json());
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
      ctx.log.info(`music.generate (${model.id}) wrote ${out.buf.length} bytes to ${shard}/${filename}.${out.ext}`);
      // 7. output — never bytes, never the key
      return { path, mime: out.mime, bytes: out.buf.length, model: model.id, ...(out.lyrics ? { lyrics: out.lyrics } : {}) };
    });
  },
};
