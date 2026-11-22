import type { Express } from 'express';
import type { AgentUsageAgentView, AgentUsageGroup, AgentUsageSnapshot, ClaudeInsights, CodexInsights, AntigravityInsights, CursorInsights, PluginCaller, PluginEnvelope, UnifiedUsageBody, UsageProviderCard } from '@tierwyn/shared';
import type { ProbedRateLimits } from '../adapters/claude-code/probeUsage.js';
import { probeClaudeInsights } from '../adapters/claude-code/probeUsage.js';
import { probeCodexInsights } from '../adapters/codex/probeUsage.js';
import { probeAntigravityInsights, type AgyUsageGroup } from '../adapters/antigravity/probeUsage.js';
import { INSTALL_HINTS } from '../discovery.js';
import { PLUGIN_ERROR_HTTP_STATUS, PLUGIN_ERROR_RETRYABLE } from '../plugins/host.js';
import { catalogue } from '../catalogue.js';
import { stampUsageProfiles } from './stampUsageProfiles.js';

const AGENT_ORDER = ['claude-code', 'codex', 'antigravity', 'grok-build', 'kiro', 'copilot'] as const;
export type UsageAgentType = (typeof AGENT_ORDER)[number];

/** Agent-quota display names. */
const AGENT_LABELS: Record<UsageAgentType, string> = {
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
  'grok-build': 'Grok Build',
  codex: 'Codex',
  kiro: 'Kiro',
  copilot: 'GitHub Copilot',
};

const PROVIDER_AGENT_TYPES = new Set<UsageAgentType>([]);

export interface UsageProviderInfo {
  id: string;
  label: string;
  capability: string;
  configured: boolean;
  section?: string;
}

export interface AgentUsageDeps {
  isInstalled: (agentType: string) => boolean;
  probeClaude: (o: { force: boolean }) => Promise<ProbedRateLimits>;
  probeClaudeInsights?: (o: { force: boolean }) => Promise<ClaudeInsights>;
  probeCodex: (o: { force: boolean }) => Promise<ProbedRateLimits>;
  probeCodexInsights?: (o: { force: boolean }) => Promise<CodexInsights>;
  probeAntigravityInsights?: (o: { force: boolean }) => Promise<AntigravityInsights>;
  probeCursorInsights?: (o: { force: boolean }) => Promise<CursorInsights>;
  probeGrok: (o: { force: boolean }) => Promise<ProbedRateLimits>;
  probeAgyGroups: (o: { force: boolean }) => Promise<AgyUsageGroup[]>;
  probeKiro: (o: { force: boolean }) => Promise<ProbedRateLimits>;
  probeCopilot?: (o: { force: boolean }) => Promise<ProbedRateLimits>;
  /** Active plugins declaring usageProvider (host.listUsageProviders). */
  listUsageProviders?: () => UsageProviderInfo[];
  /** Built-in Jev spend card. Operator view only — appended by /settings/agent-usage, never by buildAgentUsage. */
  jevUsage?: () => AgentUsageSnapshot;
}

