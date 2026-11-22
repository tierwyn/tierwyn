import { describe, it, expect } from 'vitest';
import {
  resolveTimerFireAt, TIMER_MIN_DELAY_MS, TIMER_MAX_DELAY_MS, AGENT_DEFER_MAX_MS,
  agentDeferCapError, selfTimerAllowed,
  type ConversationTimer, type ConversationTimerWithAttachments, type TimerOrigin,
} from './conversationTimers.js';

const NOW = 1_800_000_000_000;

describe('resolveTimerFireAt', () => {
  it('turns a relative delay into an absolute fire time', () => {
    expect(resolveTimerFireAt({ fireInMs: 120_000, now: NOW }))
      .toEqual({ ok: true, fireAtMs: NOW + 120_000 });
  });

  it('accepts an absolute fire time inside the window', () => {
    expect(resolveTimerFireAt({ fireAtMs: NOW + 3_600_000, now: NOW }))
      .toEqual({ ok: true, fireAtMs: NOW + 3_600_000 });
  });

  it('accepts a delay at exactly the one-minute floor', () => {
    expect(resolveTimerFireAt({ fireInMs: TIMER_MIN_DELAY_MS, now: NOW }))
      .toEqual({ ok: true, fireAtMs: NOW + 60_000 });
  });

  it('rejects the v1 five-second delay — the floor is now one minute', () => {
    expect(TIMER_MIN_DELAY_MS).toBe(60_000);
    for (const fireInMs of [5_000, 15_000, 59_999]) {
      const r = resolveTimerFireAt({ fireInMs, now: NOW });
      expect(r.ok, `${fireInMs}ms must be rejected`).toBe(false);
      expect(r).toMatchObject({ error: expect.stringContaining('at least 1 minute') });
    }
  });

  it('rejects a delay over the maximum', () => {
    expect(resolveTimerFireAt({ fireInMs: TIMER_MAX_DELAY_MS + 1, now: NOW }).ok).toBe(false);
    expect(resolveTimerFireAt({ fireAtMs: NOW + TIMER_MAX_DELAY_MS + 1, now: NOW }).ok).toBe(false);
  });

  it('rejects an absolute time in the past', () => {
    expect(resolveTimerFireAt({ fireAtMs: NOW - 1, now: NOW }).ok).toBe(false);
  });

  it('rejects both fields and neither field', () => {
    expect(resolveTimerFireAt({ fireInMs: 10_000, fireAtMs: NOW + 10_000, now: NOW }).ok).toBe(false);
    expect(resolveTimerFireAt({ now: NOW }).ok).toBe(false);
  });

  it('rejects non-finite / non-integer input', () => {
    expect(resolveTimerFireAt({ fireInMs: Number.NaN, now: NOW }).ok).toBe(false);
    expect(resolveTimerFireAt({ fireInMs: Number.POSITIVE_INFINITY, now: NOW }).ok).toBe(false);
    expect(resolveTimerFireAt({ fireInMs: 10_000.5, now: NOW }).ok).toBe(false);
  });
});

describe('conversation timer snapshot types', () => {
  it('carries an effort / options / attachment-name / handoff snapshot on the DTO', () => {
    const timer: ConversationTimer = {
      id: 't1', conversationId: 'c1', prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: NOW + 60_000, createdAt: NOW, cancelledAt: null, firedAt: null, error: null,
      effort: 'high', options: { thinking: true }, attachmentNames: ['rebuild.log'],
      handoffOverride: 'transcript', origin: 'operator', attempt: 1,
      notifyParent: null,
    };
    expect(timer.attachmentNames).toEqual(['rebuild.log']);
  });

  it('exposes the agent defer cap and origin union for Tier 1 callers', () => {
    expect(AGENT_DEFER_MAX_MS).toBe(8 * 60 * 60 * 1000);
    const origins: TimerOrigin[] = ['operator', 'agent-resume', 'auto-resume', 'agent-self'];
    expect(origins).toHaveLength(4);
  });

  it('keeps attachment bodies off the DTO and on the sweep-only view', () => {
    const withBodies: ConversationTimerWithAttachments = {
      id: 't1', conversationId: 'c1', prompt: 'go', profileId: 'claude-code:opus',
      fireAtMs: NOW + 60_000, createdAt: NOW, cancelledAt: null, firedAt: null, error: null,
      effort: null, options: null, attachmentNames: ['a.png'], handoffOverride: null,
      origin: 'operator', attempt: 1, notifyParent: null,
      attachments: [{ base64: 'AA==', mediaType: 'image/png', name: 'a.png' }],
    };

    expect(withBodies.attachments[0].base64).toBe('AA==');
    // The wire DTO carries names only; the repository is what strips the
    // bodies (Task 3 asserts that). Here we only pin the two-type split.
    const dtoKeys = Object.keys(withBodies).filter((k) => k !== 'attachments');
    expect(dtoKeys).toContain('attachmentNames');
  });
});

describe('agentDeferCapError', () => {
  it('passes within the cap', () => {
    expect(agentDeferCapError(60 * 60_000, AGENT_DEFER_MAX_MS)).toBeNull();
    expect(agentDeferCapError(AGENT_DEFER_MAX_MS, AGENT_DEFER_MAX_MS)).toBeNull();
  });
  it('rejects past the cap with the cap echoed', () => {
    const r = agentDeferCapError(AGENT_DEFER_MAX_MS + 1, AGENT_DEFER_MAX_MS);
    expect(r).toMatchObject({ maxDeferMs: AGENT_DEFER_MAX_MS });
    expect(r!.error).toMatch(/8h agent cap/);
  });
  it('treats a zero cap as disabled', () => {
    expect(agentDeferCapError(60_000, 0)).toEqual({ error: 'agent deferral is disabled', maxDeferMs: 0 });
  });
});

describe('selfTimerAllowed', () => {
  it.each([
    ['level0', true, true], ['level0', false, false],
    ['all', true, true], ['all', false, true],
    ['off', true, false], ['off', false, false],
  ] as const)('%s isRoot=%s → %s', (mode, isRoot, expected) => {
    expect(selfTimerAllowed(mode, isRoot)).toBe(expected);
  });
});

