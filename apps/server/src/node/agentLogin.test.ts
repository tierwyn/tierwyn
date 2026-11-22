import { describe, expect, it } from 'vitest';
import {
  copilotLoginAbort,
  deviceLoginError,
  isAcceptedDeviceEvent,
  isAcceptedUrlLoginEvent,
  isAgentLoginUrl,
  isDeviceUserCode,
  isHttpsLoginUrl,
  parseCopilotDevice,
  parseCursorLogin,
  parseGrokDevice,
  type LoginUrlRule,
} from './agentLogin.js';

const RULE: LoginUrlRule = {
  hosts: ['example.test'],
  pathname: '/login/device',
};

const CURSOR_CHALLENGE = 'A'.repeat(43);
const CURSOR_UUID = '00000000-0000-4000-8000-000000000000';
const CURSOR_QS = `challenge=${CURSOR_CHALLENGE}&uuid=${CURSOR_UUID}`;
const CURSOR_EXTRAS = '&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true';
const CURSOR_BARE = `https://cursor.com/loginDeepControl?${CURSOR_QS}`;
const CURSOR_FULL = `${CURSOR_BARE}${CURSOR_EXTRAS}`;

describe('isHttpsLoginUrl', () => {
  it('accepts https, exact host, exact path, no userinfo, no port', () => {
    expect(isHttpsLoginUrl('https://example.test/login/device', RULE)).toBe(true);
  });

  it('rejects userinfo, a port, http, and a wrong host', () => {
    expect(isHttpsLoginUrl('https://user:pass@example.test/login/device', RULE)).toBe(false);
    expect(isHttpsLoginUrl('https://example.test:8443/login/device', RULE)).toBe(false);
    expect(isHttpsLoginUrl('http://example.test/login/device', RULE)).toBe(false);
    expect(isHttpsLoginUrl('https://evil.test/login/device', RULE)).toBe(false);
  });

  it('rejects a duplicate query param when the rule requires a single value', () => {
    const withQuery: LoginUrlRule = {
      ...RULE,
      query: { user_code: (values) => values.length === 1 && values[0] === 'XXXX-XXXX' },
    };
    expect(isHttpsLoginUrl('https://example.test/login/device?user_code=XXXX-XXXX', withQuery)).toBe(true);
    expect(isHttpsLoginUrl(
      'https://example.test/login/device?user_code=XXXX-XXXX&user_code=EVIL-CODE',
      withQuery,
    )).toBe(false);
  });

  it('rejects an oversize URL', () => {
    expect(isHttpsLoginUrl(`https://example.test/login/device?q=${'x'.repeat(5000)}`, RULE)).toBe(false);
  });

  it('noQuery rejects any search string, including a bare ?', () => {
    const noQuery = { ...RULE, noQuery: true };
    expect(isHttpsLoginUrl('https://example.test/login/device', noQuery)).toBe(true);
    expect(isHttpsLoginUrl('https://example.test/login/device?x=1', noQuery)).toBe(false);
    expect(isHttpsLoginUrl('https://example.test/login/device?', noQuery)).toBe(false);
  });

  it('rejects a fragment, an extra query key, and non-canonical host forms', () => {
    const withQuery: LoginUrlRule = {
      ...RULE,
      query: { user_code: (values) => values.length === 1 && values[0] === 'XXXX-XXXX' },
    };
    const ok = 'https://example.test/login/device?user_code=XXXX-XXXX';
    expect(isHttpsLoginUrl(ok, withQuery)).toBe(true);
    expect(isHttpsLoginUrl(`${ok}&redirect_uri=https://evil.example`, withQuery)).toBe(false);
    expect(isHttpsLoginUrl(`${ok}#frag`, withQuery)).toBe(false);
    expect(isHttpsLoginUrl('https://example.test/login/device\\x?user_code=XXXX-XXXX', withQuery)).toBe(false);
    expect(isHttpsLoginUrl('https://example.test\t/login/device?user_code=XXXX-XXXX', withQuery)).toBe(false);
    expect(isHttpsLoginUrl('https://example.ｔest/login/device?user_code=XXXX-XXXX', withQuery)).toBe(false);
  });

  it('optionalQuery allows listed extras and still rejects unknown keys and duplicates', () => {
    const withOptional: LoginUrlRule = {
      ...RULE,
      query: { challenge: (values) => values.length === 1 && values[0] === 'aaa' },
      optionalQuery: {
        mode: (values) => values.length === 1 && values[0] === 'login',
        redirectTarget: (values) => values.length === 1 && values[0] === 'cli',
      },
    };
    const base = 'https://example.test/login/device?challenge=aaa';
    expect(isHttpsLoginUrl(base, withOptional)).toBe(true);
    expect(isHttpsLoginUrl(`${base}&mode=login`, withOptional)).toBe(true);
    expect(isHttpsLoginUrl(`${base}&mode=login&redirectTarget=cli`, withOptional)).toBe(true);
    expect(isHttpsLoginUrl(`${base}&evil=1`, withOptional)).toBe(false);
    expect(isHttpsLoginUrl(`${base}&mode=login&mode=other`, withOptional)).toBe(false);
    expect(isHttpsLoginUrl('https://example.test/login/device', withOptional)).toBe(false);
  });
});

