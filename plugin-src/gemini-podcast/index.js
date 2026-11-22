import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { applyMicroRamp, concatPcm, pcmToWav, silence, SEGMENT_CHARS, TURN_GAP_MS } from './audio.js';
import {
  fail,
  resolveModel,
  resolveTextModel,
  resolveVoice,
  synthesize,
  synthesizeMulti,
  generateText,
  VOICE_TRAITS,
} from './gemini.js';
import {
  ACTIONS,
  MULTI_BLOCK_CHARS,
  buildPrompt,
  cleanModelOutput,
  estimateSeconds,
  groupMultiBlocks,
  parseScript,
  splitOversized,
} from './script.js';

export * from './audio.js';
export * from './script.js';
export {
  MODELS,
  TEXT_MODELS,
  VOICES,
  VOICE_TRAITS,
  DEFAULT_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VOICE,
  fail,
  resolveModel,
  resolveTextModel,
  resolveVoice,
  synthesize,
  synthesizeMulti,
  generateText,
  endpointFor,
  buildTtsRequest,
  buildMultiSpeakerRequest,
  extractAudio,
  extractText,
  config as geminiConfig,
} from './gemini.js';

export const MAX_SEGMENTS = 48;
export const MAX_SCRIPT_CHARS = 30_000;
export const MAX_TOPIC_CHARS = 2_000;
export const MAX_SOURCE_CHARS = 50_000;
export const CONCURRENCY = 4;
export const DEFAULT_SPEAKER_VOICES = [
  'Zephyr',
  'Puck',
  'Kore',
  'Charon',
  'Aoede',
  'Fenrir',
  'Leda',
  'Orus',
  'Sulafat',
  'Iapetus',
];

export const config = {
  budgetMs: 280_000,
  mp3TimeoutMs: 30_000,
  concurrency: CONCURRENCY,
};

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FORMATS = new Set(['wav', 'mp3']);
const MODES = new Set(['auto', 'multi-speaker', 'line-by-line']);
const INTENSITIES = new Set(['subtle', 'expressive', 'dramatic']);
const ACTION_SET = new Set(ACTIONS);

let ffmpegProbe;

export function resetFfmpegProbe() {
  ffmpegProbe = undefined;
}

export function resolveArtifactsDir(env = process.env) {
  return join(dirname(resolve(env.TIERWYN_DB ?? './data/tierwyn.db')), 'artifacts');
}

export function sanitizeFilename(name, ext) {
  if (name === undefined) return `${randomUUID()}.${ext}`;
  if (typeof name !== 'string') throw fail('bad_input', 'filename must be a string');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw fail('bad_input', 'filename must be a bare basename');
  }
  if (!FILENAME_RE.test(name)) {
    throw fail('bad_input', 'filename may only contain letters, digits, . _ -');
  }
  const stem = name.replace(/\.(wav|mp3)$/i, '');
  return `${stem}.${ext}`;
}

function sanitiseTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
}

export function defaultPodcastFilename(title, ext) {
  const stem = sanitiseTitle(title);
  if (!stem) return `${randomUUID()}.${ext}`;
  return sanitizeFilename(`podcast_${stem}_${randomBytes(3).toString('hex')}`, ext);
}

function resolveFormat(raw) {
  const format = raw === undefined || raw === '' ? 'wav' : raw;
  if (typeof format !== 'string' || !FORMATS.has(format)) {
    throw fail('bad_input', 'format must be wav or mp3');
  }
  return format;
}

function resolveLanguage(raw, field = 'language') {
  if (raw === undefined || raw === '') return 'English';
  if (typeof raw !== 'string') throw fail('bad_input', `${field} must be a string`);
  if (raw.includes('\n') || raw.includes('\r') || raw.length > 40) {
    throw fail('bad_input', `${field} must be ≤40 chars with no newlines`);
  }
  return raw;
}

function requireString(raw, field, max) {
  if (typeof raw !== 'string') throw fail('bad_input', `${field} is required`);
  const v = raw.trim();
  if (!v) throw fail('bad_input', `${field} is required`);
  if (v.length > max) throw fail('bad_input', `${field} too long (max ${max} chars)`);
  return v;
}

function optionalInt(raw, field, min, max) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw fail('bad_input', `${field} must be an integer ${min}–${max}`);
  }
  return raw;
}