export function registerAgentUsageRoutes(app: Express, deps: AgentUsageDeps): void {
  app.get('/settings/agent-usage', async (req, res) => {
    const force = req.query.fresh === '1';
    const agents = await buildAgentUsage(deps, force);
    if (deps.jevUsage) agents.unshift(deps.jevUsage());  // Insert at top, not bottom
    res.json({ agents });
  });

  app.get('/settings/agent-usage/claude-insights', async (req, res) => {
    const force = req.query.fresh === '1';
    if (!deps.isInstalled('claude-code')) {
      res.status(404).json({ error: 'Claude Code CLI not installed' });
      return;
    }
    const fn = deps.probeClaudeInsights ?? ((o) => probeClaudeInsights(o));
    try {
      const insights = await fn({ force });
      res.json({ insights });
    } catch (err) {
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/settings/agent-usage/codex-insights', async (req, res) => {
    const force = req.query.fresh === '1';
    if (!deps.isInstalled('codex')) {
      res.status(404).json({ error: 'OpenAI Codex CLI not installed' });
      return;
    }
    const fn = deps.probeCodexInsights ?? ((o) => probeCodexInsights(o));
    try {
      const insights = await fn({ force });
      res.json({ insights });
    } catch (err) {
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/settings/agent-usage/antigravity-insights', async (req, res) => {
    const force = req.query.fresh === '1';
    if (!deps.isInstalled('antigravity')) {
      res.status(404).json({ error: 'Antigravity CLI not installed' });
      return;
    }
    const fn = deps.probeAntigravityInsights ?? ((o) => probeAntigravityInsights(o));
    try {
      const insights = await fn({ force });
      res.json({ insights });
    } catch (err) {
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/settings/agent-usage/cursor-insights', async (req, res) => {
    const force = req.query.fresh === '1';
    const fn = deps.probeCursorInsights;
    if (!fn) {
      res.status(404).json({ error: 'Cursor insights not available' });
      return;
    }
    try {
      const insights = await fn({ force });
      res.json({ insights });
    } catch (err) {
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });
}

export async function buildAgentUsage(deps: AgentUsageDeps, force: boolean, only?: UsageAgentType): Promise<AgentUsageSnapshot[]> {
  const types = only ? ([only] as const) : AGENT_ORDER;
  const installed = types.map((type) => deps.isInstalled(type));
  const results = await Promise.allSettled(types.map((type, i) => {
    if (!installed[i]) return Promise.resolve(undefined);
    return probe(deps, type, force);
  }));

  const snapshots = types.map((type, i) => snapshotFor(type, installed[i], results[i]));
  return attachUsageProviders(snapshots, deps.listUsageProviders?.() ?? []);
}

/** Max chars of a probe error exposed to agent consumers. */
export const AGENT_USAGE_ERROR_MAX = 200;

/** Projected card for agent consumers (`GET /agent/usage`) — no routing/kind/plugin fields. */
export type { AgentUsageAgentView };

/** Allowlist projection: keeps only the fields agents may see, truncates probe errors. */
export function toAgentView(s: AgentUsageSnapshot): AgentUsageAgentView {
  const view: AgentUsageAgentView = {
    agentType: s.agentType,
    label: s.label,
    installed: s.installed,
    groups: s.groups,
  };
  if (s.subscriptionType !== undefined) view.subscriptionType = s.subscriptionType;
  if (s.updatedAt !== undefined) view.updatedAt = s.updatedAt;
  if (s.error !== undefined) {
    view.error = s.error.length > AGENT_USAGE_ERROR_MAX ? s.error.slice(0, AGENT_USAGE_ERROR_MAX) : s.error;
  }
  return view;
}

/** `GET /agent/usage` body: built-in probes only — provider cards dropped, allowlist projection.
 *  `only` limits probing to a single builtin (used by /agent/usage/:target). */
export function buildAgentUsageForAgent(deps: AgentUsageDeps, only?: UsageAgentType): Promise<AgentUsageAgentView[]> {
  return buildAgentUsage({ ...deps, listUsageProviders: undefined }, false, only).then((snapshots) =>
    snapshots.filter((s) => s.source === 'builtin').map(toAgentView),
  );
}

/**
 * Merge plugin usageProvider entries onto matching provider cards (same label),
 * or append pure-plugin providers. Built-in probe data stays on the card so the
 * UI can fall back without another endpoint when the plugin is unconfigured/errors.
 */
export function attachUsageProviders(
  snapshots: AgentUsageSnapshot[],
  providers: UsageProviderInfo[],
): AgentUsageSnapshot[] {
  const out = snapshots.map((s) => ({ ...s }));
  for (const p of providers) {
    const existing = out.find((s) => s.kind === 'provider' && s.label === p.label);
    if (existing) {
      existing.pluginId = p.id;
      existing.pluginCapability = p.capability;
      existing.pluginConfigured = p.configured;
      existing.builtinAvailable = builtinHasData(existing);
      // groups still hold built-in probe data; source stays 'builtin' until the UI re-points
    } else {
      out.push({
        agentType: p.id,
        label: p.label,
        kind: 'provider',
        source: 'plugin',
        installed: true,
        groups: [],
        pluginId: p.id,
        pluginCapability: p.capability,
        pluginConfigured: p.configured,
        builtinAvailable: false,
      });
    }
  }
  for (const s of out) {
    if (s.kind === 'provider' && s.builtinAvailable === undefined) {
      s.builtinAvailable = builtinHasData(s);
    }
  }
  return out;
}

function builtinHasData(s: AgentUsageSnapshot): boolean {
  return s.installed && !s.error && s.groups.length > 0;
}

function probe(
  deps: AgentUsageDeps,
  type: UsageAgentType,
  force: boolean,
): Promise<ProbedRateLimits | AgyUsageGroup[]> {
  if (type === 'antigravity') return deps.probeAgyGroups({ force });
  if (type === 'claude-code') return deps.probeClaude({ force });
  if (type === 'codex') return deps.probeCodex({ force });
  if (type === 'kiro') return deps.probeKiro({ force });
  if (type === 'copilot') return deps.probeCopilot?.({ force }) ?? Promise.resolve({});
  return deps.probeGrok({ force });
}

function snapshotFor(
  type: UsageAgentType,
  isInstalled: boolean,
  result: PromiseSettledResult<ProbedRateLimits | AgyUsageGroup[] | undefined>,
): AgentUsageSnapshot {
  const label = AGENT_LABELS[type];
  const kind = PROVIDER_AGENT_TYPES.has(type) ? 'provider' as const : 'agent' as const;
  const source = 'builtin' as const;
  if (!isInstalled) {
    return {
      agentType: type,
      label,
      kind,
      source,
      installed: false,
      installHint: INSTALL_HINTS[type],
      groups: [],
      builtinAvailable: false,
    };
  }

  if (result.status === 'rejected') {
    return {
      agentType: type,
      label,
      kind,
      source,
      installed: true,
      groups: [],
      error: String((result.reason as { message?: unknown })?.message ?? result.reason),
      builtinAvailable: false,
    };
  }

  const value = result.value;
  if (type === 'antigravity') {
    return fromAgyGroups(type, label, Array.isArray(value) ? value as AgyUsageGroup[] : []);
  }
  return fromLimits(type, label, (value ?? {}) as ProbedRateLimits);
}

function hasWindow(l: ProbedRateLimits): boolean {
  return l.fiveHourPct !== undefined
    || l.fiveHourResetsAt !== undefined
    || l.sevenDayPct !== undefined
    || l.sevenDayResetsAt !== undefined
    || l.monthlyPct !== undefined
    || l.monthlyResetsAt !== undefined
    || l.creditsUsed !== undefined
    || l.creditsLimit !== undefined
    || l.prepaidBalance !== undefined
    || l.onDemandUsed !== undefined
    || l.onDemandCap !== undefined
    || l.extraUsageUsed !== undefined
    || l.extraUsageLimit !== undefined
    || l.extraUsagePct !== undefined
    || l.manualResetsAvailable !== undefined
    || l.creditsBalance !== undefined
    || l.hasCredits !== undefined
    || l.unlimitedCredits !== undefined;
}

function toGroup(id: string, label: string, limits: ProbedRateLimits): AgentUsageGroup {
  const group: AgentUsageGroup = { id, label };
  if (limits.fiveHourPct !== undefined) group.fiveHourPct = limits.fiveHourPct;
  if (limits.fiveHourResetsAt !== undefined) group.fiveHourResetsAt = limits.fiveHourResetsAt;
  if (limits.sevenDayPct !== undefined) group.sevenDayPct = limits.sevenDayPct;
  if (limits.sevenDayResetsAt !== undefined) group.sevenDayResetsAt = limits.sevenDayResetsAt;
  if (limits.monthlyPct !== undefined) group.monthlyPct = limits.monthlyPct;
  if (limits.monthlyResetsAt !== undefined) group.monthlyResetsAt = limits.monthlyResetsAt;
  if (limits.creditsUsed !== undefined) group.creditsUsed = limits.creditsUsed;
  if (limits.creditsLimit !== undefined) group.creditsLimit = limits.creditsLimit;
  if (limits.prepaidBalance !== undefined) group.prepaidBalance = limits.prepaidBalance;
  if (limits.onDemandUsed !== undefined) group.onDemandUsed = limits.onDemandUsed;
  if (limits.onDemandCap !== undefined) group.onDemandCap = limits.onDemandCap;
  if (limits.extraUsageUsed !== undefined) group.extraUsageUsed = limits.extraUsageUsed;
  if (limits.extraUsageLimit !== undefined) group.extraUsageLimit = limits.extraUsageLimit;
  if (limits.extraUsagePct !== undefined) group.extraUsagePct = limits.extraUsagePct;
  if (limits.extraUsageCurrency !== undefined) group.extraUsageCurrency = limits.extraUsageCurrency;
  if (limits.manualResetsAvailable !== undefined) group.manualResetsAvailable = limits.manualResetsAvailable;
  if (limits.creditsBalance !== undefined) group.creditsBalance = limits.creditsBalance;
  if (limits.hasCredits !== undefined) group.hasCredits = limits.hasCredits;
  if (limits.unlimitedCredits !== undefined) group.unlimitedCredits = limits.unlimitedCredits;
  if (limits.longWindowLabel !== undefined) group.longWindowLabel = limits.longWindowLabel;
  return group;
}

function fromLimits(type: UsageAgentType, label: string, limits: ProbedRateLimits): AgentUsageSnapshot {
  const groups = hasWindow(limits) ? [toGroup('default', label, limits)] : [];
  const kind = PROVIDER_AGENT_TYPES.has(type) ? 'provider' as const : 'agent' as const;
  return {
    agentType: type,
    label,
    kind,
    source: 'builtin',
    installed: true,
    ...(limits.subscriptionType ? { subscriptionType: limits.subscriptionType } : {}),
    ...(groups.length > 0 ? { updatedAt: Date.now() } : {}),
    groups,
    builtinAvailable: groups.length > 0,
  };
}

function fromAgyGroups(type: UsageAgentType, label: string, agy: AgyUsageGroup[]): AgentUsageSnapshot {
  const groups = agy
    .filter((g) => hasWindow(g.limits))
    .map((g) => toGroup(g.id, g.label, g.limits));
  const subscriptionType = agy.map((g) => g.limits.subscriptionType).find((s) => !!s);
  return {
    agentType: type,
    label,
    kind: 'agent',
    source: 'builtin',
    installed: true,
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(groups.length > 0 ? { updatedAt: Date.now() } : {}),
    groups,
  };
}

// ---------------------------------------------------------------------------
// Unified /agent/usage aggregate — builtins + active usage-plugin providers.
// ---------------------------------------------------------------------------

/** Per-provider invoke ceiling (plan: ~5s). */
export const USAGE_PROVIDER_TIMEOUT_MS = 5_000;
/** Shared provider-card cache lifetime. */
export const USAGE_PROVIDER_CACHE_MS = 30_000;

/**
 * Narrow host surface the unified usage builder needs — tests stub this
 * instead of standing up a full PluginHost.
 */
export interface UsageProviderHost {
  listUsageProviders(): UsageProviderInfo[];
  invoke(
    pluginId: string,
    capability: string,
    input: unknown,
    caller: PluginCaller,
  ): Promise<PluginEnvelope<unknown>>;
  findUsageProviderForAgent?(agentType?: string, modelName?: string): { pluginId: string } | undefined;
}

interface ProviderCacheEntry {
  card: UsageProviderCard;
  expiresAt: number;
}

const providerCache = new Map<string, ProviderCacheEntry>();
const providerInFlight = new Map<string, Promise<UsageProviderCard>>();

/** Test hook — drop all cached cards and in-flight provider invokes. */
export function _resetUsageProviderCache(): void {
  providerCache.clear();
  providerInFlight.clear();
}

function truncateError(e: string): string {
  return e.length > AGENT_USAGE_ERROR_MAX ? `${e.slice(0, AGENT_USAGE_ERROR_MAX)}…` : e;
}

function timeoutCard(prov: UsageProviderInfo, fetchedAt: number): UsageProviderCard {
  return {
    id: prov.id,
    label: prov.label,
    configured: true,
    ok: false,
    code: 'timeout',
    error: `provider did not answer within ${USAGE_PROVIDER_TIMEOUT_MS / 1000}s`,
    fetchedAt,
  };
}

function cardFromEnvelope(
  prov: UsageProviderInfo,
  envelope: PluginEnvelope<unknown>,
  fetchedAt: number,
): UsageProviderCard {
  if (envelope.ok) {
    return { id: prov.id, label: prov.label, configured: true, ok: true, data: envelope.data, fetchedAt };
  }
  return {
    id: prov.id,
    label: prov.label,
    configured: true,
    ok: false,
    error: truncateError(envelope.error),
    code: envelope.code,
    fetchedAt,
  };
}

function rememberCard(provId: string, card: UsageProviderCard, now: () => number): void {
  const retryableFailure =
    !card.ok && !!card.code && card.code !== 'not_configured' && PLUGIN_ERROR_RETRYABLE[card.code];
  if (card.ok || !retryableFailure) {
    providerCache.set(provId, { card, expiresAt: now() + USAGE_PROVIDER_CACHE_MS });
  } else {
    providerCache.delete(provId);
  }
}

/** Race the raw invoke against the per-caller 5s ceiling. Never rejects.
 *  The underlying promise keeps running — do not cancel it from here. */
function withCardTimeout(prov: UsageProviderInfo, p: Promise<UsageProviderCard>): Promise<UsageProviderCard> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(timeoutCard(prov, Date.now())), USAGE_PROVIDER_TIMEOUT_MS);
    p.then(
      (card) => {
        clearTimeout(t);
        resolve(card);
      },
      () => {
        clearTimeout(t);
        resolve({
          id: prov.id,
          label: prov.label,
          configured: true,
          ok: false,
          error: 'provider invoke failed',
          code: 'upstream_error',
          fetchedAt: Date.now(),
        });
      },
    );
  });
}

