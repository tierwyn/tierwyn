import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CursorInsights } from "@tierwyn/shared";
import { api } from "../api.js";
import { ago, AllowanceRows, Bar, RefreshIcon } from "./usageBars.js";
import { lsGet } from "../prefixedStorage.js";

interface Props {
  onClose: () => void;
}

const STORAGE_KEY = "tierwyn.cache.cursorInsights";
const CACHE_TTL_MS = 60_000;

function readPersistedCursorInsights(): { data: CursorInsights; at: number } | null {
  try {
    const raw = lsGet(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.data === "object" && typeof parsed.at === "number") {
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

const initialCache = readPersistedCursorInsights();
let cachedCursorInsights: CursorInsights | null = initialCache?.data ?? null;
let cachedCursorInsightsFetchedAt = initialCache?.at ?? 0;

type SubTab = "activity" | "daily" | "quotas";

function fmtDate(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: "8px",
        background: "var(--bg-2)",
        border: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "4px"
      }}
    >
      <span className="usage-row-label" style={{ fontSize: "11px", textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontSize: "18px", fontWeight: 700, color: "var(--text-1)" }}>
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

export function CursorInsightsModal({ onClose }: Props) {
  const [insights, setInsights] = useState<CursorInsights | null>(cachedCursorInsights);
  const [loading, setLoading] = useState(!cachedCursorInsights);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<SubTab>("activity");

  const load = async (fresh = false) => {
    if (fresh) setRefreshing(true);
    else if (!cachedCursorInsights) setLoading(true);
    try {
      const res = await api.cursorInsights(fresh);
      cachedCursorInsights = res;
      cachedCursorInsightsFetchedAt = Date.now();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: cachedCursorInsightsFetchedAt, data: res }));
      } catch { /* ignore quota */ }
      setInsights(res);
      setError("");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const isFresh = cachedCursorInsights && (Date.now() - cachedCursorInsightsFetchedAt < CACHE_TTL_MS);
    if (!isFresh) {
      void load(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = insights?.groups ?? [];
  const dailySpend = insights?.dailySpend ?? [];
  const act = insights?.activitySummary;

  return createPortal(
    <div className="modal-overlay modal-overlay--top" onClick={onClose}>
      <div className="modal-content insights-modal-shell" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="insights-modal-header">
          <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)" }}>
            Cursor · Activity & Insights
          </span>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Toolbar / Subtabs */}
        <div className="insights-modal-nav">
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <button
              type="button"
              className={`modal-btn${tab === "activity" ? " accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("activity")}
            >
              Activity & Productivity
            </button>
            <button
              type="button"
              className={`modal-btn${tab === "daily" ? " accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("daily")}
            >
              Daily Timeline ({dailySpend.length})
            </button>
            <button
              type="button"
              className={`modal-btn${tab === "quotas" ? " accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("quotas")}
            >
              Plan Allowances ({groups.length})
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {insights?.updatedAt && (
              <span className="usage-row-label" style={{ fontSize: "11px" }}>
                {ago(insights.updatedAt)}
              </span>
            )}
            <button
              type="button"
              className={`usage-refresh-btn${refreshing ? " spinning" : ""}`}
              onClick={() => void load(true)}
              disabled={refreshing}
              title="Force refresh from Cursor API"
            >
              <RefreshIcon size={13} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="insights-modal-body">
          {loading && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-3)" }}>
              Fetching live insights from Cursor...
            </div>
          )}

          {error && (
            <div className="usage-error" style={{ marginBottom: "16px" }}>
              {error}
            </div>
          )}

          {!loading && insights && (
            <>
              {/* Account Meta Ribbon */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "8px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--border-subtle)",
                  marginBottom: "16px"
                }}
              >
                <div>
                  <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>
                    Plan Tier
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
                    <span className="usage-plan-badge" style={{ fontSize: "12px", padding: "2px 8px" }}>
                      {insights.subscriptionType ?? "Pro"}
                    </span>
                    {insights.teamName && (
                      <span style={{ fontSize: "12px", color: "var(--text-2)" }}>{insights.teamName}</span>
                    )}
                  </div>
                </div>

                {insights.email && (
                  <div>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>
                      Account
                    </div>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-1)", marginTop: "2px" }}>
                      {insights.displayName ? `${insights.displayName} (${insights.email})` : insights.email}
                    </div>
                  </div>
                )}

                {insights.billingCycleEnd && (
                  <div>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>
                      Billing Cycle Resets
                    </div>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-1)", marginTop: "2px" }}>
                      {fmtDate(insights.billingCycleEnd)}
                    </div>
                  </div>
                )}

                {insights.hardLimitDollars !== undefined && (
                  <div>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>
                      On-Demand Monthly Cap
                    </div>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-1)", marginTop: "2px" }}>
                      {insights.hardLimitDollars > 0 ? `$${insights.hardLimitDollars}` : (insights.noUsageBasedAllowed ? "Disabled" : "Unlimited")}
                    </div>
                  </div>
                )}
              </div>

              {/* Tab 1: Activity & Productivity */}
              {tab === "activity" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {/* Summary Tiles */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
                    <StatTile
                      label="Included Fast Requests"
                      value={act?.subscriptionIncludedRequests !== undefined ? act.subscriptionIncludedRequests.toLocaleString() : "—"}
                      sub="Plan included requests used"
                    />
                    <StatTile
                      label="On-Demand Requests"
                      value={act?.usageBasedRequests !== undefined ? act.usageBasedRequests.toLocaleString() : "—"}
                      sub="Usage-based requests"
                    />
                    <StatTile
                      label="Tab Acceptance Rate"
                      value={act?.tabAcceptancePct !== undefined ? `${act.tabAcceptancePct}%` : "—"}
                      sub={act?.totalTabsAccepted !== undefined ? `${act.totalTabsAccepted.toLocaleString()} of ${(act.totalTabsShown ?? 0).toLocaleString()} accepted` : undefined}
                    />
                    <StatTile
                      label="Diff Acceptance Rate"
                      value={act?.diffAcceptancePct !== undefined ? `${act.diffAcceptancePct}%` : "—"}
                      sub={act?.totalAppliesAccepted !== undefined ? `${act.totalAppliesAccepted.toLocaleString()} accepted diffs` : undefined}
                    />
                  </div>

                  {/* Modality Breakdown */}
                  <div
                    style={{
                      padding: "14px",
                      borderRadius: "8px",
                      background: "var(--bg-1)",
                      border: "1px solid var(--border-subtle)"
                    }}
                  >
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-1)", marginBottom: "10px" }}>
                      Request Modality Breakdown
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
                      <div className="usage-row">
                        <span className="usage-row-label">Composer</span>
                        <span className="usage-row-value">{act?.composerRequests?.toLocaleString() ?? "—"}</span>
                      </div>
                      <div className="usage-row">
                        <span className="usage-row-label">Agent Mode</span>
                        <span className="usage-row-value">{act?.agentRequests?.toLocaleString() ?? "—"}</span>
                      </div>
                      <div className="usage-row">
                        <span className="usage-row-label">Chat</span>
                        <span className="usage-row-value">{act?.chatRequests?.toLocaleString() ?? "—"}</span>
                      </div>
                      <div className="usage-row">
                        <span className="usage-row-label">Cmd+K Inlines</span>
                        <span className="usage-row-value">{act?.cmdkUsages?.toLocaleString() ?? "—"}</span>
                      </div>
                      <div className="usage-row">
                        <span className="usage-row-label">Grok Bot Runs</span>
                        <span className="usage-row-value">{act?.bugbotUsages?.toLocaleString() ?? "—"}</span>
                      </div>
                      {act?.acceptedLinesAdded !== undefined && act.acceptedLinesAdded > 0 && (
                        <div className="usage-row">
                          <span className="usage-row-label">AI Lines Accepted</span>
                          <span className="usage-row-value">{act.acceptedLinesAdded.toLocaleString()}</span>
                        </div>
                      )}
                      {act?.mostUsedModel && (
                        <div className="usage-row">
                          <span className="usage-row-label">Most Used Model</span>
                          <span className="usage-row-value">{act.mostUsedModel}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Daily Timeline & Spend */}
              {tab === "daily" && (
                <div>
                  {dailySpend.length === 0 ? (
                    <div style={{ padding: "30px 0", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
                      No daily spend or request activity recorded for this period.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "100px 1fr 100px 100px",
                          padding: "6px 12px",
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "var(--text-3)",
                          borderBottom: "1px solid var(--border-subtle)"
                        }}
                      >
                        <span>DATE</span>
                        <span>MODEL / CATEGORY</span>
                        <span style={{ textAlign: "right" }}>TOKENS</span>
                        <span style={{ textAlign: "right" }}>SPEND</span>
                      </div>

                      {dailySpend.map((row, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "100px 1fr 100px 100px",
                            padding: "8px 12px",
                            fontSize: "12px",
                            borderRadius: "6px",
                            background: "var(--bg-2)",
                            alignItems: "center"
                          }}
                        >
                          <span style={{ color: "var(--text-2)" }}>{fmtDate(row.day)}</span>
                          <span style={{ fontWeight: 600, color: "var(--text-1)" }}>{row.category}</span>
                          <span style={{ textAlign: "right", color: "var(--text-2)" }}>
                            {row.totalTokens !== undefined ? row.totalTokens.toLocaleString() : "—"}
                          </span>
                          <span style={{ textAlign: "right", fontWeight: 600, color: "var(--text-1)" }}>
                            {row.spendCents > 0 ? `$${(row.spendCents / 100).toFixed(2)}` : "$0.00"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Plan Allowances */}
              {tab === "quotas" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {groups.map((group) => (
                    <div
                      key={group.id}
                      style={{
                        padding: "14px",
                        borderRadius: "8px",
                        background: "var(--bg-1)",
                        border: "1px solid var(--border-subtle)"
                      }}
                    >
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: 700,
                          color: "var(--text-1)",
                          marginBottom: "8px"
                        }}
                      >
                        {group.label}
                      </div>

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
                        longWindowLabel={group.longWindowLabel}
                        monthlyWindowLabel={group.monthlyWindowLabel}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