export function resolveSpeakers(raw) {
  if (!Array.isArray(raw)) throw fail('bad_input', 'speakers must be an array');
  if (raw.length < 1 || raw.length > 10) throw fail('bad_input', 'speakers: 1–10 required');
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!c || typeof c !== 'object') throw fail('bad_input', 'speakers entries must be objects');
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) throw fail('bad_input', 'speakers[].name is required');
    if (name.length > 40) throw fail('bad_input', 'speakers[].name too long (max 40 chars)');
    const key = name.toLowerCase();
    if (seen.has(key)) throw fail('bad_input', `duplicate speaker name: ${name}`);
    seen.add(key);
    const voiceRaw = c.voice === undefined || c.voice === '' ? DEFAULT_SPEAKER_VOICES[i] : c.voice;
    out.push({ name, voice: resolveVoice(voiceRaw) });
  }
  return out;
}

function assertInputObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('bad_input', 'input must be a JSON object');
  }
}

function parseRequiredScript(raw, speakers) {
  const script = requireString(raw, 'script', MAX_SCRIPT_CHARS);
  const parsed = parseScript(script);
  if (parsed.turns.length === 0) throw fail('bad_input', 'script must contain at least one Speaker N: line');
  for (const t of parsed.turns) {
    if (t.speaker > speakers.length) {
      throw fail(
        'bad_input',
        `script uses Speaker ${t.speaker} but only ${speakers.length} speakers configured`,
      );
    }
  }
  return { script, parsed };
}

export function validateScriptInput(raw) {
  assertInputObject(raw);
  if (typeof raw.action !== 'string' || !ACTION_SET.has(raw.action)) {
    throw fail('bad_input', `unknown action; valid: ${ACTIONS.join(', ')}`);
  }
  const action = raw.action;
  const speakers = resolveSpeakers(raw.speakers);
  const language = resolveLanguage(raw.language);
  const model = resolveTextModel(raw.model);
  const out = { action, speakers, language, model };

  if (action === 'write') {
    out.topic = requireString(raw.topic, 'topic', MAX_TOPIC_CHARS);
    out.targetMinutes = optionalInt(raw.targetMinutes, 'targetMinutes', 1, 30);
  } else if (action === 'podcastify') {
    out.sourceText = requireString(raw.sourceText, 'sourceText', MAX_SOURCE_CHARS);
    out.targetMinutes = optionalInt(raw.targetMinutes, 'targetMinutes', 1, 30);
  } else {
    const { script, parsed } = parseRequiredScript(raw.script, speakers);
    out.script = script;
    out.parsed = parsed;
  }

  if (action === 'shorten') {
    const d = optionalInt(raw.deltaSeconds, 'deltaSeconds', 30, 1800);
    if (d === undefined) throw fail('bad_input', 'deltaSeconds is required');
    out.deltaSeconds = d;
  } else if (action === 'lengthen') {
    out.deltaSeconds = optionalInt(raw.deltaSeconds, 'deltaSeconds', 30, 1800);
  }

  if (action === 'expressions') {
    const intensity = raw.intensity === undefined || raw.intensity === '' ? 'expressive' : raw.intensity;
    if (typeof intensity !== 'string' || !INTENSITIES.has(intensity)) {
      throw fail('bad_input', 'intensity must be subtle, expressive, or dramatic');
    }
    out.intensity = intensity;
  }

  if (action === 'translate') {
    if (raw.targetLanguage === undefined || raw.targetLanguage === '') {
      throw fail('bad_input', 'targetLanguage is required');
    }
    out.targetLanguage = resolveLanguage(raw.targetLanguage, 'targetLanguage');
  }

  return out;
}

function resolveMode(raw, speakersUsed) {
  const mode = raw === undefined || raw === '' ? 'auto' : raw;
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw fail('bad_input', 'mode must be auto, multi-speaker, or line-by-line');
  }
  const used = speakersUsed.size;
  if (mode === 'multi-speaker' && used > 2) {
    throw fail('bad_input', 'multi-speaker mode supports at most 2 speakers used');
  }
  if (mode === 'auto') {
    if (used === 2) return 'multi-speaker';
    return 'line-by-line';
  }
  if (mode === 'multi-speaker' && used === 1) return 'line-by-line';
  return mode;
}

