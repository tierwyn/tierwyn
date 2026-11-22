import { describe, it, expect } from 'vitest';
import { parseClaudeAuthUrl, isClaudeAuthUrl, isClaudePasteCode, claudeLoginError } from './claudeAuth.js';

const URL_OK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=x'
  + '&code_challenge=abc&code_challenge_method=S256&state=st';

describe('claudeAuth', () => {
  it('parses the URL from real output', () => {
    expect(parseClaudeAuthUrl(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted > `)).toBe(URL_OK);
  });
  it('parses the Claude Code 2.1.x short opaque-token OAuth URL', () => {
    const shortUrl = 'https://claude.ai/oauth/authorize?z-Zr_Uae2Gpa07y24LvlZKibfaw1k2Vmu30BFITofd0i8';
    expect(parseClaudeAuthUrl(`Opening browser to sign in…\nIf the browser didn't open, visit:\n${shortUrl}\nPaste code here if prompted > `)).toBe(shortUrl);
    expect(isClaudeAuthUrl('https://evil.example/oauth/authorize?z-Zr_Uae2Gpa07y24LvlZKibfaw1k2Vmu30BFITofd0i8')).toBe(false);
    expect(isClaudeAuthUrl('https://claude.ai/oauth/authorize?short')).toBe(false);
  });
  it('parses through OSC 8 + colour', () => {
    expect(parseClaudeAuthUrl(`visit: \x1b]8;;${URL_OK}\x07\x1b[94m${URL_OK}\x1b[39m\x1b]8;;\x07\n`)).toBe(URL_OK);
  });
  it('waits for the terminator on a split URL', () => {
    expect(parseClaudeAuthUrl(`visit: ${URL_OK.slice(0, 40)}`)).toBeNull();
    expect(parseClaudeAuthUrl(`visit: ${URL_OK}`)).toBeNull();
  });
  it('rejects an unexpected host, a localhost redirect, http and ports', () => {
    expect(isClaudeAuthUrl(URL_OK.replace('claude.com', 'evil.example'))).toBe(false);
    expect(isClaudeAuthUrl(URL_OK.replace('https://claude.com', 'http://claude.com'))).toBe(false);
    expect(isClaudeAuthUrl(URL_OK.replace('claude.com/', 'claude.com:8443/'))).toBe(false);
    expect(isClaudeAuthUrl(URL_OK.replace(/redirect_uri=[^&]+/, 'redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback'))).toBe(false);
    expect(isClaudeAuthUrl('not a url')).toBe(false);
  });
  it('rejects a redirect_uri that is repeated, carries credentials or names a port', () => {
    const redirect = (u: string) => URL_OK.replace(/redirect_uri=[^&]+/, `redirect_uri=${encodeURIComponent(u)}`);
    expect(isClaudeAuthUrl(`${URL_OK}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`)).toBe(false);
    expect(isClaudeAuthUrl(redirect('https://u:p@platform.claude.com/oauth/code/callback'))).toBe(false);
    expect(isClaudeAuthUrl(redirect('https://platform.claude.com:8443/oauth/code/callback'))).toBe(false);
  });
  it('code shape', () => {
    expect(isClaudePasteCode('abc_-.123#st-4')).toBe(true);
    for (const bad of ['', 'nohash', '#s', 'c#', 'a#b#c', 'a b#c', 'a#b\nc#d', 'a#b\r', `${'x'.repeat(2049)}#s`]) {
      expect(isClaudePasteCode(bad)).toBe(false);
    }
  });
  it('error line: same-line failure after the prompt', () => {
    expect(claudeLoginError(`visit: ${URL_OK}\nPaste code here if prompted > Login failed: That code wasn't accepted.\n`))
      .toBe("Login failed: That code wasn't accepted.");
  });
  it('error line: never returns the URL or the prompt', () => {
    expect(claudeLoginError(`visit: ${URL_OK}\nPaste code here if prompted > `)).toBe('claude login failed');
    expect(claudeLoginError('\x1b[31msome org refusal\x1b[0m\n')).toBe('some org refusal');
  });
  it('error line: a run that dies silently never shows its own banner or a partial URL', () => {
    const banner = `Opening browser to sign in…\nIf the browser didn't open, visit: `;
    expect(claudeLoginError(`${banner}${URL_OK}\nPaste code here if prompted > `)).toBe('claude login failed');
    expect(claudeLoginError(`${banner}${URL_OK.slice(0, 30)}`)).toBe('claude login failed');
  });
});
