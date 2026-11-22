import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('vite HTTP_ROUTES', () => {
  const src = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
  const block = src.match(/const HTTP_ROUTES = \[([\s\S]*?)\];/)?.[1] ?? '';

  it('proxies /sessions so GET /sessions/active reaches the API (Active Agents modal)', () => {
    expect(block).toMatch(/['"]\/sessions['"]/);
  });

  it('proxies /system so GET /system/resources reaches the API', () => {
    expect(block).toMatch(/['"]\/system['"]/);
  });

  it('proxies /grok-bot so GET/POST /grok-bot/* reach the API (Settings Grok Bot status)', () => {
    expect(block).toMatch(/['"]\/grok-bot['"]/);
  });

  it('proxies /timers so GET /timers/pending reaches the API (Agent Activity Timed tab)', () => {
    expect(block).toMatch(/['"]\/timers['"]/);
  });

  it('proxies /mcp so GET/POST /mcp/* reach the API (Settings MCP Servers registry)', () => {
    expect(block).toMatch(/['"]\/mcp['"]/);
  });

  it('proxies /rule-presets so GET/POST /rule-presets reach the API (Settings Rule Presets)', () => {
    expect(block).toMatch(/['"]\/rule-presets['"]/);
  });

  it('proxies /remote-hosts so Settings Remote Hosts reaches the API', () => {
    expect(block).toMatch(/['"]\/remote-hosts['"]/);
  });

  it('proxies /node so POST /node/enroll reaches the API (remote node enrollment)', () => {
    expect(block).toMatch(/['"]\/node['"]/);
  });

  it('proxies /node/package.tgz and /node/install.sh via the /node prefix', () => {
    expect(block).toMatch(/['"]\/node['"]/);
  });

  it('proxies /sandbox so POST /sandbox/validate-paths reaches the API', () => {
    expect(block).toMatch(/['"]\/sandbox['"]/);
  });

  it('does not proxy /agent (loopback-only schedule-help)', () => {
    expect(block).not.toMatch(/['"]\/agent['"]/);
  });

  it('warns when TIERWYN_ALLOWED_HOSTS=true disables Host checks', () => {
    expect(src).toContain("console.warn('[vite] TIERWYN_ALLOWED_HOSTS=true");
  });
});
