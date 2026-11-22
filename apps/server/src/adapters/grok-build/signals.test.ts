/**
 * signals.test.ts — readGrokSessionSignals path resolution (temp dir only).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readGrokSessionSignals } from './signals.js';
import { encodeSessionBucket } from './sessionPaths.js';

describe('readGrokSessionSignals', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grok-signals-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSignals(bucket: string, sessionId: string, body: Record<string, unknown>) {
    const dir = join(root, bucket, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'signals.json'), JSON.stringify(body));
  }

  it('reads from cwd bucket when cwd is provided', () => {
    const cwd = '/tmp/proj';
    const sid = 'sess-1';
    writeSignals(encodeSessionBucket(cwd), sid, {
      contextWindowUsage: 42,
      contextTokensUsed: 210_000,
      contextWindowTokens: 500_000,
    });
    const hit = readGrokSessionSignals(sid, { cwd, sessionsRoot: root });
    expect(hit?.contextWindowUsage).toBe(42);
    expect(hit?.contextTokensUsed).toBe(210_000);
    expect(hit?.contextWindowTokens).toBe(500_000);
    expect(hit?.mtimeMs).toBeTypeOf('number');
  });

  it('falls back to scanning all buckets when cwd misses', () => {
    const sid = 'sess-scan';
    writeSignals(encodeSessionBucket('/other/path'), sid, { contextWindowUsage: 11 });
    const hit = readGrokSessionSignals(sid, { cwd: '/wrong/cwd', sessionsRoot: root });
    expect(hit?.contextWindowUsage).toBe(11);
  });

  it('returns null when native id is missing or file absent', () => {
    expect(readGrokSessionSignals('', { sessionsRoot: root })).toBeNull();
    expect(readGrokSessionSignals('nope', { sessionsRoot: root })).toBeNull();
  });
});