/**
 * One card per active usage provider, cached for USAGE_PROVIDER_CACHE_MS with
 * in-flight dedupe on the RAW invoke (not the 5s race). A timeout card is
 * returned to the caller at 5s; the host invoke keeps running (15s cap) and
 * a late success is cached so the next call does not re-probe.
 */
function providerCardCached(
  host: UsageProviderHost,
  prov: UsageProviderInfo,
  caller: PluginCaller,
  now: () => number,
): Promise<UsageProviderCard> {
  const cached = providerCache.get(prov.id);
  if (cached && cached.expiresAt > now()) return Promise.resolve(cached.card);
  if (!prov.configured) {
    return Promise.resolve({
      id: prov.id,
      label: prov.label,
      configured: false,
      ok: false,
      code: 'not_configured',
      error: 'plugin credentials not configured',
      fetchedAt: now(),
    });
  }
  let flight = providerInFlight.get(prov.id);
  if (!flight) {
    const fetchedAt = now();
    flight = host.invoke(prov.id, prov.capability, {}, caller)
      .then(
        (env) => cardFromEnvelope(prov, env, fetchedAt),
        () => ({
          id: prov.id,
          label: prov.label,
          configured: true,
          ok: false,
          error: 'provider invoke failed',
          code: 'upstream_error' as const,
          fetchedAt,
        }),
      )
      .then((card) => {
        rememberCard(prov.id, card, now);
        return card;
      })
      .finally(() => {
        providerInFlight.delete(prov.id);
      });
    providerInFlight.set(prov.id, flight);
  }
  return withCardTimeout(prov, flight);
}

