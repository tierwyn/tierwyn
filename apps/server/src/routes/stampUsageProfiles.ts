import type { AgentUsageAgentView, UsageProfileRef, UsageProviderCard } from '@tierwyn/shared';

export interface StampUsageProfilesHost {
  findUsageProviderForAgent(agentType?: string, modelName?: string): { pluginId: string } | undefined;
}

export function stampUsageProfiles(
  body: { builtins: AgentUsageAgentView[]; providers: UsageProviderCard[] },
  opts: {
    listProfiles: () => Array<{ id: string; label: string; agentType: string; model: string; enabled: boolean }>;
    findUsageProviderForAgent: StampUsageProfilesHost['findUsageProviderForAgent'];
  },
): { builtins: AgentUsageAgentView[]; providers: UsageProviderCard[] } {
  const byProvider = new Map<string, UsageProfileRef[]>();
  const byBuiltin = new Map<string, UsageProfileRef[]>();
  const cache = new Map<string, { pluginId: string } | undefined>();

  const lookup = (agentType: string, model: string) => {
    const key = `${agentType}\0${model}`;
    if (!cache.has(key)) cache.set(key, opts.findUsageProviderForAgent(agentType, model));
    return cache.get(key);
  };

  const push = (map: Map<string, UsageProfileRef[]>, key: string, ref: UsageProfileRef) => {
    const arr = map.get(key) ?? [];
    arr.push(ref);
    map.set(key, arr);
  };

  for (const p of opts.listProfiles()) {
    if (!p.enabled) continue;
    const ref: UsageProfileRef = {
      profileId: p.id, label: p.label, agentType: p.agentType, model: p.model, enabled: p.enabled,
    };
    const hit = lookup(p.agentType, p.model);
    if (hit) push(byProvider, hit.pluginId, ref);
    else push(byBuiltin, p.agentType, ref);
  }

  return {
    builtins: body.builtins.map((b) => ({ ...b, profiles: byBuiltin.get(b.agentType) ?? [] })),
    providers: body.providers.map((p) => ({ ...p, profiles: byProvider.get(p.id) ?? [] })),
  };
}