describe('deviceLoginError', () => {
  it('drops https lines and code-shaped strings, never the last URL line', () => {
    const buf = [
      'Waiting for authorization...',
      'Please visit https://example.test/login/device and enter the code XXXX-XXXX',
      'https://example.test/login/device?user_code=XXXX-XXXX',
    ].join('\n');
    const err = deviceLoginError(buf);
    expect(err).not.toMatch(/https:\/\//);
    expect(err).not.toContain('XXXX-XXXX');
    expect(err.length).toBeGreaterThan(0);
    expect(err.length).toBeLessThanOrEqual(300);
  });

  it('redacts a URL inside a genuine error instead of returning the progress line', () => {
    const buf = [
      'Waiting for authorization...',
      'Error: request to https://github.com/login/oauth/access_token failed: ECONNREFUSED',
    ].join('\n');
    const err = deviceLoginError(buf);
    expect(err).toContain('ECONNREFUSED');
    expect(err).toContain('[url]');
    expect(err).not.toMatch(/https:\/\//);
    expect(err).not.toMatch(/Waiting for authorization/i);
  });

  it('redacts every code occurrence, not just the first', () => {
    const err = deviceLoginError('Error: code WDJB-MJHT expired (WDJB-MJHT)');
    expect(err).not.toContain('WDJB-MJHT');
    expect(err).toBe('Error: code [code] expired ([code])');
  });

  it('returns a real failure that merely starts with the progress wording', () => {
    const err = deviceLoginError('Waiting for authorization failed: 403 Forbidden');
    expect(err).toContain('403 Forbidden');
  });

  it('never returns instruction lines as the error on silent exit', () => {
    const buf = [
      'To authenticate, visit https://github.com/login/device and enter code WDJB-MJHT',
      'Confirm this code in your browser:',
    ].join('\n');
    expect(deviceLoginError(buf)).toBe('login failed');
  });

  it('does not echo a Cursor last-line URL', () => {
    const buf = [
      'Starting login process...',
      'Authenticating with Cursor...',
      'Waiting for browser authentication...',
      `Open a browser and navigate to this link: ${CURSOR_FULL}`,
    ].join('\n');
    const err = deviceLoginError(buf);
    expect(err).toBe('login failed');
    expect(err).not.toMatch(/https:\/\//);
    expect(err).not.toContain(CURSOR_CHALLENGE);
    expect(err).not.toContain(CURSOR_UUID);
    expect(err).not.toContain('cursor.com');
  });

  it('redacts a schemeless cursor URL and a bare UUID', () => {
    const err = deviceLoginError(`failed cursor.com/loginDeepControl?challenge=${CURSOR_CHALLENGE}&uuid=${CURSOR_UUID} id ${CURSOR_UUID}`);
    expect(err).not.toContain(CURSOR_CHALLENGE);
    expect(err).not.toContain(CURSOR_UUID);
    expect(err).not.toContain('cursor.com');
    expect(err).toContain('[url]');
    expect(err).toContain('[uuid]');
  });
});

const CODE = 'XXXX-XXXX';
const COPILOT_URL = 'https://github.com/login/device';
const GROK_URL = `https://accounts.x.ai/oauth2/device?user_code=${CODE}`;

describe('Copilot device parser (S0 shape)', () => {
  it('reads code and URL from a merged stdout+stderr blob', () => {
    const buf = [
      `To authenticate, visit ${COPILOT_URL} and enter code ${CODE}`,
      'Waiting for authorization...',
      `Failed to copy to clipboard. Please visit ${COPILOT_URL} and enter the code ${CODE} manually.`,
    ].join('\n');
    expect(parseCopilotDevice(buf)).toEqual({ url: COPILOT_URL, userCode: CODE });
  });

  it('rejects the loopback oauth URL as a mis-spawn', () => {
    const buf = 'Opening your browser to authenticate...\nhttps://github.com/login/oauth/authorize?client_id=x&redirect_uri=http://127.0.0.1/callback\n';
    expect(parseCopilotDevice(buf)).toBeNull();
    expect(copilotLoginAbort(buf)).toMatch(/device-code/);
  });
});

describe('Grok device parser (S0 shape)', () => {
  it('reads stderr with CSI and a URL that embeds the code', () => {
    const buf = [
      'To sign in, open this URL in your browser:',
      '',
      `  ${GROK_URL}`,
      '',
      'Confirm this code in your browser:',
      '',
      `  ${CODE}`,
      '\x1b[90mOnly continue with a code you requested. Don\'t share it with anyone.\x1b[0m',
      'Waiting for authorization...',
    ].join('\n');
    expect(parseGrokDevice(buf)).toEqual({ url: GROK_URL, userCode: CODE });
  });
});

describe('device URL allowlists', () => {
  it('accepts Copilot github.com /login/device with no query', () => {
    expect(isAgentLoginUrl('copilot', COPILOT_URL)).toBe(true);
    expect(isAgentLoginUrl('copilot', `${COPILOT_URL}?x=1`)).toBe(false);
    expect(isAgentLoginUrl('copilot', 'https://github.com/login/oauth/authorize')).toBe(false);
  });

  it('accepts Grok accounts.x.ai /oauth2/device with a single user_code', () => {
    expect(isAgentLoginUrl('grok-build', GROK_URL)).toBe(true);
  });

  it('rejects Grok userinfo, port, wrong host, and duplicate user_code', () => {
    expect(isAgentLoginUrl('grok-build', `https://user:pass@accounts.x.ai/oauth2/device?user_code=${CODE}`)).toBe(false);
    expect(isAgentLoginUrl('grok-build', `https://accounts.x.ai:8443/oauth2/device?user_code=${CODE}`)).toBe(false);
    expect(isAgentLoginUrl('grok-build', `https://evil.example/oauth2/device?user_code=${CODE}`)).toBe(false);
    expect(isAgentLoginUrl('grok-build', `${GROK_URL}&user_code=YYYY-YYYY`)).toBe(false);
  });

  it('isDeviceUserCode is XXXX-XXXX only', () => {
    expect(isDeviceUserCode(CODE)).toBe(true);
    expect(isDeviceUserCode('TAEF-M7I6R')).toBe(false);
    expect(isDeviceUserCode('12345678')).toBe(false);
  });
});

describe('isAcceptedDeviceEvent', () => {
  it('accepts Copilot and Grok canonical URLs with a matching code', () => {
    expect(isAcceptedDeviceEvent('copilot', COPILOT_URL, CODE)).toBe(true);
    expect(isAcceptedDeviceEvent('grok-build', GROK_URL, CODE)).toBe(true);
  });

  it('rejects a code that does not match the URL slot', () => {
    expect(isAcceptedDeviceEvent('grok-build', GROK_URL, 'YYYY-YYYY')).toBe(false);
    expect(isAcceptedDeviceEvent('copilot', COPILOT_URL, 'not-a-code')).toBe(false);
  });

  it('rejects a URL in the wrong agent slot', () => {
    expect(isAcceptedDeviceEvent('grok-build', COPILOT_URL, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('copilot', GROK_URL, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('pi', COPILOT_URL, CODE)).toBe(false);
  });

  it('rejects extra keys, duplicates, fragments, and a bare ?', () => {
    expect(isAcceptedDeviceEvent('copilot', `${COPILOT_URL}?`, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('copilot', `${COPILOT_URL}#frag`, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('copilot', `${COPILOT_URL}?next=1`, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('grok-build', `${GROK_URL}&redirect_uri=https://evil.example`, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('grok-build', `${GROK_URL}&user_code=YYYY-YYYY`, CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('grok-build', `${GROK_URL}#frag`, CODE)).toBe(false);
  });

  it('rejects backslash, tab, and fullwidth host forms', () => {
    expect(isAcceptedDeviceEvent('grok-build', 'https://accounts.x.ai/oauth2\\device?user_code=XXXX-XXXX', CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('grok-build', 'https://accounts.x.ai\t/oauth2/device?user_code=XXXX-XXXX', CODE)).toBe(false);
    expect(isAcceptedDeviceEvent('grok-build', 'https://accounts.\uFF58.ai/oauth2/device?user_code=XXXX-XXXX', CODE)).toBe(false);
  });
});

describe('Cursor URL parser (S0 shape)', () => {
  it('extracts the loginDeepControl URL and omits userCode', () => {
    const buf = [
      'Starting login process...',
      'Authenticating with Cursor...',
      'Waiting for browser authentication...',
      `Open a browser and navigate to this link: ${CURSOR_FULL}`,
      '',
    ].join('\n');
    expect(parseCursorLogin(buf)).toEqual({ url: CURSOR_FULL });
    expect(parseCursorLogin(buf)).not.toHaveProperty('userCode');
  });

  it('accepts the URL with and without the three optional extras', () => {
    expect(parseCursorLogin(`link: ${CURSOR_BARE}\n`)).toEqual({ url: CURSOR_BARE });
    expect(parseCursorLogin(`link: ${CURSOR_FULL}\n`)).toEqual({ url: CURSOR_FULL });
  });

  it('does not accept a URL cut off at a chunk boundary', () => {
    expect(parseCursorLogin(`link: ${CURSOR_BARE}`)).toBeNull();
    expect(parseCursorLogin(`link: ${CURSOR_BARE}&mode=login`)).toBeNull();
  });
});

describe('Cursor URL allowlist', () => {
  it('accepts cursor.com /loginDeepControl with required challenge+uuid', () => {
    expect(isAgentLoginUrl('cursor', CURSOR_BARE)).toBe(true);
    expect(isAgentLoginUrl('cursor', CURSOR_FULL)).toBe(true);
  });

  it('rejects userinfo, port, http, wrong host, and wrong path', () => {
    expect(isAgentLoginUrl('cursor', `https://user:pass@cursor.com/loginDeepControl?${CURSOR_QS}`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `https://cursor.com:8443/loginDeepControl?${CURSOR_QS}`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `http://cursor.com/loginDeepControl?${CURSOR_QS}`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `https://evil.example/loginDeepControl?${CURSOR_QS}`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `https://cursor.com/login?${CURSOR_QS}`)).toBe(false);
  });

  it('rejects missing challenge/uuid, duplicate params, and unknown query keys', () => {
    expect(isAgentLoginUrl('cursor', 'https://cursor.com/loginDeepControl?uuid=' + CURSOR_UUID)).toBe(false);
    expect(isAgentLoginUrl('cursor', 'https://cursor.com/loginDeepControl?challenge=' + CURSOR_CHALLENGE)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&uuid=11111111-1111-4111-8111-111111111111`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&evil=1`)).toBe(false);
  });

  it('rejects node-chosen values for the optional params', () => {
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&redirectTarget=https://evil.example/x`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&redirectTarget=https%3A%2F%2Fevil.example`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&redirectTarget=`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&mode=log`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&supportsSelectedTeamLogin=false`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&constructor=x`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&__proto__=x`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `https://cursor.com/loginDeepControl?challenge=A&uuid=${CURSOR_UUID}`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `${CURSOR_BARE}&&mode=login`)).toBe(false);
    expect(isAgentLoginUrl('cursor', `https://cursor.com/loginDeepControl?chal%6cenge=${CURSOR_CHALLENGE}&uuid=${CURSOR_UUID}`)).toBe(false);
  });
});

describe('isAcceptedUrlLoginEvent', () => {
  it('accepts Cursor authorize URLs with no userCode', () => {
    expect(isAcceptedUrlLoginEvent('cursor', CURSOR_FULL, undefined)).toBe(true);
    expect(isAcceptedUrlLoginEvent('cursor', CURSOR_BARE, undefined)).toBe(true);
  });

  it('rejects a Cursor event that includes a userCode', () => {
    expect(isAcceptedUrlLoginEvent('cursor', CURSOR_FULL, 'XXXX-XXXX')).toBe(false);
    expect(isAcceptedDeviceEvent('cursor', CURSOR_FULL, 'XXXX-XXXX')).toBe(false);
  });

  it('rejects an unexpected Cursor URL', () => {
    expect(isAcceptedUrlLoginEvent('cursor', 'https://evil.example/loginDeepControl?challenge=aaa&uuid=' + CURSOR_UUID, undefined)).toBe(false);
  });
});
