import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentUsageSnapshot, PluginCaller, PluginEnvelope } from '@tierwyn/shared';
import type { ProbedRateLimits } from '../adapters/claude-code/probeUsage.js';
import type { AgyUsageGroup } from '../adapters/antigravity/probeUsage.js';
import {
  AGENT_USAGE_ERROR_MAX,
  attachUsageProviders,
  buildAgentUsage,
  buildAgentUsageForAgent,
  buildOneAgentUsage,
  buildProviderCards,
  buildUnifiedUsage,
  registerAgentUsageRoutes,
  toAgentView,
  _resetUsageProviderCache,
  USAGE_PROVIDER_TIMEOUT_MS,
  USAGE_PROVIDER_CACHE_MS,
  type AgentUsageDeps,
  type UsageProviderHost,
} from './agentUsage.js';

const CLAUDE: ProbedRateLimits = {
  fiveHourPct: 12,
  fiveHourResetsAt: 1_700_000_000_000,
  sevenDayPct: 34,
  sevenDayResetsAt: 1_700_100_000_000,
  extraUsageUsed: 39.99,
  extraUsageLimit: 40.0,
  extraUsagePct: 100,
  extraUsageCurrency: 'GBP',
  subscriptionType: 'pro',
};
const GROK: ProbedRateLimits = {
  sevenDayPct: 55,
  sevenDayResetsAt: 1_700_200_000_000,
  prepaidBalance: 10,
  onDemandUsed: 2.5,
  onDemandCap: 25,
};
const CODEX: ProbedRateLimits = { fiveHourPct: 8, sevenDayPct: 22 };
const ZAI: ProbedRateLimits = { fiveHourPct: 13, subscriptionType: 'lite' };
const KIRO: ProbedRateLimits = {
  monthlyPct: 2.8,
  monthlyResetsAt: Date.parse('2026-09-01'),
  creditsUsed: 1.4,
  creditsLimit: 50,
  subscriptionType: 'KIRO FREE',
};

const AGY_GROUPS: AgyUsageGroup[] = [
  {
    id: 'gemini-models',
    label: 'Gemini Models',
    limits: { fiveHourPct: 21, sevenDayPct: 6 },
  },
  {
    id: 'claude-and-gpt-models',
    label: 'Claude and GPT models',
    limits: { fiveHourPct: 75, sevenDayPct: 50 },
  },
  { id: 'empty', label: 'Empty', limits: {} },
];

function stubDeps(overrides: Partial<AgentUsageDeps> = {}): AgentUsageDeps & {
  probeClaude: ReturnType<typeof vi.fn>;
  probeCodex: ReturnType<typeof vi.fn>;
  probeGrok: ReturnType<typeof vi.fn>;
  probeAgyGroups: ReturnType<typeof vi.fn>;
  probeKiro: ReturnType<typeof vi.fn>;
} {
  const probeClaude = vi.fn(async () => CLAUDE);
  const probeCodex = vi.fn(async () => CODEX);
  const probeGrok = vi.fn(async () => GROK);
  const probeAgyGroups = vi.fn(async () => AGY_GROUPS);
  const probeKiro = vi.fn(async () => KIRO);
  return {
    isInstalled: () => true,
    probeClaude,
    probeCodex,
    probeGrok,
    probeAgyGroups,
    probeKiro,
    ...overrides,
    // keep spies even if overrides replaced the functions with non-spies
    ...(overrides.probeClaude ? { probeClaude: overrides.probeClaude as ReturnType<typeof vi.fn> } : { probeClaude }),
    ...(overrides.probeCodex ? { probeCodex: overrides.probeCodex as ReturnType<typeof vi.fn> } : { probeCodex }),
    ...(overrides.probeGrok ? { probeGrok: overrides.probeGrok as ReturnType<typeof vi.fn> } : { probeGrok }),
    ...(overrides.probeAgyGroups ? { probeAgyGroups: overrides.probeAgyGroups as ReturnType<typeof vi.fn> } : { probeAgyGroups }),
    ...(overrides.probeKiro ? { probeKiro: overrides.probeKiro as ReturnType<typeof vi.fn> } : { probeKiro }),
  };
}

