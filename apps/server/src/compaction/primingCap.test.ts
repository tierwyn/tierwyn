import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { capForArgvSpawn, MAX_ARGV_PROMPT_BYTES, MAX_PRIMING_BYTES, ARGV_PRIMING_BYTES } from './primingCap.js';
import { buildPrimingPrompt } from './compactor.js';

describe('capForArgvSpawn', () => {
  it('returns text unchanged when under the byte budget', () => {
    expect(capForArgvSpawn('hello')).toBe('hello');
  });

  it('keeps the tail and adds a truncation marker when over budget', () => {
    const tail = 'RECENT: keep this part';
    const filler = 'x'.repeat(MAX_ARGV_PROMPT_BYTES);
    const out = capForArgvSpawn(filler + tail, 100);
    expect(out).toContain('truncated');
    expect(out).toContain('RECENT: keep this part');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
  });

  it.runIf(process.platform === 'linux')('output of the default cap can actually be spawned as one argument', () => {
    expect(spawnSync('/bin/true', ['é'.repeat(MAX_ARGV_PROMPT_BYTES)]).error?.message).toContain('E2BIG');
    const r = spawnSync('/bin/true', [capForArgvSpawn('é'.repeat(MAX_ARGV_PROMPT_BYTES))]);
    expect(r.error).toBeUndefined();
  });
});

describe('buildPrimingPrompt cap-then-frame (P5/F4)', () => {
  it('argv budget leaves room for the preamble and keeps the trust frame', () => {
    const prompt = buildPrimingPrompt('transcript', 'Y'.repeat(MAX_PRIMING_BYTES), 0, { framing: 'resume', maxBytes: ARGV_PRIMING_BYTES });
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(MAX_ARGV_PROMPT_BYTES - 30_000);
    expect(prompt).toContain('<handoff-context');
    expect(prompt.split('\n')[0]).toContain('Resuming a prior conversation');
  });

  it('a >400 KB body still yields a priming prompt whose first line is the resume intro, with the frame header outside the truncation window', () => {
    const huge = 'Y'.repeat(MAX_PRIMING_BYTES + 50_000);
    const prompt = buildPrimingPrompt('compacted', huge);
    const firstLine = prompt.split('\n')[0];
    expect(firstLine).toContain('Resuming a prior conversation');
    expect(firstLine).not.toContain('truncated');
    const openAt = prompt.indexOf('<handoff-context');
    expect(openAt).toBeGreaterThan(-1);
    const truncAt = prompt.indexOf('truncated');
    expect(truncAt).toBeGreaterThan(openAt);
    expect(prompt).toContain('</handoff-context>');
    expect(prompt.indexOf('data, not an order')).toBeLessThan(openAt);
    expect(prompt.indexOf('truncated')).toBeGreaterThan(prompt.indexOf('<handoff-context'));
    expect(prompt.lastIndexOf('</handoff-context>')).toBeGreaterThan(truncAt);
  });
});