export async function buildProviderCards(
  host: UsageProviderHost,
  caller: PluginCaller,
  now: () => number = Date.now,
): Promise<UsageProviderCard[]> {
  // Dedupe by id (first wins) — a mis-registered provider entry must not
  // double a card into the aggregate.
  const seen = new Set<string>();
  const providers = host.listUsageProviders().filter((prov) => {
    if (seen.has(prov.id)) return false;
    seen.add(prov.id);
    return true;
  });
  return Promise.all(providers.map((prov) => providerCardCached(host, prov, caller, now)));
}

/** Builtin agent type? (usage providers are matched by plugin id instead) */
export function isBuiltinUsageTarget(target: string): boolean {
  return (AGENT_ORDER as readonly string[]).includes(target);
}

/** Probe a single built-in agent — same shape as the aggregate cards. */
export async function buildOneAgentUsage(
  deps: AgentUsageDeps,
  type: UsageAgentType,
): Promise<AgentUsageAgentView> {
  const views = await buildAgentUsageForAgent(deps, type);
  return (
    views.find((v) => v.agentType === type) ?? {
      agentType: type,
      label: type,
      installed: false,
      groups: [],
    }
  );
}

/** All valid /agent/usage/:target ids, builtins first. */
export function usageTargetIds(host: Pick<UsageProviderHost, 'listUsageProviders'>): string[] {
  return [...AGENT_ORDER, ...host.listUsageProviders().map((p) => p.id)];
}

