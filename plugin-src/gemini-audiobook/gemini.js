import { extractPcm, parsePcmRate, parseWavSampleRate, DEFAULT_RATE } from './audio.js';

export const MODELS = {
  'gemini-3.8-flash-lite-tts': { id: 'gemini-3.8-flash-lite-tts', fetchMs: 90_000 },
  'gemini-3.8-flash-tts': { id: 'gemini-3.8-flash-tts', fetchMs: 90_000 },
  'gemini-2.5-flash-preview-tts': { id: 'gemini-2.5-flash-preview-tts', fetchMs: 90_000 },
};
export const DEFAULT_MODEL = 'gemini-3.8-flash-lite-tts';

export const VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
];
export const DEFAULT_VOICE = 'Kore';

const VOICE_BY_LOWER = new Map(VOICES.map((v) => [v.toLowerCase(), v]));

export const config = { retryBackoffMs: 2_000 };
const RETRYABLE_HTTP = new Set([429, 500, 503]);

export function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resolveModel(name) {
  const raw = name === undefined ? DEFAULT_MODEL : name;
  if (typeof raw !== 'string' || !raw) {
    throw fail('bad_input', `unknown model; valid: ${Object.keys(MODELS).join(', ')}`);
  }
  const spec = MODELS[raw];
  if (!spec) throw fail('bad_input', `unknown model ${raw}; valid: ${Object.keys(MODELS).join(', ')}`);
  return { key: raw, ...spec };
}

export function resolveVoice(name) {
  if (name === undefined || name === '') return DEFAULT_VOICE;
  if (typeof name !== 'string') {
    throw fail('bad_input', `unknown voice; valid: ${VOICES.join(', ')}`);
  }
  const canonical = VOICE_BY_LOWER.get(name.toLowerCase());
  if (!canonical) throw fail('bad_input', `unknown voice ${name}; valid: ${VOICES.join(', ')}`);
  return canonical;
}

export function endpointFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`;
}

export function buildTtsRequest({ text, voice, style }) {
  const spoken = style ? `Say ${style}: ${text}` : text;
  return {
    contents: [{ parts: [{ text: spoken }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

export function extractAudio(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  const block = body?.promptFeedback?.blockReason;
  if (!Array.isArray(parts)) {
    throw fail(
      'upstream_error',
      typeof block === 'string' ? `gemini: blocked (${block})` : 'gemini: no audio in response',
    );
  }
  for (const p of parts) {
    const inline = p?.inlineData ?? p?.inline_data;
    if (!inline?.data) continue;
    const mime = inline.mimeType ?? inline.mime_type;
    const buf = Buffer.from(inline.data, 'base64');
    if (buf.length === 0) continue;
    const pcm = extractPcm(buf);
    const wavRate = parseWavSampleRate(buf);
    const sampleRate = wavRate ?? parsePcmRate(mime) ?? DEFAULT_RATE;
    return { pcm, sampleRate };
  }
  throw fail(
    'upstream_error',
    typeof block === 'string' ? `gemini: blocked (${block})` : 'gemini: no audio in response',
  );
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function remainingMs(deadlineAt) {
  if (!deadlineAt) return Infinity;
  return deadlineAt - Date.now();
}

/** One Gemini TTS call. Retries once on HTTP 429/500/503 when time remains. */
export async function synthesize(ctx, key, { text, voice, model, style, signal, deadlineAt }) {
  const spec = typeof model === 'string' ? resolveModel(model) : model;
  const voiceName = typeof voice === 'string' && VOICE_BY_LOWER.has(voice.toLowerCase()) ? resolveVoice(voice) : voice;
  const body = JSON.stringify(buildTtsRequest({ text, voice: voiceName, style }));
  const url = endpointFor(spec);

  let lastHttp;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fetchMs = spec.fetchMs;
    const signals = [AbortSignal.timeout(fetchMs)];
    if (signal) signals.unshift(signal);
    let res;
    try {
      res = await ctx.http.fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw fail('timeout', `gemini (${spec.key}): request timed out after ${fetchMs / 1000}s`);
      }
      throw err;
    }
    if (!res.ok) {
      lastHttp = res.status;
      if (RETRYABLE_HTTP.has(res.status) && attempt === 0 && remainingMs(deadlineAt) > fetchMs) {
        try {
          await sleep(config.retryBackoffMs, signal);
        } catch (err) {
          if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            throw fail('timeout', `gemini (${spec.key}): request timed out after ${fetchMs / 1000}s`);
          }
          throw err;
        }
        continue;
      }
      throw fail('upstream_error', `gemini (${spec.key}): HTTP ${res.status}`);
    }
    try {
      return extractAudio(await res.json());
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw fail('timeout', `gemini (${spec.key}): request timed out after ${fetchMs / 1000}s`);
      }
      if (err instanceof SyntaxError) throw fail('upstream_error', 'gemini: invalid JSON response');
      throw err;
    }
  }
  throw fail('upstream_error', `gemini (${spec.key}): HTTP ${lastHttp}`);
}
