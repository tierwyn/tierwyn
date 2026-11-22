import { stripVTControlCharacters } from 'node:util';

export const CLAUDE_LOGIN_ARGV = ['auth', 'login', '--claudeai'];
export const CLAUDE_LOGIN_WAIT_MS = 15 * 60_000;
export const CLAUDE_URL_PARSE_MS = 30_000;

const URL_RE = /https:\/\/\S+\/oauth\/authorize\?\S+(?=\s)/;
const PASTE_CODE_RE = /^[\x21\x22\x24-\x7e]+#[\x21\x22\x24-\x7e]+$/;
const AUTH_HOSTS = new Set(['claude.com', 'claude.ai']);
const AUTH_PATHS = new Set(['/cai/oauth/authorize', '/oauth/authorize']);
const REDIRECT_HOSTS = new Set(['platform.claude.com', 'console.anthropic.com']);

function capError(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed;
}

export function isClaudeAuthUrl(url: string): boolean {
  if (url.length > 4096) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.port) return false;
  if (!AUTH_HOSTS.has(parsed.hostname)) return false;
  if (!AUTH_PATHS.has(parsed.pathname)) return false;
  // Claude Code >= 2.1.x prints a short opaque-token URL:
  // https://claude.ai/oauth/authorize?<base64url-token>
  if (/^\?[A-Za-z0-9_-]{16,256}$/.test(parsed.search)) return true;
  if (parsed.searchParams.get('code') !== 'true') return false;
  if (parsed.searchParams.get('response_type') !== 'code') return false;
  if (!parsed.searchParams.get('code_challenge') || !parsed.searchParams.get('state')) return false;
  // A repeated param could smuggle a second redirect past this check.
  const redirects = parsed.searchParams.getAll('redirect_uri');
  if (redirects.length !== 1) return false;
  const redirect = redirects[0]!;
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    return false;
  }
  if (redirectUrl.username || redirectUrl.password || redirectUrl.port) return false;
  return redirectUrl.protocol === 'https:' && REDIRECT_HOSTS.has(redirectUrl.hostname);
}

export function parseClaudeAuthUrl(text: string): string | null {
  const clean = stripVTControlCharacters(text);
  const match = clean.match(URL_RE);
  if (!match) return null;
  return isClaudeAuthUrl(match[0]) ? match[0] : null;
}

export function isClaudePasteCode(code: string): boolean {
  return code.length <= 2048 && PASTE_CODE_RE.test(code);
}

export function claudeLoginError(buf: string): string {
  const clean = stripVTControlCharacters(buf);
  const failures = [...clean.matchAll(/Login failed:[^\n]*/g)];
  if (failures.length > 0) return capError(failures[failures.length - 1]![0]);
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!/https:\/\/|Paste code here|Opening browser/.test(line)) return capError(line);
  }
  return 'claude login failed';
}
