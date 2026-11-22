import { describe, it, expect } from 'vitest';
import { usageCapabilitiesFor } from './usageCapabilities.js';

describe('usageCapabilitiesFor', () => {
  it('claude-code supports both context window and rate limits', () => {
    expect(usageCapabilitiesFor('claude-code')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: true,
    });
  });

  it('pi supports context window only', () => {
    expect(usageCapabilitiesFor('pi')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: false,
    });
  });

  it('grok-build supports context window and weekly credit rate limits', () => {
    expect(usageCapabilitiesFor('grok-build')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: true,
    });
  });

  it('antigravity supports both context window and rate limits', () => {
    expect(usageCapabilitiesFor('antigravity')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: true,
    });
  });

  it('codex supports context window and account rate limits', () => {
    expect(usageCapabilitiesFor('codex')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: true,
    });
  });

  it('kiro supports context window and monthly credit rate limits', () => {
    expect(usageCapabilitiesFor('kiro')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: true,
    });
  });

  it('qwen supports context window only', () => {
    expect(usageCapabilitiesFor('qwen')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: false,
    });
  });

  it('kimi supports context window only', () => {
    expect(usageCapabilitiesFor('kimi')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: false,
    });
  });

  it('copilot supports context window and rate limits', () => {
    expect(usageCapabilitiesFor('copilot')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: true,
    });
  });

  it('deepseek supports context window but no rate limits', () => {
    expect(usageCapabilitiesFor('deepseek')).toEqual({
      supportsContextWindow: true,
      supportsRateLimits: false,
    });
  });

  it('an unknown agent defaults to neither', () => {
    expect(usageCapabilitiesFor(undefined)).toEqual({
      supportsContextWindow: false,
      supportsRateLimits: false,
    });
  });
});
