import { describe, it, expect } from 'vitest';
import { CODEX_DEVICE_URL, parseCodexDeviceAuth } from './codexDeviceAuth.js';

describe('parseCodexDeviceAuth', () => {
  it('extracts url and user code from a combined blob', () => {
    const text = `Visit https://auth.openai.com/codex/device and enter TAEF-M7I6R`;
    expect(parseCodexDeviceAuth(text)).toEqual({
      url: CODEX_DEVICE_URL,
      userCode: 'TAEF-M7I6R',
    });
  });

  it('extracts url from one stderr line and code from the next', () => {
    const text = `https://auth.openai.com/codex/device\nTAEF-M7I6R\n`;
    expect(parseCodexDeviceAuth(text)).toEqual({
      url: CODEX_DEVICE_URL,
      userCode: 'TAEF-M7I6R',
    });
  });

  it('strips query from url and ignores a code inside the query', () => {
    const text = `https://auth.openai.com/codex/device?user_code=FOO-BAR\nTAEF-M7I6R\n`;
    expect(parseCodexDeviceAuth(text)).toEqual({
      url: CODEX_DEVICE_URL,
      userCode: 'TAEF-M7I6R',
    });
  });

  it('returns null when the url is present but no standalone code', () => {
    expect(parseCodexDeviceAuth('https://auth.openai.com/codex/device')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCodexDeviceAuth('')).toBeNull();
  });

  it('matches real Codex ANSI-coloured device-auth output', () => {
    // Codex wraps URL and code in \x1b[94m…\x1b[0m even when piped (non-TTY).
    const blob = [
      '1. Open this link in your browser and sign in to your account',
      `   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m`,
      '',
      '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m',
      `   \x1b[94mTAEF-M7I6R\x1b[0m`,
    ].join('\n');
    expect(parseCodexDeviceAuth(blob)).toEqual({
      url: CODEX_DEVICE_URL,
      userCode: 'TAEF-M7I6R',
    });
  });
});
