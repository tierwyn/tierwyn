import { describe, it, expect } from 'vitest';
import { forceMechanism, HARD_STOP_ADAPTERS, steerClass } from '@tierwyn/shared';

describe('steerClass', () => {
  it('maps live-inject adapters to live when steer is on', () => {
    expect(steerClass('claude-code', true)).toBe('live');
    expect(steerClass('codex', true)).toBe('live');
    expect(steerClass('grok-bot', true)).toBe('live');
    // pi injects mid-run via RPC streamingBehavior:'steer' — delivered after
    // the current assistant turn's tool calls, before the next LLM call.
    expect(steerClass('pi', true)).toBe('live');
  });

  it('maps soft-cancel adapters to force when steer is on', () => {
    expect(steerClass('hermes', true)).toBe('force');
    expect(steerClass('grok-build', true)).toBe('force');
    expect(steerClass('qwen', true)).toBe('force');
  });

  it('maps hard-stop adapters to force (Interrupt & Send via kill+reinject)', () => {
    for (const agent of ['cursor', 'opencode', 'kilocode', 'antigravity', 'openclaw', 'copilot']) {
      expect(HARD_STOP_ADAPTERS.has(agent)).toBe(true);
      expect(forceMechanism(agent)).toBe('hard');
      // Catalogue may advertise steer:false (no soft mid-turn inject) — still force.
      expect(steerClass(agent, true)).toBe('force');
      expect(steerClass(agent, false)).toBe('force');
    }
  });

  it('maps unknown steer-capable adapters to queue', () => {
    expect(steerClass('some-future-agent', true)).toBe('queue');
  });

  it('returns queue when steer is false for non-hard-stop agents', () => {
    for (const agent of ['claude-code', 'hermes', 'pi', 'codex']) {
      expect(steerClass(agent, false)).toBe('queue');
    }
  });

  it('pins kiro dual membership: force modal with soft interrupt', () => {
    expect(steerClass('kiro', false)).toBe('force');
    expect(forceMechanism('kiro')).toBe('soft');
  });
});
