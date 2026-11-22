import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  applyMicroRamp,
  buildSegments,
  concatPcm,
  pcmToWav,
  silence,
} from './audio.js';
import { fail, resolveModel, resolveVoice, synthesize } from './gemini.js';

export * from './audio.js';
export {
  MODELS,
  VOICES,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  fail,
  resolveModel,
  resolveVoice,
  synthesize,
  endpointFor,
  buildTtsRequest,
  extractAudio,
  config as geminiConfig,
} from './gemini.js';

export const MAX_SEGMENTS = 48;
export const MAX_AUDIO_CHARS = 5_000;
export const MAX_CHAPTER_CHARS = 30_000;
export const CONCURRENCY = 4;

export const config = {
  chapterBudgetMs: 280_000,
  mp3TimeoutMs: 30_000,
  concurrency: CONCURRENCY,
};

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FORMATS = new Set(['wav', 'mp3']);

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

function resolveFormat(raw) {
  const format = raw === undefined || raw === '' ? 'wav' : raw;
  if (typeof format !== 'string' || !FORMATS.has(format)) {
    throw fail('bad_input', 'format must be wav or mp3');
  }
  return format;
}

function resolveStyle(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') throw fail('bad_input', 'style must be a string');
  if (raw.includes('\n') || raw.includes('\r') || raw.length > 100) {
    throw fail('bad_input', 'style must be ≤100 chars with no newlines');
  }
  return raw;
}

function optionalTitle(raw, field) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') throw fail('bad_input', `${field} must be a string`);
  if (raw.length > 200) throw fail('bad_input', `${field} too long (max 200 chars)`);
  return raw;
}

function resolveCharacters(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw fail('bad_input', 'characters must be an array');
  if (raw.length > 8) throw fail('bad_input', 'characters: max 8');
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') throw fail('bad_input', 'characters entries must be objects');
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) throw fail('bad_input', 'characters[].name is required');
    if (name.length > 40) throw fail('bad_input', 'characters[].name too long (max 40 chars)');
    const key = name.toLowerCase();
    if (seen.has(key)) throw fail('bad_input', `duplicate character name: ${name}`);
    seen.add(key);
    out.push({ name, voice: resolveVoice(c.voice) });
  }
  return out;
}

export function validateAudioInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('bad_input', 'input must be a JSON object');
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) throw fail('bad_input', 'text is required');
  if (text.length > MAX_AUDIO_CHARS) {
    throw fail(
      'bad_input',
      `text too long (max ${MAX_AUDIO_CHARS} chars) — use audiobook.generate.chapter`,
    );
  }
  const format = resolveFormat(raw.format);
  return {
    text,
    voice: resolveVoice(raw.voice),
    model: resolveModel(raw.model),
    format,
    style: resolveStyle(raw.style),
    filename: sanitizeFilename(raw.filename, format),
  };
}

export function validateChapterInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('bad_input', 'input must be a JSON object');
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) throw fail('bad_input', 'text is required');
  if (text.length > MAX_CHAPTER_CHARS) {
    throw fail('bad_input', `text too long (max ${MAX_CHAPTER_CHARS} chars)`);
  }
  const format = resolveFormat(raw.format);
  const narratorVoice = resolveVoice(raw.voice);
  const characters = resolveCharacters(raw.characters);
  const title = optionalTitle(raw.title, 'title');
  const chapterTitle = optionalTitle(raw.chapterTitle, 'chapterTitle');
  const segments = buildSegments({
    title,
    chapterTitle,
    text,
    narratorVoice,
    characters,
  });
  const speechCount = segments.filter((s) => s.kind === 'speech').length;
  if (speechCount > MAX_SEGMENTS) {
    throw fail(
      'bad_input',
      `chapter has ${speechCount} speech segments (max ${MAX_SEGMENTS}); split the chapter`,
    );
  }
  if (speechCount === 0) throw fail('bad_input', 'chapter produced no speech segments');
  return {
    text,
    title,
    chapterTitle,
    voice: narratorVoice,
    model: resolveModel(raw.model),
    format,
    characters,
    filename: sanitizeFilename(raw.filename, format),
    segments,
    speechCount,
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
  return { path, mime, bytes: buf.length, durationSec, sampleRate, segments: speechCount };
}

async function generateAudio(ctx, input, caller) {
  const { text, voice, model, format, style, filename } = validateAudioInput(input);
  const shard = shardFor(caller);
  const dir = join(resolveArtifactsDir(), shard);
  if (format === 'mp3') await assertMp3Available();
  const key = ctx.credentials.get('GEMINI_API_KEY');
  if (!key) throw fail('credential_missing', 'Gemini key not configured — set GEMINI_API_KEY in Settings → Plugins');
  const dest = join(dir, filename);
  if (existsSync(dest)) throw fail('bad_input', `filename already exists: ${filename}`);
  const audio = await synthesize(ctx, key, { text, voice, model, style });
  return encodeAndWrite({
    dir,
    filename,
    format,
    pcm: (() => {
      const copy = new Int16Array(audio.pcm);
      applyMicroRamp(copy, 15, audio.sampleRate);
      return copy;
    })(),
    sampleRate: audio.sampleRate,
    speechCount: 1,
    cap: 'audio.generate',
    ctx,
    shard,
  });
}

async function generateChapter(ctx, input, caller) {
  const { voice, model, format, filename, segments, speechCount } = validateChapterInput(input);
  const shard = shardFor(caller);
  const dir = join(resolveArtifactsDir(), shard);
  if (format === 'mp3') await assertMp3Available();
  const key = ctx.credentials.get('GEMINI_API_KEY');
  if (!key) throw fail('credential_missing', 'Gemini key not configured — set GEMINI_API_KEY in Settings → Plugins');
  const dest = join(dir, filename);
  if (existsSync(dest)) throw fail('bad_input', `filename already exists: ${filename}`);

  const deadlineAt = Date.now() + config.chapterBudgetMs;
  const deadline = AbortSignal.timeout(config.chapterBudgetMs);
  const failCtrl = new AbortController();
  const combined = AbortSignal.any([deadline, failCtrl.signal]);
  const speech = segments.filter((s) => s.kind === 'speech');
  let done = 0;

  let speechResults;
  try {
    speechResults = await mapPool(
      speech,
      config.concurrency,
      async (seg) => {
        const out = await synthesize(ctx, key, {
          text: seg.text,
          voice: seg.voice || voice,
          model,
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
        `chapter exceeded ${config.chapterBudgetMs / 1000}s after ${done}/${speech.length} segments; split the chapter`,
      );
    }
    throw err;
  }

  const { pcm, sampleRate } = assemble(segments, speechResults);
  return encodeAndWrite({
    dir,
    filename,
    format,
    pcm,
    sampleRate,
    speechCount,
    cap: 'audiobook.generate.chapter',
    ctx,
    shard,
  });
}

export default {
  activate(ctx) {
    ctx.capability('audio.generate', (input, caller) => generateAudio(ctx, input, caller));
    ctx.capability('audiobook.generate.chapter', (input, caller) => generateChapter(ctx, input, caller));
  },
};
