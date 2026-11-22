import { describe, it, expect, vi } from 'vitest';
import { stampUsageProfiles } from './stampUsageProfiles.js';
import type { AgentUsageAgentView, UsageProviderCard } from '@tierwyn/shared';

const claude: AgentUsageAgentView = {
  agentType: 'claude-code', label: 'Claude Code', installed: true, groups: [],
};
const zai: UsageProviderCard = {
  id: 'zai-usage', label: 'Z.AI', configured: true, ok: true,
};

const glm = { id: 'hermes:glm-4.6', label: 'GLM 4.6', agentType: 'hermes', model: 'GLM-4.6', enabled: true };
const sonnet = { id: 'claude-code:sonnet-4.6', label: 'Sonnet', agentType: 'claude-code', model: 'sonnet', enabled: true };
const cursor = { id: 'cursor:auto', label: 'Cursor', agentType: 'cursor', model: 'auto', enabled: true };

describe('stampUsageProfiles', () => {
  it('puts a plugin-matched profile on the provider card, not the builtin', () => {
    const find = vi.fn((agentType?: string) =>
      agentType === 'hermes' ? { pluginId: 'zai-usage' } : undefined,
    );
    const out = stampUsageProfiles(
      { builtins: [claude], providers: [zai] },
      { listProfiles: () => [glm, sonnet], findUsageProviderForAgent: find },
    );
    expect(out.providers[0].profiles?.map((p) => p.profileId)).toEqual(['hermes:glm-4.6']);
    expect(out.builtins[0].profiles?.map((p) => p.profileId)).toEqual(['claude-code:sonnet-4.6']);
  });

  it('honours a per-call findUsageProviderForAgent override (settings matchAgent)', () => {
    const find = vi.fn((agentType?: string) =>
      agentType === 'claude-code' ? { pluginId: 'zai-usage' } : undefined,
    );
    const out = stampUsageProfiles(
      { builtins: [claude], providers: [zai] },
      { listProfiles: () => [sonnet], findUsageProviderForAgent: find },
    );
    expect(out.providers[0].profiles?.map((p) => p.profileId)).toEqual(['claude-code:sonnet-4.6']);
    expect(out.builtins[0].profiles ?? []).toEqual([]);
  });

  it('omits a profile whose agentType has no builtin card and no provider hit', () => {
    const out = stampUsageProfiles(
      { builtins: [claude], providers: [zai] },
      { listProfiles: () => [cursor], findUsageProviderForAgent: () => undefined },
    );
    expect(out.builtins[0].profiles ?? []).toEqual([]);
    expect(out.providers[0].profiles ?? []).toEqual([]);
  });

  it('does not mutate the input card objects (cached provider cards stay clean)', () => {
    const out = stampUsageProfiles(
      { builtins: [claude], providers: [zai] },
      { listProfiles: () => [sonnet], findUsageProviderForAgent: () => undefined },
    );
    expect(out.providers[0]).not.toBe(zai);
    expect(zai.profiles).toBeUndefined();
    expect(out.builtins[0].profiles?.map((p) => p.profileId)).toEqual(['claude-code:sonnet-4.6']);
  });

  it('memoises findUsageProviderForAgent per agentType+model', () => {
    const find = vi.fn(() => undefined);
    const twice = { ...sonnet, id: 'claude-code:opus-4.8', model: 'sonnet' }; // same agent+model
    stampUsageProfiles(
      { builtins: [claude], providers: [] },
      { listProfiles: () => [sonnet, twice], findUsageProviderForAgent: find },
    );
    expect(find).toHaveBeenCalledTimes(1);
  });
});