describe('buildAgentUsage', () => {
  it('returns six snapshots in fixed order with groups populated and updatedAt set', async () => {
    const deps = stubDeps();
    const out = await buildAgentUsage(deps, false);
    expect(out.map((s) => s.agentType)).toEqual(['claude-code', 'codex', 'antigravity', 'grok-build', 'kiro', 'copilot']);
    expect(out.map((s) => s.label)).toEqual(['Claude Code', 'Codex', 'Antigravity', 'Grok Build', 'Kiro', 'GitHub Copilot']);
    expect(out.every((s) => s.installed)).toBe(true);

    expect(out[0].kind).toBe('agent');
    expect(out[0].source).toBe('builtin');
    expect(out[0].groups).toEqual([{
      id: 'default',
      label: 'Claude Code',
      fiveHourPct: 12,
      fiveHourResetsAt: 1_700_000_000_000,
      sevenDayPct: 34,
      sevenDayResetsAt: 1_700_100_000_000,
      extraUsageUsed: 39.99,
      extraUsageLimit: 40.0,
      extraUsagePct: 100,
      extraUsageCurrency: 'GBP',
    }]);
    expect(out[0].subscriptionType).toBe('pro');
    expect(out[0].updatedAt).toEqual(expect.any(Number));

    expect(out[1].groups[0].id).toBe('default');
    expect(out[1].groups[0].fiveHourPct).toBe(8);

    expect(out[2].groups.map((g) => g.id)).toEqual(['gemini-models', 'claude-and-gpt-models']);
    expect(out[2].groups).toHaveLength(2);

    expect(out[3].groups).toEqual([{
      id: 'default',
      label: 'Grok Build',
      sevenDayPct: 55,
      sevenDayResetsAt: 1_700_200_000_000,
      prepaidBalance: 10,
      onDemandUsed: 2.5,
      onDemandCap: 25,
    }]);

    expect(out[4].groups).toEqual([{
      id: 'default',
      label: 'Kiro',
      monthlyPct: 2.8,
      monthlyResetsAt: Date.parse('2026-09-01'),
      creditsUsed: 1.4,
      creditsLimit: 50,
    }]);
    expect(out[4].subscriptionType).toBe('KIRO FREE');
  });

  it('keeps data on the other four when one probe rejects', async () => {
    const deps = stubDeps({
      probeGrok: vi.fn(async () => { throw new Error('grok down'); }),
    });
    const out = await buildAgentUsage(deps, false);
    expect(out).toHaveLength(6);
    const grok = out.find((s) => s.agentType === 'grok-build');
    expect(grok?.error).toBe('grok down');
    expect(grok?.groups).toEqual([]);
    expect(out.find((s) => s.agentType === 'claude-code')?.groups.length).toBe(1);
    expect(out.find((s) => s.agentType === 'antigravity')?.groups.length).toBe(2);
    expect(out.find((s) => s.agentType === 'codex')?.groups.length).toBe(1);
    expect(out.find((s) => s.agentType === 'kiro')?.groups.length).toBe(1);
  });

  it('skips the probe when not installed and surfaces installHint', async () => {
    const deps = stubDeps({
      isInstalled: (type) => type !== 'codex',
    });
    const out = await buildAgentUsage(deps, false);
    const codex = out.find((s) => s.agentType === 'codex');
    expect(codex?.installed).toBe(false);
    expect(codex?.installHint).toMatch(/Codex/i);
    expect(codex?.groups).toEqual([]);
    expect(codex?.error).toBeUndefined();
    expect(deps.probeCodex).not.toHaveBeenCalled();
    expect(deps.probeClaude).toHaveBeenCalledTimes(1);
  });

  it('treats an empty probe result as no data, not an error', async () => {
    const deps = stubDeps({
      probeClaude: vi.fn(async () => ({})),
    });
    const out = await buildAgentUsage(deps, false);
    const claude = out.find((s) => s.agentType === 'claude-code');
    expect(claude?.groups).toEqual([]);
    expect(claude?.error).toBeUndefined();
    expect(claude?.updatedAt).toBeUndefined();
    expect(claude?.installed).toBe(true);
  });

  it('keeps both antigravity groups and drops a group with empty limits', async () => {
    const deps = stubDeps();
    const out = await buildAgentUsage(deps, false);
    const agy = out.find((s) => s.agentType === 'antigravity');
    expect(agy?.groups).toHaveLength(2);
    expect(agy?.groups.map((g) => g.label)).toEqual(['Gemini Models', 'Claude and GPT models']);
    expect(agy?.groups.find((g) => g.id === 'empty')).toBeUndefined();
    expect(agy?.updatedAt).toEqual(expect.any(Number));
  });

  it('forwards fresh as force: true to every installed probe', async () => {
    const deps = stubDeps();
    await buildAgentUsage(deps, true);
    expect(deps.probeClaude).toHaveBeenCalledWith({ force: true });
    expect(deps.probeAgyGroups).toHaveBeenCalledWith({ force: true });
    expect(deps.probeGrok).toHaveBeenCalledWith({ force: true });
    expect(deps.probeCodex).toHaveBeenCalledWith({ force: true });
    expect(deps.probeKiro).toHaveBeenCalledWith({ force: true });
  });

  it('appends a configured plugin usageProvider as a provider card', async () => {
    const deps = stubDeps({
      listUsageProviders: () => [{
        id: 'zai-usage',
        label: 'Z.AI',
        capability: 'usage.get',
        configured: true,
      }],
    });
    const out = await buildAgentUsage(deps, false);
    expect(out).toHaveLength(7);
    const zai = out.find((s) => s.label === 'Z.AI');
    expect(zai?.kind).toBe('provider');
    expect(zai?.source).toBe('plugin');
    expect(zai?.pluginId).toBe('zai-usage');
    expect(zai?.pluginCapability).toBe('usage.get');
    expect(zai?.pluginConfigured).toBe(true);
    expect(zai?.builtinAvailable).toBe(false);
  });

  it('surfaces pluginConfigured:false when credentials are missing', async () => {
    const deps = stubDeps({
      listUsageProviders: () => [{
        id: 'zai-usage',
        label: 'Z.AI',
        capability: 'usage.get',
        configured: false,
      }],
    });
    const out = await buildAgentUsage(deps, false);
    const zai = out.find((s) => s.label === 'Z.AI');
    expect(zai?.pluginConfigured).toBe(false);
    expect(zai?.pluginId).toBe('zai-usage');
    expect(zai?.builtinAvailable).toBe(false);
    expect(zai?.source).toBe('plugin');
  });

  it('appends a pure-plugin provider when no builtin card shares the label', async () => {
    const deps = stubDeps({
      listUsageProviders: () => [{
        id: 'other-quota',
        label: 'Other Cloud',
        capability: 'usage.get',
        configured: true,
      }],
    });
    const out = await buildAgentUsage(deps, false);
    expect(out).toHaveLength(7);
    const other = out.find((s) => s.agentType === 'other-quota');
    expect(other).toMatchObject({
      kind: 'provider',
      source: 'plugin',
      label: 'Other Cloud',
      pluginConfigured: true,
      builtinAvailable: false,
      groups: [],
    });
  });
});

