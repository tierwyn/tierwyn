import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, 'index.ts'), 'utf8');

describe('boot order: mutate live sessions only after bind', () => {
  it('does not call closeStaleSessions or reconcileSpawnEdges before httpServer.listen', () => {
    const listenIdx = indexSrc.search(/httpServer\.listen\s*\(/);
    expect(listenIdx).toBeGreaterThan(0);
    const before = indexSrc.slice(0, listenIdx);
    expect(before).not.toMatch(/closeStaleSessions\s*\(/);
    expect(before).not.toMatch(/reconcileSpawnEdges\s*\(/);
    expect(before).not.toMatch(/reconcileOrphanShellResults\s*\(/);
  });

  it('builds the plugin scrub list before httpServer.listen (F18)', () => {
    const listenIdx = indexSrc.search(/httpServer\.listen\s*\(/);
    expect(listenIdx).toBeGreaterThan(0);
    const before = indexSrc.slice(0, listenIdx);
    const scanIdx = before.search(/scanManifests\s*\(/);
    const scrubIdx = before.search(/setPluginScrubKeys\s*\(/);
    const captureIdx = before.search(/captureCredentials\s*\(/);
    expect(scanIdx).toBeGreaterThan(0);
    expect(scrubIdx).toBeGreaterThan(scanIdx);
    expect(captureIdx).toBeGreaterThan(scrubIdx);
    expect(before).toMatch(/delete process\.env\.SESSION_SECRET/);
    expect(before).toMatch(/delete process\.env\.OPERATOR_PASSWORD_HASH/);
  });

  it('runs those reconciles inside the listen success callback', () => {
    const listenIdx = indexSrc.search(/httpServer\.listen\s*\(/);
    const after = indexSrc.slice(listenIdx);
    const callbackEnd = after.indexOf('\n});');
    const callback = callbackEnd >= 0 ? after.slice(0, callbackEnd) : after;
    expect(callback).toMatch(/closeStaleSessions\s*\(/);
    expect(callback).toMatch(/reconcileSpawnEdges\s*\(/);
    expect(callback).toMatch(/reconcileOrphanShellResults\s*\(/);
  });
});

describe('boot order: grok-bot supervisor', () => {
  it('constructs the supervisor before httpServer.listen', () => {
    const listenIdx = indexSrc.search(/httpServer\.listen\s*\(/);
    expect(listenIdx).toBeGreaterThan(0);
    const before = indexSrc.slice(0, listenIdx);
    expect(before).toMatch(/createGrokBotSupervisor\s*\(/);
  });

  it('starts the supervisor only inside the listen success callback', () => {
    const listenIdx = indexSrc.search(/httpServer\.listen\s*\(/);
    const before = indexSrc.slice(0, listenIdx);
    const after = indexSrc.slice(listenIdx);
    const callbackEnd = after.indexOf('\n});');
    const callback = callbackEnd >= 0 ? after.slice(0, callbackEnd) : after;
    expect(before).not.toMatch(/grokSupervisor\.start\s*\(/);
    expect(callback).toMatch(/grokSupervisor\.start\s*\(/);
  });

  it('stops the supervisor inside shutdown', () => {
    const shutdownIdx = indexSrc.search(/function shutdown\s*\(/);
    expect(shutdownIdx).toBeGreaterThan(0);
    expect(indexSrc.slice(shutdownIdx)).toMatch(/grokSupervisor\.stop\s*\(/);
  });
});
