import { stripVTControlCharacters } from 'node:util';

export const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';
export const CODEX_LOGIN_WAIT_MS = 15 * 60_000;
export const CODEX_DEVICE_PARSE_MS = 30_000;

const DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device/i;
const USER_CODE_RE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/g;
const ANY_URL_RE = /https?:\/\/[^\s]+/gi;
export const CODEX_USER_CODE_RE = /^[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/;

export function isCodexUserCode(code: string): boolean {
  return CODEX_USER_CODE_RE.test(code);
}

export function parseCodexDeviceAuth(text: string): { url: string; userCode: string } | null {
  if (!text) return null;
  const clean = stripVTControlCharacters(text);
  if (!DEVICE_URL_RE.test(clean)) return null;

  const urlSpans: Array<[number, number]> = [];
  ANY_URL_RE.lastIndex = 0;
  for (let m = ANY_URL_RE.exec(clean); m; m = ANY_URL_RE.exec(clean)) {
    urlSpans.push([m.index, m.index + m[0].length]);
  }

  USER_CODE_RE.lastIndex = 0;
  for (let m = USER_CODE_RE.exec(clean); m; m = USER_CODE_RE.exec(clean)) {
    const idx = m.index;
    const insideUrl = urlSpans.some(([start, end]) => idx >= start && idx < end);
    if (!insideUrl) return { url: CODEX_DEVICE_URL, userCode: m[0] };
  }
  return null;
}
