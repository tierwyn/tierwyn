// Pure PCM / WAV / script helpers. No I/O, no network.
// ponytail: assumes LE host — Gemini PCM is little-endian; every Tierwyn target is LE.

export const SEGMENT_CHARS = 1800;
export const TITLE_PAUSE_MS = 1500;
export const TURN_GAP_MS = 250;
export const DEFAULT_RATE = 24000;

function copyI16(u8, start, byteLen) {
  const aligned = byteLen - (byteLen % 2);
  const out = new Int16Array(aligned / 2);
  new Uint8Array(out.buffer).set(u8.subarray(start, start + aligned));
  return out;
}

function u32le(u8, off) {
  return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0;
}

function isRiffWave(u8) {
  return (
    u8.length >= 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x41 &&
    u8[10] === 0x56 &&
    u8[11] === 0x45
  );
}

function walkChunks(u8, onChunk) {
  let offset = 12;
  while (offset + 8 <= u8.length) {
    const id = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
    const chunkSize = u32le(u8, offset + 4);
    offset += 8;
    const stop = onChunk(id, offset, chunkSize);
    if (stop) return;
    if (chunkSize <= 0) break;
    offset += chunkSize + (chunkSize % 2);
  }
}

/** Always copies into a fresh Int16Array so odd Buffer byteOffset cannot throw. */
export function extractPcm(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isRiffWave(u8)) {
    let found;
    walkChunks(u8, (id, offset, chunkSize) => {
      if (id !== 'data') return false;
      const actualSize = Math.min(chunkSize, u8.length - offset);
      found = copyI16(u8, offset, actualSize);
      return true;
    });
    if (found) return found;
    if (u8.length > 44) return copyI16(u8, 44, u8.length - 44);
  }
  return copyI16(u8, 0, u8.length);
}

export function parsePcmRate(mimeType) {
  if (typeof mimeType !== 'string') return DEFAULT_RATE;
  const m = mimeType.match(/rate=(\d+)/i);
  return m ? Number(m[1]) : DEFAULT_RATE;
}

/** Sample rate from a WAV fmt chunk, or null if the buffer is not a WAV. */
export function parseWavSampleRate(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isRiffWave(u8)) return null;
  let rate = null;
  walkChunks(u8, (id, offset, chunkSize) => {
    if (id !== 'fmt ' || chunkSize < 8 || offset + 8 > u8.length) return false;
    rate = u32le(u8, offset + 4);
    return true;
  });
  return rate;
}

export function applyMicroRamp(pcm, rampMs = 15, sampleRate = DEFAULT_RATE) {
  if (!pcm || pcm.length === 0) return pcm;
  const rampSamples = Math.min(Math.floor((rampMs / 1000) * sampleRate), Math.floor(pcm.length / 2));
  if (rampSamples <= 0) return pcm;
  for (let i = 0; i < rampSamples; i++) {
    pcm[i] = Math.round(pcm[i] * (i / rampSamples));
  }
  for (let i = 0; i < rampSamples; i++) {
    const idx = pcm.length - 1 - i;
    pcm[idx] = Math.round(pcm[idx] * (i / rampSamples));
  }
  return pcm;
}

export function silence(ms, rate = DEFAULT_RATE) {
  return new Int16Array(Math.round((ms * rate) / 1000));
}

export function concatPcm(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function pcmToWav(pcm, sampleRate) {
  const n = pcm.byteLength;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

export function escapeRegex(string) {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** Port of the app's parseScriptLine. characterVoiceMap keys are lowercase. */
export function parseScriptLine(line, characterVoiceMap, characterRegex) {
  const result = {
    expression: null,
    textToSpeak: line.trim(),
    characterName: null,
  };

  if (characterRegex) {
    const dialogueMatch = line.match(characterRegex);
    if (dialogueMatch) {
      const charName = dialogueMatch[1].toLowerCase();
      if (characterVoiceMap.has(charName)) {
        result.characterName = charName;
        let dialogueText = dialogueMatch[2].trim();
        const expressionInDialogueMatch = dialogueText.match(/^\((.*?)\)\s*/);
        if (expressionInDialogueMatch) {
          result.expression = expressionInDialogueMatch[1];
          result.textToSpeak = dialogueText.replace(expressionInDialogueMatch[0], '').trim();
        } else {
          result.textToSpeak = dialogueText;
        }
        return result;
      }
    }
  }

  const expressionInNarrationMatch = line.match(/^\((.*?)\)\s*/);
  if (expressionInNarrationMatch) {
    result.expression = expressionInNarrationMatch[1];
    result.textToSpeak = line.replace(expressionInNarrationMatch[0], '').trim();
  }

  return result;
}

function splitOversized(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  const boundary = /[.!?…]\s+/g;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let last = -1;
    boundary.lastIndex = 0;
    let m;
    while ((m = boundary.exec(window))) last = m.index + m[0].length;
    if (last > 0) {
      parts.push(rest.slice(0, last).trimEnd());
      rest = rest.slice(last).trimStart();
    } else {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Ordered list of `{ kind:'speech', text, voice } | { kind:'pause', ms }`.
 * Consecutive cue-less narration with the same voice is merged up to SEGMENT_CHARS.
 */
export function buildSegments({ title, chapterTitle, text, narratorVoice, characters = [] }) {
  const characterVoiceMap = new Map();
  for (const c of characters) characterVoiceMap.set(c.name.toLowerCase(), c.voice);
  const characterRegex =
    characters.length > 0
      ? new RegExp(`^(${characters.map((c) => escapeRegex(c.name)).join('|')})\\s*:\\s*(.*)`, 'is')
      : null;

  const items = [];
  const pushTitle = (value) => {
    const t = typeof value === 'string' ? value.trim() : '';
    if (!t) return;
    items.push({ kind: 'speech', text: t, voice: narratorVoice, mergeable: false });
    items.push({ kind: 'pause', ms: TITLE_PAUSE_MS });
  };
  pushTitle(title);
  pushTitle(chapterTitle);

  const paragraphs = String(text ?? '')
    .split(/\n+/)
    .filter((p) => p.trim() !== '');

  for (const line of paragraphs) {
    const parsed = parseScriptLine(line, characterVoiceMap, characterRegex);
    const voice = parsed.characterName ? characterVoiceMap.get(parsed.characterName) : narratorVoice;
    let speak = parsed.textToSpeak;
    if (parsed.expression) speak = `Say ${parsed.expression}: ${parsed.textToSpeak}`;
    const mergeable = !parsed.characterName && !parsed.expression;
    const chunks = splitOversized(speak, SEGMENT_CHARS);
    for (let i = 0; i < chunks.length; i++) {
      items.push({
        kind: 'speech',
        text: chunks[i],
        voice,
        mergeable: mergeable && chunks.length === 1,
      });
    }
  }

  const merged = [];
  for (const item of items) {
    if (item.kind !== 'speech' || !item.mergeable) {
      merged.push(item);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (
      prev?.kind === 'speech' &&
      prev.mergeable &&
      prev.voice === item.voice &&
      prev.text.length + 2 + item.text.length <= SEGMENT_CHARS
    ) {
      prev.text += `\n\n${item.text}`;
    } else {
      merged.push({ ...item });
    }
  }

  const out = [];
  for (const cur of merged) {
    if (cur.kind === 'speech') {
      if (out.length && out[out.length - 1].kind === 'speech') {
        out.push({ kind: 'pause', ms: TURN_GAP_MS });
      }
      out.push({ kind: 'speech', text: cur.text, voice: cur.voice });
    } else {
      out.push({ kind: 'pause', ms: cur.ms });
    }
  }
  return out;
}
