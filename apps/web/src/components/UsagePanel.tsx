import { useEffect, useRef, useState } from 'react';
import { coalesceConversationUsage, type ConversationUsage } from '@tierwyn/shared';
import { api } from '../api.js';
import { fmt, ago, Bar, AllowanceRows, fmtPct, RefreshIcon } from './usageBars.js';
import { storageGet } from '../prefixedStorage.js';

interface Props {
  conversationId: string;
  onClose: () => void;
  agentType?: string; // active agent for this conversation, from App
  /** True while the agent is actively working on a turn. */
  isRunning?: boolean;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function KiroContextBreakdown({ breakdown }: {
  breakdown: NonNullable<ConversationUsage['contextBreakdown']>;
}): JSX.Element {
  const rows: Array<[string, number | undefined]> = [
    ['Context files', breakdown.filesPct],
    ['Tools', breakdown.toolsPct],
    ['Kiro responses', breakdown.responsesPct],
    ['Your prompts', breakdown.promptsPct],
  ];
  return (
    <div className="usage-rows">
      {rows.filter(([, v]) => v !== undefined).map(([label, value]) => (
        <div className="usage-row" key={label}>
          <span className="usage-row-label">{label}</span>
          <span className="usage-row-value">{fmtPct(value as number)}</span>
        </div>
      ))}
    </div>
  );
}

const conversationUsageCache = new Map<string, ConversationUsage>();

function humanize(t: string): string {
  return t.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getPersistedUsage(cid: string): ConversationUsage | null {
  const mem = conversationUsageCache.get(cid);
  if (mem) return mem;
  try {
    const raw = storageGet(sessionStorage, `tierwyn.cache.usage.${cid}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        conversationUsageCache.set(cid, parsed);
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function UsagePanel({ conversationId, onClose, agentType, isRunning = false }: Props) {
  const [usage, setUsage] = useState<ConversationUsage | null>(() => getPersistedUsage(conversationId));
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const fetchGen = useRef(0);

  const isClaude = (agentType ?? usage?.agentType) === 'claude-code';
  const isGrok = (agentType ?? usage?.agentType) === 'grok-build';
  const isKiro = (agentType ?? usage?.agentType) === 'kiro';
  const isEstimated = usage?.tokensEstimated === true;
  const isLiveEstimate = isRunning && isEstimated;
  const supportsCtx = usage?.supportsContextWindow === true;
  const supportsRL = usage?.supportsRateLimits === true;
  const ctxPct = usage?.contextWindowPct;
  const ctxSize = usage?.contextWindowSize;
  // What the usage is for: the reporting agent's display name (server label,
  // falling back to the conversation's selected agent before first fetch).
  const usageSource = usage?.usageSource ?? (agentType ? humanize(agentType) : undefined);
  // Agent subscription (e.g. Pro, Team) is distinct from provider subscriptions (e.g. Z.AI Lite).
  // If an old cached session duplicated the provider plan into subscriptionType, suppress it from the header.
  const agentSubscription = usage?.subscriptionType &&
    (!usage.providerSubscriptionType || usage.subscriptionType.toLowerCase() !== usage.providerSubscriptionType.toLowerCase())
      ? usage.subscriptionType
      : undefined;

  const fetchUsage = (opts?: { silent?: boolean; fresh?: boolean }) => {
    const gen = ++fetchGen.current;
    if (!opts?.silent) setRefreshing(true);
    // Manual (non-silent) refresh bypasses the server's probe cache for a live pull.
    api.conversationUsage(conversationId, opts?.fresh ?? !opts?.silent)
      .then((data) => {
        if (gen !== fetchGen.current) return;
        setUsage((prev) => {
          const merged = coalesceConversationUsage(prev, data);
          conversationUsageCache.set(conversationId, merged);
          try {
            sessionStorage.setItem(`tierwyn.cache.usage.${conversationId}`, JSON.stringify(merged));
          } catch { /* ignore */ }
          return merged;
        });
      })
      .catch((e: Error) => { if (gen === fetchGen.current) setError(e.message); })
      .finally(() => { if (!opts?.silent && gen === fetchGen.current) setRefreshing(false); });
  };

  useEffect(() => {
    fetchGen.current += 1; // drop in-flight polls from the previous conversation
    const cached = getPersistedUsage(conversationId);
    if (cached) {
      setUsage(cached);
    }
    fetchUsage({ silent: Boolean(cached) });
  }, [conversationId]);

  // Poll while a turn is in progress so live estimates tick upward.
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => fetchUsage({ silent: true }), 3000);
    return () => clearInterval(id);
  }, [isRunning, conversationId]);

  // One final fetch when a turn completes so reported counts replace live estimates.
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) fetchUsage({ silent: true });
    wasRunningRef.current = isRunning;
  }, [isRunning, conversationId]);

  return (
    <div className="usage-panel-overlay" onClick={onClose}>
      <div className="usage-panel" onClick={(e) => e.stopPropagation()}>
        <div className="usage-panel-header">
          <span>
            Usage · this conversation
            {usageSource && (
              <span
                className="usage-source-badge"
                title={`Usage is reported for ${usageSource}`}
              >
                {usageSource}
              </span>
            )}
            {agentSubscription && (
              <span
                className="usage-plan-badge"
                title={`Agent subscription tier: ${agentSubscription}`}
              >
                {agentSubscription}
              </span>
            )}
          </span>
          <span className="usage-panel-actions">
            <button
              className={`usage-refresh-btn${refreshing ? ' spinning' : ''}`}
              onClick={() => fetchUsage()}
              disabled={refreshing}
              title="Refresh — re-reads live usage and rate-limit data"
              aria-label="Refresh usage"
            >
              <RefreshIcon size={12} />
            </button>
            <button className="usage-close" onClick={onClose}>✕</button>
          </span>
        </div>

        {error && <div className="usage-error">{error}</div>}

        {!usage && !error && (
          <div className="usage-loading">loading…</div>
        )}

        {usage && (
          <div className="usage-body">

            {/* Cache status pill */}
            {isClaude && (
              <div className="usage-cache-badge" data-cached={usage.isCached}>
                {usage.isCached ? '✓ prompt cache active' : '○ not cached'}
              </div>
            )}

            {/* Token breakdown */}
            <div className="usage-section-label">
              tokens
              {isLiveEstimate && (
                <span className="usage-estimated-badge">live ~ estimated</span>
              )}
              {!isRunning && isEstimated && (
                <span className="usage-estimated-badge">~ estimated</span>
              )}
              {!isRunning && !isEstimated && usage.totalInputTokens + usage.outputTokens > 0 && (
                <span className="usage-reported-badge">reported</span>
              )}
            </div>
            <div className="usage-rows">
              <div className="usage-row">
                <span className="usage-row-label">input</span>
                <span className="usage-row-value">
                  {isEstimated ? '~' : ''}{fmt(usage.totalInputTokens)}
                </span>
              </div>
              <div className="usage-row">
                <span className="usage-row-label">output</span>
                <span className="usage-row-value">
                  {isEstimated ? '~' : ''}{fmt(usage.outputTokens)}
                </span>
              </div>
            </div>
            {isEstimated && (
              <div className="usage-note">
                {isLiveEstimate
                  ? 'Live tokenizer estimate from visible prompt, assistant text, and tool I/O. Output updates every few seconds; final numbers may differ.'
                  : 'Tokenizer estimate — the agent did not report token counts. System context and hidden prompt overhead are not included.'}
              </div>
            )}

            {/* Cache breakdown */}
            {(usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) && (
              <>
                <div className="usage-section-label">input breakdown</div>
                <div className="usage-rows">
                  <div className="usage-row">
                    <span className="usage-row-label">cache read</span>
                    <span className="usage-row-value accent-green">{fmt(usage.cacheReadTokens)}</span>
                  </div>
                  <div className="usage-row">
                    <span className="usage-row-label">cache write</span>
                    <span className="usage-row-value accent-amber">{fmt(usage.cacheCreationTokens)}</span>
                  </div>
                  <div className="usage-row">
                    <span className="usage-row-label">uncached</span>
                    <span className="usage-row-value accent-red">{fmt(usage.uncachedInputTokens)}</span>
                  </div>
                </div>
              </>
            )}

            {/* Cache ratio bar */}
            {(usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) && usage.inputTokens > 0 && (
              <>
                <div className="usage-bar-label">
                  <span>cache hit rate</span>
                  <span>{pct(usage.cachedRatio)}</span>
                </div>
                <Bar ratio={usage.cachedRatio} color="" reverse />
              </>
            )}

            {/* Context window */}
            {supportsCtx && ctxPct !== undefined && (
              <>
                <div className="usage-section-label">context window</div>
                <div className="usage-bar-label">
                  <span>used</span>
                  <span>
                    {fmtPct(ctxPct)}
                    {ctxSize !== undefined && (
                      <span className="usage-row-label"> · ~{fmt(Math.round((ctxPct / 100) * ctxSize))} / {fmt(ctxSize)}</span>
                    )}
                  </span>
                </div>
                <Bar ratio={ctxPct / 100} color="" allowance />
                {isKiro && usage.contextBreakdown && (
                  <KiroContextBreakdown breakdown={usage.contextBreakdown} />
                )}
              </>
            )}
            {supportsCtx && ctxPct === undefined && (
              <>
                <div className="usage-section-label">context window</div>
                <div className="usage-note">Waiting for the first turn to report context usage…</div>
                {isKiro && usage.contextBreakdown && (
                  <KiroContextBreakdown breakdown={usage.contextBreakdown} />
                )}
              </>
            )}

            {/* Rate limits */}
            {supportsRL && (usage.fiveHourPct !== undefined || usage.fiveHourResetsAt !== undefined ||
              usage.sevenDayPct !== undefined || usage.sevenDayResetsAt !== undefined ||
              usage.monthlyPct !== undefined || usage.monthlyResetsAt !== undefined ||
              usage.creditsUsed !== undefined || usage.creditsLimit !== undefined ||
              usage.prepaidBalance !== undefined || usage.onDemandUsed !== undefined ||
              usage.onDemandCap !== undefined || usage.extraUsageUsed !== undefined ||
              usage.extraUsageLimit !== undefined || usage.extraUsagePct !== undefined ||
              usage.manualResetsAvailable !== undefined || usage.creditsBalance !== undefined ||
              usage.hasCredits !== undefined || usage.unlimitedCredits !== undefined) && (
              <>
                <div className="usage-section-label">
                  allowance
                  {usage.usageProvider && (
                    <span className="usage-row-label"> · {usage.usageProvider}</span>
                  )}
                  {usage.providerSubscriptionType && (
                    <span
                      className="usage-plan-badge"
                      style={{ marginLeft: 2 }}
                      title={`Provider subscription plan: ${usage.providerSubscriptionType}`}
                    >
                      {usage.providerSubscriptionType}
                    </span>
                  )}
                  {usage.rateLimitsUpdatedAt && (
                    <span className="usage-row-label"> · {ago(usage.rateLimitsUpdatedAt)}</span>
                  )}
                  <button
                    className={`usage-refresh-btn${refreshing ? ' spinning' : ''}`}
                    onClick={() => fetchUsage()}
                    disabled={refreshing}
                    title="Refresh — re-reads live rate-limit + subscription data"
                  >
                    <RefreshIcon size={12} />
                  </button>
                </div>
                <AllowanceRows
                  // Grok has weekly credits only — never show a 5h bar even if
                  // a prior agent in this conversation left fiveHourPct cached.
                  fiveHourPct={isGrok ? undefined : usage.fiveHourPct}
                  fiveHourResetsAt={isGrok ? undefined : usage.fiveHourResetsAt}
                  sevenDayPct={usage.sevenDayPct}
                  sevenDayResetsAt={usage.sevenDayResetsAt}
                  monthlyPct={usage.monthlyPct}
                  monthlyResetsAt={usage.monthlyResetsAt}
                  creditsUsed={usage.creditsUsed}
                  creditsLimit={usage.creditsLimit}
                  prepaidBalance={usage.prepaidBalance}
                  onDemandUsed={usage.onDemandUsed}
                  onDemandCap={usage.onDemandCap}
                  extraUsageUsed={usage.extraUsageUsed}
                  extraUsageLimit={usage.extraUsageLimit}
                  extraUsagePct={usage.extraUsagePct}
                  extraUsageCurrency={usage.extraUsageCurrency}
                  manualResetsAvailable={usage.manualResetsAvailable}
                  creditsBalance={usage.creditsBalance}
                  hasCredits={usage.hasCredits}
                  unlimitedCredits={usage.unlimitedCredits}
                  longWindowLabel={usage.longWindowLabel ?? (isGrok ? 'weekly window used' : undefined)}
                  monthlyWindowLabel={usage.monthlyWindowLabel}
                />
              </>
            )}

            {/* Cost / credits */}
            <div className="usage-section-label">{isKiro ? 'credits' : 'cost'}</div>
            <div className="usage-rows">
              <div className="usage-row">
                <span className="usage-row-label">total</span>
                <span className="usage-row-value">
                  {isKiro ? `${usage.costUsd.toFixed(4)} credits` : `$${usage.costUsd.toFixed(4)}`}
                </span>
              </div>
              <div className="usage-row">
                <span className="usage-row-label">sessions</span>
                <span className="usage-row-value">{usage.sessionCount}</span>
              </div>
            </div>
            {isKiro && (
              <div className="usage-note">
                Per-turn metering is credits, not USD, and is not monthly plan remaining.
              </div>
            )}

            {!supportsCtx && (
              <div className="usage-note">
                This agent does not report context-window usage.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