export function buildPodcastSegments(parsed, speakers, mode) {
  const segments = [];
  const pushSpeech = (seg) => {
    if (segments.length && segments[segments.length - 1].kind === 'speech') {
      segments.push({ kind: 'pause', ms: TURN_GAP_MS });
    }
    segments.push(seg);
  };
  if (mode === 'line-by-line') {
    for (const turn of parsed.turns) {
      const voice = speakers[turn.speaker - 1].voice;
      for (const text of splitOversized(turn.text, SEGMENT_CHARS)) {
        pushSpeech({ kind: 'speech', text, voice, speaker: turn.speaker });
      }
    }
    return segments;
  }
  const used = [...parsed.speakersUsed].sort((a, b) => a - b);
  const speakerVoiceConfigs = used.map((n, i) => ({
    speaker: `Speaker${i + 1}`,
    voiceConfig: { prebuiltVoiceConfig: { voiceName: speakers[n - 1].voice } },
  }));
  const aliasOf = new Map(used.map((n, i) => [n, `Speaker${i + 1}`]));
  for (const block of groupMultiBlocks(parsed.turns, MULTI_BLOCK_CHARS)) {
    pushSpeech({
      kind: 'speech',
      multi: true,
      turns: block.map((t) => ({ alias: aliasOf.get(t.speaker), text: t.text })),
      speakerVoiceConfigs,
    });
  }
  return segments;
}

export function validatePodcastAudioInput(raw) {
  assertInputObject(raw);
  const speakers = resolveSpeakers(raw.speakers);
  const { script, parsed } = parseRequiredScript(raw.script, speakers);
  const mode = resolveMode(raw.mode, parsed.speakersUsed);
  const format = resolveFormat(raw.format);
  const model = resolveModel(raw.model);
  const segments = buildPodcastSegments(parsed, speakers, mode);
  const speechCount = segments.filter((s) => s.kind === 'speech').length;
  if (speechCount > MAX_SEGMENTS) {
    throw fail(
      'bad_input',
      `script needs ${speechCount} Gemini requests (max ${MAX_SEGMENTS}); split into parts or use multi-speaker mode with 2 speakers`,
    );
  }
  if (speechCount === 0) throw fail('bad_input', 'script produced no speech segments');
  const filename =
    raw.filename === undefined || raw.filename === ''
      ? defaultPodcastFilename(parsed.title, format)
      : sanitizeFilename(raw.filename, format);
  return {
    script,
    parsed,
    speakers,
    mode,
    model,
    format,
    filename,
    segments,
    speechCount,
    title: parsed.title,
    speakersUsed: [...parsed.speakersUsed].sort((a, b) => a - b),
  };
}

function shardFor(caller) {
  if (caller?.kind === 'operator') return 'operator';
  if (typeof caller?.conversationId === 'string' && caller.conversationId) return caller.conversationId;
  throw fail('bad_input', 'agent caller has no conversation id');
}

function probeFfmpeg() {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      out += d;
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(t);
      resolve(/\blibmp3lame\b/.test(out));
    });
  });
}

export async function assertMp3Available() {
  if (ffmpegProbe === true) return;
  if (ffmpegProbe === false) {
    throw fail('bad_input', 'mp3 requires ffmpeg with libmp3lame on PATH; WAV is available');
  }
  ffmpegProbe = await probeFfmpeg();
  if (!ffmpegProbe) {
    throw fail('bad_input', 'mp3 requires ffmpeg with libmp3lame on PATH; WAV is available');
  }
}

export function wavToMp3(wavBuf) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'wav',
        '-i',
        'pipe:0',
        '-codec:a',
        'libmp3lame',
        '-q:a',
        '4',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks = [];
    const t = setTimeout(() => {
      child.kill();
      reject(fail('timeout', 'ffmpeg mp3 encode timed out after 30s'));
    }, config.mp3TimeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', (e) => {
      clearTimeout(t);
      if (e?.code === 'ENOENT') {
        reject(fail('bad_input', 'mp3 requires ffmpeg with libmp3lame on PATH; WAV is available'));
      } else reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(fail('upstream_error', 'ffmpeg mp3 encode failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(wavBuf);
  });
}

async function mapPool(items, limit, fn, onError) {
  const results = new Array(items.length);
  let next = 0;
  let firstErr;
  async function worker() {
    while (!firstErr) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (!firstErr) {
          firstErr = e;
          onError?.(e);
        }
      }
    }
  }
  const n = Math.min(limit, items.length) || 0;
  await Promise.all(Array.from({ length: n }, () => worker()));
  if (firstErr) throw firstErr;
  return results;
}

function assemble(segments, speechResults) {
  let rate = speechResults[0]?.sampleRate;
  if (!rate) throw fail('upstream_error', 'gemini: no audio in response');
  const parts = [];
  let si = 0;
  for (const seg of segments) {
    if (seg.kind === 'pause') {
      parts.push(silence(seg.ms, rate));
      continue;
    }
    const got = speechResults[si++];
    if (got.sampleRate !== rate) throw fail('upstream_error', 'gemini: mixed sample rates');
    const copy = new Int16Array(got.pcm);
    applyMicroRamp(copy, 15, rate);
    parts.push(copy);
  }
  return { pcm: concatPcm(parts), sampleRate: rate };
}