export async function buildUnifiedUsage(
  deps: AgentUsageDeps,
  host: UsageProviderHost,
  caller: PluginCaller,
): Promise<UnifiedUsageBody> {
  const [builtins, providers] = await Promise.all([
    buildAgentUsageForAgent(deps),
    buildProviderCards(host, caller),
  ]);
  const stamped = stampUsageProfiles(
    { builtins, providers },
    {
      listProfiles: () => catalogue.listProfiles(),
      findUsageProviderForAgent: (a, m) => host.findUsageProviderForAgent?.(a, m),
    },
  );
  return { builtins: stamped.builtins, providers: stamped.providers, updatedAt: Date.now(), agents: stamped.builtins };
}

export type UsageTargetResult =
  | { kind: 'builtin'; status: 200; body: { builtin: AgentUsageAgentView; updatedAt: number } }
  | { kind: 'provider'; status: number; body: { provider: UsageProviderCard; updatedAt: number } }
  | { kind: 'unknown'; status: 404; body: { error: string; targets: string[] } };

/** Build one usage target: a single builtin probe or a single provider card. */
export async function buildUsageTarget(
  target: string,
  deps: AgentUsageDeps,
  host: UsageProviderHost,
  caller: PluginCaller,
): Promise<UsageTargetResult> {
  if (isBuiltinUsageTarget(target)) {
    const builtin = await buildOneAgentUsage(deps, target as UsageAgentType);
    const stamped = stampUsageProfiles(
      { builtins: [builtin], providers: [] },
      {
        listProfiles: () => catalogue.listProfiles(),
        findUsageProviderForAgent: (a, m) => host.findUsageProviderForAgent?.(a, m),
      },
    );
    return { kind: 'builtin', status: 200, body: { builtin: stamped.builtins[0], updatedAt: Date.now() } };
  }
  const prov = host.listUsageProviders().find((p) => p.id === target);
  if (!prov) {
    return {
      kind: 'unknown',
      status: 404,
      body: { error: 'unknown usage target', targets: usageTargetIds(host) },
    };
  }
  const card = await providerCardCached(host, prov, caller, Date.now);
  // 'not_configured' is a provider-card code, not a PluginErrorCode — map it to
  // credential_missing's status (503) explicitly.
  const status = card.ok
    ? 200
    : card.code === 'not_configured'
      ? 503
      : PLUGIN_ERROR_HTTP_STATUS[card.code ?? 'upstream_error'] ?? 502;
  const stamped = stampUsageProfiles(
    { builtins: [], providers: [card] },
    {
      listProfiles: () => catalogue.listProfiles(),
      findUsageProviderForAgent: (a, m) => host.findUsageProviderForAgent?.(a, m),
    },
  );
  return { kind: 'provider', status, body: { provider: stamped.providers[0], updatedAt: Date.now() } };
}
