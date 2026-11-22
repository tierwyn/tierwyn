import { stripVTControlCharacters } from 'node:util';

const URL_CAP = 4096;
const ERROR_CAP = 300;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
/** Separate global constant: `g` would make DEVICE_CODE_RE stateful under .test. */
const DEVICE_CODE_RE_G = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;
export const DEVICE_USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const COPILOT_URL = 'https://github.com/login/device';
const COPILOT_URL_RE = /https:\/\/github\.com\/login\/device(?=[\s]|$)/;
const GROK_URL_RE = /https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})/;

export interface LoginUrlRule {
  hosts: readonly string[];
  pathname: string;
  /** Required keys. Each value list comes from getAll. Missing keys fail. */
  query?: Record<string, (values: string[]) => boolean>;
  /** Keys that may be absent, but are validated like `query` when present. Unknown keys still fail. */
  optionalQuery?: Record<string, (values: string[]) => boolean>;
  /** Reject any query string. Bare `?` is also rejected via the raw-vs-canonical check. */
  noQuery?: boolean;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CURSOR_CHALLENGE_LEN = 43;
const CURSOR_URL_RE = /https:\/\/cursor\.com\/loginDeepControl\?\S+(?=\s)/;
const only = (want: string) => (values: string[]) => values.length === 1 && values[0] === want;

export const LOGIN_URL_RULES: Record<string, LoginUrlRule> = {
  copilot: { hosts: ['github.com'], pathname: '/login/device', noQuery: true },
  'grok-build': {
    hosts: ['accounts.x.ai'],
    pathname: '/oauth2/device',
    query: {
      user_code: (values) => values.length === 1 && DEVICE_USER_CODE_RE.test(values[0]!),
    },
  },
  cursor: {
    hosts: ['cursor.com'],
    pathname: '/loginDeepControl',
    query: {
      challenge: (values) => values.length === 1 && values[0]!.length === CURSOR_CHALLENGE_LEN && B64URL_RE.test(values[0]!),
      uuid: (values) => values.length === 1 && UUID_RE.test(values[0]!),
    },
    // Values pinned to the S0 capture: a node-chosen redirectTarget must not pass the hub.
    optionalQuery: {
      mode: only('login'),
      redirectTarget: only('cli'),
      supportsSelectedTeamLogin: only('true'),
    },
  },
};

export function isHttpsLoginUrl(url: string, rule: LoginUrlRule): boolean {
  if (typeof url !== 'string' || url.length < 1 || url.length > URL_CAP) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.port) return false;
  if (parsed.hash !== '') return false;
  if (!rule.hosts.includes(parsed.hostname)) return false;
  if (parsed.pathname !== rule.pathname) return false;
  // Drop non-canonical raw forms (bare `?`, `#`, backslash, tab, fullwidth, :443, …).
  if (url !== parsed.origin + parsed.pathname + parsed.search) return false;
  if (url.includes('%') || url.includes('&&') || url.endsWith('&')) return false;
  if (rule.noQuery && parsed.search !== '') return false;
  if (rule.query) {
    const checks = { ...rule.query, ...rule.optionalQuery };
    const keys = [...new Set(parsed.searchParams.keys())];
    if (!Object.keys(rule.query).every((k) => keys.includes(k))) return false;
    for (const k of keys) {
      if (!Object.hasOwn(checks, k) || !checks[k]!(parsed.searchParams.getAll(k))) return false;
    }
  }
  return true;
}

export function isAgentLoginUrl(agentType: string, url: string): boolean {
  const rule = LOGIN_URL_RULES[agentType];
  return Boolean(rule) && isHttpsLoginUrl(url, rule);
}

export function isDeviceUserCode(code: string): boolean {
  return typeof code === 'string' && DEVICE_USER_CODE_RE.test(code);
}

function redactLoginSecrets(line: string): string {
  return line
    .replace(/https:\/\/\S+/gi, '[url]')
    .replace(/\bcursor\.com\/\S+/gi, '[url]')
    .replace(UUID_RE_G, '[uuid]')
    .replace(DEVICE_CODE_RE_G, '[code]');
}

/** Matched against the REDACTED line; end-anchored so real errors are never skipped. */
function isProgressOnlyLoginLine(line: string): boolean {
  return /^waiting for (?:authorization|browser authentication)(?: to complete)?[.…]*$/i.test(line)
    || /^only continue with a code you requested\. don['’]t share it with anyone\.?$/i.test(line)
    || /^to authenticate, visit \[url\] and enter code \[code\]$/i.test(line)
    || /^confirm this code in your browser:?$/i.test(line)
    || /^open a browser and navigate to this link: \[url\]$/i.test(line)
    || /^starting login process[.…]*$/i.test(line)
    || /^authenticating with cursor[.…]*$/i.test(line);
}

/** Last non-secret line of login stdio. Redacts URLs and XXXX-XXXX codes in-place. */
export function deviceLoginError(buf: string): string {
  const lines = stripVTControlCharacters(buf).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const redacted = redactLoginSecrets(lines[i]!);
    if (!redacted || isProgressOnlyLoginLine(redacted)) continue;
    if (!redacted.replace(/\[url\]/g, '').replace(/\[code\]/g, '').trim()) continue;
    return redacted.length > ERROR_CAP ? redacted.slice(0, ERROR_CAP) : redacted;
  }
  return 'login failed';
}

export function copilotLoginAbort(buf: string): string | null {
  const clean = stripVTControlCharacters(buf);
  if (/github\.com\/login\/oauth\/authorize/.test(clean)) {
    return 'copilot started a browser login — expected --device-code';
  }
  return null;
}

export function parseCopilotDevice(buf: string): { url: string; userCode: string } | null {
  const clean = stripVTControlCharacters(buf);
  if (copilotLoginAbort(clean)) return null;
  if (!COPILOT_URL_RE.test(clean)) return null;
  const code = clean.match(DEVICE_CODE_RE);
  if (!code) return null;
  return { url: COPILOT_URL, userCode: code[0] };
}

export function parseGrokDevice(buf: string): { url: string; userCode: string } | null {
  const clean = stripVTControlCharacters(buf);
  const m = GROK_URL_RE.exec(clean);
  if (!m) return null;
  const userCode = m[1]!;
  const url = m[0];
  if (!isAgentLoginUrl('grok-build', url)) return null;
  return { url, userCode };
}

export function parseCursorLogin(buf: string): { url: string } | null {
  const clean = stripVTControlCharacters(buf);
  const m = clean.match(CURSOR_URL_RE);
  if (!m) return null;
  const url = m[0];
  if (!isAgentLoginUrl('cursor', url)) return null;
  return { url };
}

/** Hub-side check for a URL-only login event (Cursor). A userCode is always rejected. */
export function isAcceptedUrlLoginEvent(agentType: string, url: unknown, userCode: unknown): boolean {
  if (userCode !== undefined) return false;
  if (typeof url !== 'string') return false;
  return isAgentLoginUrl(agentType, url);
}

/** Hub-side check for a generic device event (not Codex, which stays exact-URL). */
export function isAcceptedDeviceEvent(agentType: string, url: unknown, userCode: unknown): boolean {
  if (typeof url !== 'string' || typeof userCode !== 'string') return false;
  if (!isDeviceUserCode(userCode) || !isAgentLoginUrl(agentType, url)) return false;
  const rule = LOGIN_URL_RULES[agentType];
  if (rule?.query?.user_code) {
    try {
      return new URL(url).searchParams.get('user_code') === userCode;
    } catch {
      return false;
    }
  }
  return Boolean(rule?.noQuery);
}
