import { describe, it, expect } from 'vitest';
import type { AgentAdapter, ModelDescriptor } from './adapter.js';

describe('AgentAdapter contract', () => {
  it('ModelDescriptor requires name + label, allows provider/vision/steer/contextWindow', () => {
    const d: ModelDescriptor = { name: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'anthropic', vision: true, steer: true, contextWindow: 200000 };
    expect(d.name).toBe('anthropic/claude-sonnet-4');
    expect(d.contextWindow).toBe(200_000);
  });

  it('a minimal adapter implementation type-checks with listModels required and estimateTokenCount optional', () => {
    const fake: AgentAdapter = {
      start: async () => {}, sendPrompt: async () => {},
      streamEvents: () => ({} as never), stop: async () => {},
      listSessions: async () => [], loadSession: async () => {},
      listModels: async () => [{ name: 'm', label: 'M' }],
    };
    expect(typeof fake.listModels).toBe('function');
    expect(fake.estimateTokenCount).toBeUndefined();
    expect(fake.oneShot).toBeUndefined();
  });
});
