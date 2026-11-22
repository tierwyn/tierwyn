import { useEffect, useState } from 'react';
import type { AgentUsageGroup, AgentUsageSnapshot, DecisionUsageSummary, UsageDataSource } from '@tierwyn/shared';
import { api } from '../api.js';
import { ago, AllowanceRows, RefreshIcon } from './usageBars.js';
import { Modal } from './Modal.js';
import { lsGet } from '../prefixedStorage.js';
import { ClaudeInsightsModal } from './ClaudeInsightsModal.js';
import { CodexInsightsModal } from './CodexInsightsModal.js';
import { AntigravityInsightsModal } from './AntigravityInsightsModal.js';
import { CursorInsightsModal } from './CursorInsightsModal.js';

const STORAGE_KEY = 'tierwyn.cache.agentUsage';
const CACHE_TTL_MS = 60_000;

function readPersistedAgentUsage(): { data: AgentUsageSnapshot[]; at: number } | null {
  try {
    const raw = lsGet(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.data) && typeof parsed.at === 'number') {
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

const initialCache = readPersistedAgentUsage();
let cachedAgentUsage: AgentUsageSnapshot[] | null = initialCache?.data ?? null;
let cachedAgentUsageFetchedAt = initialCache?.at ?? 0;

/** Map zai-usage / cursor-usage `usage.get` (and similar) payload onto card groups. */
function applyPluginQuota(
  snap: AgentUsageSnapshot,
  data: unknown,
): AgentUsageSnapshot {
  const d = (data && typeof data === 'object' && !Array.isArray(data))
    ? data as Record<string, unknown>
    : {};
  const group: AgentUsageGroup = { id: 'default', label: snap.label };
  if (typeof d.fiveHourPct === 'number') group.fiveHourPct = d.fiveHourPct;
  if (typeof d.fiveHourResetsAt === 'number') group.fiveHourResetsAt = d.fiveHourResetsAt;
  if (typeof d.sevenDayPct === 'number') group.sevenDayPct = d.sevenDayPct;
  if (typeof d.sevenDayResetsAt === 'number') group.sevenDayResetsAt = d.sevenDayResetsAt;
  if (typeof d.monthlyPct === 'number') group.monthlyPct = d.monthlyPct;
  if (typeof d.monthlyResetsAt === 'number') group.monthlyResetsAt = d.monthlyResetsAt;
  if (typeof d.creditsUsed === 'number') group.creditsUsed = d.creditsUsed;
  if (typeof d.creditsLimit === 'number') group.creditsLimit = d.creditsLimit;
  if (typeof d.onDemandUsed === 'number') group.onDemandUsed = d.onDemandUsed;
  if (typeof d.onDemandCap === 'number') group.onDemandCap = d.onDemandCap;
  if (typeof d.monthlyWindowLabel === 'string') group.monthlyWindowLabel = d.monthlyWindowLabel;
  if (typeof d.longWindowLabel === 'string') group.longWindowLabel = d.longWindowLabel;
  const hasWindow = group.fiveHourPct !== undefined
    || group.fiveHourResetsAt !== undefined
    || group.sevenDayPct !== undefined
    || group.sevenDayResetsAt !== undefined
    || group.monthlyPct !== undefined
    || group.monthlyResetsAt !== undefined
    || group.creditsUsed !== undefined
    || group.creditsLimit !== undefined
    || group.onDemandUsed !== undefined
    || group.onDemandCap !== undefined;
  const plan = typeof d.plan === 'string' ? d.plan
    : typeof d.subscriptionType === 'string' ? d.subscriptionType
    : undefined;
  const updatedAt = typeof d.fetchedAt === 'number' ? d.fetchedAt : Date.now();

  let groups: AgentUsageGroup[] = [];
  if (Array.isArray(d.groups) && d.groups.length > 0) {
    groups = d.groups as AgentUsageGroup[];
  } else if (hasWindow) {
    groups = [group];
  }

  const hasAnyQuota = groups.length > 0;

  return {
    ...snap,
    source: 'plugin',
    groups,
    ...(plan ? { subscriptionType: plan } : {}),
    ...(hasAnyQuota ? { updatedAt } : {}),
    error: undefined,
  };
}

/**
 * Prefer plugin capability data when the listing says the plugin is configured.
 * On credential_missing / error, keep the built-in probe groups already on the
 * snapshot and leave source as 'builtin' (or mark plugin when only that path exists).
 */
async function resolveProviderSources(rows: AgentUsageSnapshot[]): Promise<AgentUsageSnapshot[]> {
  return Promise.all(rows.map(async (snap) => {
    const kind = snap.kind ?? 'agent';
    if (kind !== 'provider') return { ...snap, kind: kind as AgentUsageSnapshot['kind'], source: snap.source ?? 'builtin' };

    const wantsPlugin = Boolean(snap.pluginId && snap.pluginCapability && snap.pluginConfigured);
    if (!wantsPlugin) {
      const source: UsageDataSource = snap.builtinAvailable || (snap.groups?.length ?? 0) > 0
        ? 'builtin'
        : (snap.source ?? 'builtin');
      return { ...snap, kind: 'provider', source };
    }

    try {
      const envelope = await api.invokePluginCapability(snap.pluginId!, snap.pluginCapability!);
      if (envelope.ok) {
        return applyPluginQuota({ ...snap, kind: 'provider' }, envelope.data);
      }
      // credential_missing / upstream_error / etc. → fall back to builtin data in the listing
      if (snap.builtinAvailable || (snap.groups?.length ?? 0) > 0) {
        return {
          ...snap,
          kind: 'provider',
          source: 'builtin' as const,
          // keep builtin groups; drop plugin error so the card isn't a dead red row
          error: snap.error,
        };
      }
      return {
        ...snap,
        kind: 'provider',
        source: 'plugin' as const,
        error: envelope.error || snap.error,
        groups: [],
      };
    } catch (e) {
      if (snap.builtinAvailable || (snap.groups?.length ?? 0) > 0) {
        return { ...snap, kind: 'provider', source: 'builtin' as const };
      }
      return {
        ...snap,
        kind: 'provider',
        source: 'plugin' as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }));
}

const usd = (n: number) => n === 0 ? '$0' : n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`;

/** Pay-per-token ledger block (built-in Jev card). Reuses the usage-* classes; no allowance bars. */
function SpendRows({ spend }: { spend: DecisionUsageSummary }) {
  return (
    <div className="usage-rows">
      <div className="usage-row">
        <span className="usage-row-label">{spend.windowLabel}</span>
        <span className="usage-row-value">
          {spend.calls.toLocaleString()} calls · {spend.inputTokens.toLocaleString()} input tokens · {usd(spend.costUsd)}
        </span>
      </div>
      {spend.byConsumer.map((c) => (
        <div className="usage-row" key={c.consumer}>
          <span className="usage-row-label">{c.consumer}</span>
          <span className="usage-row-value">
            {c.calls.toLocaleString()} calls · {c.inputTokens.toLocaleString()} tok · {usd(c.costUsd)}
          </span>
        </div>
      ))}
      {spend.errors.length > 0 && (
        <div className="usage-note">Failures: {spend.errors.map((e) => `${e.outcome} ×${e.count}`).join(' · ')}</div>
      )}
      {spend.missingUsage > 0 && (
        <div className="usage-note">{spend.missingUsage.toLocaleString()} calls returned no usage figures</div>
      )}
    </div>
  );
}

function sourceBadgeLabel(source: UsageDataSource | undefined): string {
  return source === 'plugin' ? 'plugin' : 'built-in';
}

interface AgentUsageSettingsProps {
  embedded?: boolean;
  asModal?: boolean;
  onClose?: () => void;
}

export function AgentUsageSettings({ embedded, asModal, onClose }: AgentUsageSettingsProps = {}) {
  const [agents, setAgents] = useState<AgentUsageSnapshot[] | null>(cachedAgentUsage);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showClaudeInsights, setShowClaudeInsights] = useState(false);
  const [showCodexInsights, setShowCodexInsights] = useState(false);
  const [showAntigravityInsights, setShowAntigravityInsights] = useState(false);
  const [showCursorInsights, setShowCursorInsights] = useState(false);
  const [, setTick] = useState(0);

  const fetchUsage = (fresh = false) => {
    setRefreshing(true);
    api.agentUsage(fresh)
      .then((rows) => resolveProviderSources(rows))
      .then((rows) => {
        cachedAgentUsage = rows;
        cachedAgentUsageFetchedAt = Date.now();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: cachedAgentUsageFetchedAt, data: rows }));
        } catch { /* ignore quota */ }
        setAgents(rows);
        setError('');
      })
      .catch((e: Error) => {
        setError(e.message);
      })
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    const isFresh = cachedAgentUsage && (Date.now() - cachedAgentUsageFetchedAt < CACHE_TTL_MS);
    if (!isFresh) {
      fetchUsage(false);
    }
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, []);

  const updatedAt = agents?.reduce((max, a) => Math.max(max, a.updatedAt ?? 0), 0) ?? 0;
  const agentCards = agents?.filter((s) => (s.kind ?? 'agent') === 'agent') ?? [];
  const providerCards = agents?.filter((s) => s.kind === 'provider') ?? [];

  const renderCard = (snap: AgentUsageSnapshot) => (
    <div className="settings-card active" key={snap.agentType}>
      <div className="settings-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="settings-card-title-group">
          <span className="settings-card-title">{snap.label}</span>
          {snap.subscriptionType && (
            <span className="usage-plan-badge">{snap.subscriptionType}</span>
          )}
          {snap.kind === 'provider' && (
            <span className="usage-source-badge" title={`Data source: ${sourceBadgeLabel(snap.source)}`}>
              {sourceBadgeLabel(snap.source)}
            </span>
          )}
        </div>
        {snap.agentType === 'claude-code' && snap.installed && (
          <button
            type="button"
            className="modal-btn accent"
            style={{ fontSize: '11px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            onClick={() => setShowClaudeInsights(true)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M18 17V9" />
              <path d="M13 17V5" />
              <path d="M8 17v-3" />
            </svg>
            Insights & Activity
          </button>
        )}
        {snap.agentType === 'codex' && snap.installed && (
          <button
            type="button"
            className="modal-btn accent"
            style={{ fontSize: '11px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            onClick={() => setShowCodexInsights(true)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M18 17V9" />
              <path d="M13 17V5" />
              <path d="M8 17v-3" />
            </svg>
            Insights & Activity
          </button>
        )}
        {snap.agentType === 'antigravity' && snap.installed && (
          <button
            type="button"
            className="modal-btn accent"
            style={{ fontSize: '11px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            onClick={() => setShowAntigravityInsights(true)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M18 17V9" />
              <path d="M13 17V5" />
              <path d="M8 17v-3" />
            </svg>
            Insights & Activity
          </button>
        )}
        {(snap.agentType === 'cursor' || snap.agentType === 'cursor-usage') && (snap.installed || snap.kind === 'provider') && (
          <button
            type="button"
            className="modal-btn accent"
            style={{ fontSize: '11px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            onClick={() => setShowCursorInsights(true)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M18 17V9" />
              <path d="M13 17V5" />
              <path d="M8 17v-3" />
            </svg>
            Insights & Activity
          </button>
        )}
      </div>
      <div className="settings-card-body">
        {!snap.installed && !(snap.kind === 'provider' && (snap.pluginConfigured || snap.builtinAvailable)) && (
          <div className="usage-note">{snap.installHint}</div>
        )}
        {snap.installed && snap.error && (
          <div className="usage-error">{snap.error}</div>
        )}
        {!snap.installed && snap.kind === 'provider' && snap.error && (
          <div className="usage-error">{snap.error}</div>
        )}
        {(snap.installed || snap.kind === 'provider') && !snap.error && snap.groups.length === 0 && !snap.spend && (
          <div className="usage-note">
            {snap.kind === 'provider' && snap.pluginConfigured === false && !snap.builtinAvailable
              ? 'Provider not configured — set the dedicated API key in the env file and restart.'
              : 'No allowance data — the CLI may not be signed in.'}
          </div>
        )}
        {snap.spend && <SpendRows spend={snap.spend} />}
        {snap.groups.map((group) => (
          <div key={group.id}>
            {snap.groups.length > 1 && (
              <div className="usage-section-label">{group.label}</div>
            )}
            <AllowanceRows
              fiveHourPct={group.fiveHourPct}
              fiveHourResetsAt={group.fiveHourResetsAt}
              sevenDayPct={group.sevenDayPct}
              sevenDayResetsAt={group.sevenDayResetsAt}
              monthlyPct={group.monthlyPct}
              monthlyResetsAt={group.monthlyResetsAt}
              creditsUsed={group.creditsUsed}
              creditsLimit={group.creditsLimit}
              prepaidBalance={group.prepaidBalance}
              onDemandUsed={group.onDemandUsed}
              onDemandCap={group.onDemandCap}
              extraUsageUsed={group.extraUsageUsed}
              extraUsageLimit={group.extraUsageLimit}
              extraUsagePct={group.extraUsagePct}
              extraUsageCurrency={group.extraUsageCurrency}
              manualResetsAvailable={group.manualResetsAvailable}
              creditsBalance={group.creditsBalance}
              hasCredits={group.hasCredits}
              unlimitedCredits={group.unlimitedCredits}
              longWindowLabel={group.longWindowLabel ?? (snap.agentType === 'grok-build' ? 'weekly window used' : undefined)}
              monthlyWindowLabel={group.monthlyWindowLabel}
            />
          </div>
        ))}
      </div>
    </div>
  );

  const content = (
    <>
      {showClaudeInsights && (
        <ClaudeInsightsModal onClose={() => setShowClaudeInsights(false)} />
      )}
      {showCodexInsights && (
        <CodexInsightsModal onClose={() => setShowCodexInsights(false)} />
      )}
      {showAntigravityInsights && (
        <AntigravityInsightsModal onClose={() => setShowAntigravityInsights(false)} />
      )}
      {showCursorInsights && (
        <CursorInsightsModal onClose={() => setShowCursorInsights(false)} />
      )}

      {error && <div className="usage-error">{error}</div>}

      {!agents && !error && (
        <div className="usage-loading">loading…</div>
      )}

      {agents && agentCards.length > 0 && (
        <>
          <div className="usage-section-label">Agent quotas</div>
          {agentCards.map(renderCard)}
        </>
      )}

      {agents && providerCards.length > 0 && (
        <>
          <div className="usage-section-label" style={{ marginTop: 12 }}>Providers</div>
          {providerCards.map(renderCard)}
        </>
      )}
    </>
  );

  if (asModal || (embedded && onClose)) {
    return (
      <Modal
        title="Usage Credits"
        onClose={onClose!}
        className="agent-usage-modal"
        headerActions={(
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {updatedAt > 0 && (
              <span className="usage-row-label" style={{ fontSize: '11px' }}>
                {ago(updatedAt)}
              </span>
            )}
            <button
              type="button"
              className={`usage-refresh-btn${refreshing ? ' spinning' : ''}`}
              onClick={() => fetchUsage(true)}
              disabled={refreshing}
              title="Refresh — re-reads live rate-limit data"
              aria-label="Refresh usage credits"
            >
              <RefreshIcon size={13} />
            </button>
          </div>
        )}
      >
        <div className="settings-section">
          {content}
        </div>
      </Modal>
    );
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Usage Credits
        {updatedAt > 0 && (
          <span className="usage-row-label"> · {ago(updatedAt)}</span>
        )}
        <button
          className={`usage-refresh-btn${refreshing ? ' spinning' : ''}`}
          onClick={() => fetchUsage(true)}
          disabled={refreshing}
          title="Refresh — re-reads live rate-limit data"
          aria-label="Refresh usage credits"
        >
          <RefreshIcon size={13} />
        </button>
      </div>

      {content}
    </div>
  );
}