describe('attachUsageProviders', () => {
  it('is a no-op when the provider list is empty', () => {
    const base = [{
      agentType: 'hermes',
      label: 'Z.AI',
      kind: 'provider' as const,
      source: 'builtin' as const,
      installed: true,
      groups: [{ id: 'default', label: 'Z.AI', fiveHourPct: 1 }],
      builtinAvailable: true,
    }];
    expect(attachUsageProviders(base, [])).toEqual(base);
  });
});

const AGENT_VIEW_ALLOWLIST = ['agentType', 'label', 'installed', 'subscriptionType', 'updatedAt', 'groups', 'error'];

describe('toAgentView (allowlist projection)', () => {
  it('keeps only allowlisted keys', () => {
    const snapshot: AgentUsageSnapshot = {
      agentType: 'claude-code',
      label: 'Claude Code',
      kind: 'provider',
      source: 'builtin',
      installed: true,
      subscriptionType: 'pro',
      updatedAt: 1_700_000_000_000,
      groups: [{ id: 'default', label: 'Claude Code', fiveHourPct: 12 }],
      error: 'boom',
      installHint: 'npm i -g @anthropic-ai/claude-code',
      builtinAvailable: true,
      pluginId: 'zai-usage',
      pluginCapability: 'usage.get',
      pluginConfigured: true,
    };
    const view = toAgentView(snapshot);
    expect([...Object.keys(view)].sort()).toEqual([...AGENT_VIEW_ALLOWLIST].sort());
  });

  it('omits optional keys that are absent on the snapshot', () => {
    const snapshot: AgentUsageSnapshot = {
      agentType: 'kiro',
      label: 'Kiro',
      kind: 'agent',
      source: 'builtin',
      installed: true,
      groups: [],
    };
    const view = toAgentView(snapshot);
    expect(Object.keys(view)).toEqual(['agentType', 'label', 'installed', 'groups']);
  });
});