async function encodeAndWrite({ dir, filename, format, pcm, sampleRate, speechCount, cap, ctx, shard }) {
  const wav = pcmToWav(pcm, sampleRate);
  let buf = wav;
  let mime = 'audio/wav';
  if (format === 'mp3') {
    buf = await wavToMp3(wav);
    mime = 'audio/mpeg';
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  try {
    writeFileSync(path, buf, { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') throw fail('bad_input', `filename already exists: ${filename}`);
    throw err;
  }
  const durationSec = pcm.length / sampleRate;
  ctx.log.info(
    `${cap} wrote ${buf.length} bytes, ${durationSec} s, ${speechCount} segments to ${shard}/${filename}`,
  );
  return { path, mime, bytes: buf.length, durationSec, sampleRate, requests: speechCount };
}

async function generateScript(ctx, input) {
  const v = validateScriptInput(input);
  const key = ctx.credentials.get('GEMINI_API_KEY');
  if (!key) throw fail('credential_missing', 'Gemini key not configured — set GEMINI_API_KEY in Settings → Plugins');
  const prompt = buildPrompt({ ...v, voiceTraits: VOICE_TRAITS, model: undefined });
  const deadlineAt = Date.now() + config.budgetMs;
  const raw = await generateText(ctx, key, { prompt, model: v.model, deadlineAt });
  const script = cleanModelOutput(raw);
  const parsed = parseScript(script);
  if (parsed.turns.length === 0) {
    throw fail('upstream_error', 'gemini: model returned no Speaker lines');
  }
  for (const t of parsed.turns) {
    if (t.speaker > v.speakers.length) {
      throw fail(
        'upstream_error',
        `gemini: script uses Speaker ${t.speaker} but only ${v.speakers.length} speakers configured`,
      );
    }
  }
  const { wordCount, estSeconds } = estimateSeconds(script);
  return {
    script,
    title: parsed.title,
    turns: parsed.turns.length,
    speakersUsed: [...parsed.speakersUsed].sort((a, b) => a - b),
    wordCount,
    estSeconds,
    language: v.action === 'translate' ? v.targetLanguage : v.language,
    model: v.model.key,
  };
}

async function generatePodcastAudio(ctx, input, caller) {
  const v = validatePodcastAudioInput(input);
  const shard = shardFor(caller);
  const dir = join(resolveArtifactsDir(), shard);
  if (v.format === 'mp3') await assertMp3Available();
  const key = ctx.credentials.get('GEMINI_API_KEY');
  if (!key) throw fail('credential_missing', 'Gemini key not configured — set GEMINI_API_KEY in Settings → Plugins');
  const dest = join(dir, v.filename);
  if (existsSync(dest)) throw fail('bad_input', `filename already exists: ${v.filename}`);

  const deadlineAt = Date.now() + config.budgetMs;
  const deadline = AbortSignal.timeout(config.budgetMs);
  const failCtrl = new AbortController();
  const combined = AbortSignal.any([deadline, failCtrl.signal]);
  const speech = v.segments.filter((s) => s.kind === 'speech');
  let done = 0;

  let speechResults;
  try {
    speechResults = await mapPool(
      speech,
      config.concurrency,
      async (seg) => {
        const out = seg.multi
          ? await synthesizeMulti(ctx, key, {
              turns: seg.turns,
              speakerVoiceConfigs: seg.speakerVoiceConfigs,
              model: v.model,
              signal: combined,
              deadlineAt,
            })
          : await synthesize(ctx, key, {
              text: seg.text,
              voice: seg.voice,
              model: v.model,
              signal: combined,
              deadlineAt,
            });
        done += 1;
        return out;
      },
      () => failCtrl.abort(),
    );
  } catch (err) {
    if (deadline.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'timeout') {
      throw fail(
        'timeout',
        `podcast exceeded ${config.budgetMs / 1000}s after ${done}/${speech.length} segments; split into parts`,
      );
    }
    throw err;
  }

  const { pcm, sampleRate } = assemble(v.segments, speechResults);
  const written = await encodeAndWrite({
    dir,
    filename: v.filename,
    format: v.format,
    pcm,
    sampleRate,
    speechCount: v.speechCount,
    cap: 'podcast.audio.generate',
    ctx,
    shard,
  });
  return {
    ...written,
    mode: v.mode,
    title: v.title,
    speakersUsed: v.speakersUsed,
  };
}

export default {
  activate(ctx) {
    ctx.capability('podcast.script.generate', (input) => generateScript(ctx, input));
    ctx.capability('podcast.audio.generate', (input, caller) => generatePodcastAudio(ctx, input, caller));
  },
};