describe('buildAgentUsageForAgent', () => {
  it('projects builtin snapshots and strips plugin provider cards', async () => {
    const deps = stubDeps({
      listUsageProviders: () => [{ id: 'zai-usage', label: 'Z.AI', capability: 'usage.get', configured: true }],
    });
    const out = await buildAgentUsageForAgent(deps);
    expect(out.map((s) => s.agentType)).toEqual(['claude-code', 'codex', 'antigravity', 'grok-build', 'kiro', 'copilot']);
    for (const v of out) {
      expect(Object.keys(v).every((k) => AGENT_VIEW_ALLOWLIST.includes(k))).toBe(true);
    }
  });

  it('truncates probe errors to AGENT_USAGE_ERROR_MAX', async () => {
    const long = 'x'.repeat(500);
    const deps = stubDeps({
      probeKiro: vi.fn(async () => {
        throw new Error(long);
      }),
    });
    const out = await buildAgentUsageForAgent(deps);
    const kiro = out.find((s) => s.agentType === 'kiro');
    expect(kiro?.error).toBeDefined();
    expect(kiro?.error?.length).toBe(AGENT_USAGE_ERROR_MAX);
    expect(kiro?.error?.length).toBeLessThan(long.length);
  });

  it('probes only the requested builtin type', async () => {
    const deps = stubDeps();
    const view = await buildOneAgentUsage(deps, 'codex');
    expect(view.agentType).toBe('codex');
    expect(view.groups.length).toBe(1);
    expect(deps.probeCodex).toHaveBeenCalledTimes(1);
    expect(deps.probeClaude).not.toHaveBeenCalled();
    expect(deps.probeGrok).not.toHaveBeenCalled();
    expect(deps.probeAgyGroups).not.toHaveBeenCalled();
    expect(deps.probeKiro).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildProviderCards — unified /agent/usage provider half
// ---------------------------------------------------------------------------

const OPERATOR: PluginCaller = { kind: 'operator' };

function provider(id: string, over: Partial<{ label: string; capability: string; configured: boolean }> = {}) {
  return {
    id,
    label: over.label ?? id,
    capability: over.capability ?? 'usage.get',
    configured: over.configured ?? true,
  };
}

function stubProviderHost(
  providers: ReturnType<typeof provider>[],
  invoke: UsageProviderHost['invoke'],
): UsageProviderHost {
  return { listUsageProviders: () => providers, invoke };
}

function okEnvelope(data: unknown): PluginEnvelope<unknown> {
  return { ok: true, data };
}

describe('buildProviderCards', () => {
  beforeEach(() => {
    _resetUsageProviderCache();
  });

  it('keeps a slow invoke in flight past the 5s timeout and caches the late success', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let settle!: (env: PluginEnvelope<unknown>) => void;
      const host = stubProviderHost([provider('slow')], () => {
        calls += 1;
        return new Promise<PluginEnvelope<unknown>>((resolve) => { settle = resolve; });
      });
      const first = buildProviderCards(host, OPERATOR);
      await vi.advanceTimersByTimeAsync(USAGE_PROVIDER_TIMEOUT_MS);
      const timedOut = await first;
      expect(timedOut[0]).toMatchObject({ ok: false, code: 'timeout' });
      expect(calls).toBe(1);

      settle(okEnvelope({ pct: 99 }));
      await Promise.resolve();
      const second = await buildProviderCards(host, OPERATOR);
      expect(calls).toBe(1);
      expect(second[0]).toMatchObject({ ok: true, data: { pct: 99 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times a provider out at USAGE_PROVIDER_TIMEOUT_MS leaving other cards unaffected', async () => {
    vi.useFakeTimers();
    try {
      const host = stubProviderHost(
        [provider('slow'), provider('fast')],
        (id) => (id === 'slow' ? new Promise<PluginEnvelope<unknown>>(() => {}) : Promise.resolve(okEnvelope({ pct: 1 }))),
      );
      const pending = buildProviderCards(host, OPERATOR);
      await vi.advanceTimersByTimeAsync(USAGE_PROVIDER_TIMEOUT_MS);
      const cards = await pending;
      const slow = cards.find((c) => c.id === 'slow');
      expect(slow).toMatchObject({ ok: false, code: 'timeout', configured: true });
      expect(slow?.error).toMatch(/5s/);
      const fast = cards.find((c) => c.id === 'fast');
      expect(fast).toMatchObject({ ok: true, data: { pct: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a second build from cache within USAGE_PROVIDER_CACHE_MS (invoke once)', async () => {
    let calls = 0;
    const host = stubProviderHost([provider('zai-usage', { label: 'Z.AI' })], async () => {
      calls += 1;
      return okEnvelope({ fiveHourPct: 5 });
    });
    const first = await buildProviderCards(host, OPERATOR);
    const second = await buildProviderCards(host, OPERATOR);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ id: 'zai-usage', label: 'Z.AI', ok: true });
  });

  it('re-invokes on the next build after a retryable failure', async () => {
    let calls = 0;
    const host = stubProviderHost([provider('zai-usage')], async () => {
      calls += 1;
      return { ok: false as const, error: 'upstream blew up', code: 'upstream_error' as const, retryable: true };
    });
    const first = await buildProviderCards(host, OPERATOR);
    expect(first[0]).toMatchObject({ ok: false, code: 'upstream_error' });
    const second = await buildProviderCards(host, OPERATOR);
    expect(calls).toBe(2);
    expect(second[0].ok).toBe(false);
  });

  it('caches a non-retryable failure for the cache window', async () => {
    let calls = 0;
    const host = stubProviderHost([provider('kilo-usage')], async () => {
      calls += 1;
      return { ok: false as const, error: 'key missing', code: 'credential_missing' as const, retryable: false };
    });
    const first = await buildProviderCards(host, OPERATOR);
    const second = await buildProviderCards(host, OPERATOR);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(first[0].code).toBe('credential_missing');
  });

  it('dedupes duplicate provider ids (first entry wins)', async () => {
    let calls = 0;
    const host = stubProviderHost(
      [provider('zai-usage', { label: 'Z.AI' }), provider('zai-usage', { label: 'Z.AI Again' })],
      async () => {
        calls += 1;
        return okEnvelope({});
      },
    );
    const cards = await buildProviderCards(host, OPERATOR);
    expect(cards).toHaveLength(1);
    expect(cards[0].label).toBe('Z.AI');
    expect(calls).toBe(1);
  });

  it('invokes the declared capability name, not a hard-coded usage.get', async () => {
    const invoke = vi.fn(async () => okEnvelope({}));
    const host = stubProviderHost([provider('kilo-usage', { capability: 'quota.fetch' })], invoke);
    await buildProviderCards(host, OPERATOR);
    expect(invoke).toHaveBeenCalledWith('kilo-usage', 'quota.fetch', {}, OPERATOR);
  });

  it('truncates provider errors to AGENT_USAGE_ERROR_MAX', async () => {
    const long = 'y'.repeat(500);
    const host = stubProviderHost(
      [provider('zai-usage')],
      async () => ({ ok: false as const, error: long, code: 'upstream_error' as const, retryable: true }),
    );
    const cards = await buildProviderCards(host, OPERATOR);
    expect(cards[0].error?.startsWith('y'.repeat(AGENT_USAGE_ERROR_MAX))).toBe(true);
    expect(cards[0].error?.endsWith('…')).toBe(true);
    expect(cards[0].error?.length).toBeLessThan(long.length);
  });

  it('reports not_configured without invoking when credentials are missing', async () => {
    const invoke = vi.fn(async () => okEnvelope({}));
    const host = stubProviderHost([provider('kilo-usage', { configured: false })], invoke);
    const cards = await buildProviderCards(host, OPERATOR);
    expect(cards[0]).toMatchObject({ ok: false, code: 'not_configured', configured: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`expires cache entries after ${USAGE_PROVIDER_CACHE_MS}ms`, async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const host = stubProviderHost([provider('zai-usage')], async () => {
        calls += 1;
        return okEnvelope({ n: calls });
      });
      await buildProviderCards(host, OPERATOR);
      await vi.advanceTimersByTimeAsync(USAGE_PROVIDER_CACHE_MS + 1);
      const second = await buildProviderCards(host, OPERATOR);
      expect(calls).toBe(2);
      expect(second[0].data).toEqual({ n: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Jev spend card', () => {
  const jevCard = (): AgentUsageSnapshot => ({
    agentType: 'jev', label: 'Jev · TypeSafe System One', kind: 'provider', source: 'builtin',
    installed: true, builtinAvailable: true, groups: [], updatedAt: 1,
    spend: {
      since: 0, calls: 2, inputTokens: 300, outputTokens: 4, costUsd: 0.0000126, missingUsage: 0,
      byConsumer: [{ consumer: 'notify', calls: 2, inputTokens: 300, costUsd: 0.0000126 }], errors: [], windowLabel: 'last 30 days',
    },
  });

  async function getSettingsAgents(deps: AgentUsageDeps): Promise<AgentUsageSnapshot[]> {
    let handler!: (req: unknown, res: { json: (b: unknown) => void }) => Promise<void>;
    const app = { get: (path: string, h: typeof handler) => { if (path === '/settings/agent-usage') handler = h; } };
    registerAgentUsageRoutes(app as never, deps);
    let body: { agents: AgentUsageSnapshot[] } | undefined;
    await handler({ query: {} }, { json: (b) => { body = b as { agents: AgentUsageSnapshot[] }; } });
    return body!.agents;
  }

  it('/settings/agent-usage places the jev card at the top when jevUsage is wired', async () => {
    const agents = await getSettingsAgents(stubDeps({ jevUsage: jevCard }));
    expect(agents.map((a) => a.agentType)).toEqual(['jev', 'claude-code', 'codex', 'antigravity', 'grok-build', 'kiro', 'copilot']);
    expect(agents[0]!.spend?.calls).toBe(2);
    expect(agents[0]!.pluginId).toBeUndefined(); // built-in, never routed through a plugin
  });

  it('/settings/agent-usage is unchanged without jevUsage', async () => {
    const agents = await getSettingsAgents(stubDeps());
    expect(agents.some((a) => a.agentType === 'jev')).toBe(false);
  });

  it('agent-facing builders never include the jev card or a spend field', async () => {
    const deps = stubDeps({ jevUsage: jevCard });
    const views = await buildAgentUsageForAgent(deps);
    expect(views.some((v) => v.agentType === 'jev')).toBe(false);
    expect(JSON.stringify(views)).not.toContain('spend');
    const unified = await buildUnifiedUsage(deps, stubProviderHost([], async () => okEnvelope({})), OPERATOR);
    expect(unified.builtins.some((v) => v.agentType === 'jev')).toBe(false);
    expect(unified.providers.some((p) => p.id === 'jev')).toBe(false);
    expect(JSON.stringify(unified)).not.toContain('spend');
  });

  it('toAgentView drops spend even if a snapshot carries it', () => {
    expect('spend' in toAgentView(jevCard())).toBe(false);
  });
});
