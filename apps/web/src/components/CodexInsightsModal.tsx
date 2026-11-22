import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CodexInsights } from "@tierwyn/shared";
import { api } from "../api.js";
import { ago, Bar, fmtPct, RefreshIcon, resetTime } from "./usageBars.js";
import { lsGet } from "../prefixedStorage.js";

interface Props {
  onClose: () => void;
}

const STORAGE_KEY = "tierwyn.cache.codexInsights";
const CACHE_TTL_MS = 60_000;

function readPersistedCodexInsights(): { data: CodexInsights; at: number } | null {
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

const initialCache = readPersistedCodexInsights();
let cachedCodexInsights: CodexInsights | null = initialCache?.data ?? null;
let cachedCodexInsightsFetchedAt = initialCache?.at ?? 0;

export function CodexInsightsModal({ onClose }: Props) {
  const [insights, setInsights] = useState<CodexInsights | null>(cachedCodexInsights);
  const [loading, setLoading] = useState(!cachedCodexInsights);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = async (fresh = false) => {
    if (fresh) setRefreshing(true);
    else if (!cachedCodexInsights) setLoading(true);
    try {
      const res = await api.codexInsights(fresh);
      cachedCodexInsights = res;
      cachedCodexInsightsFetchedAt = Date.now();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: cachedCodexInsightsFetchedAt, data: res }));
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
    const isFresh = cachedCodexInsights && (Date.now() - cachedCodexInsightsFetchedAt < CACHE_TTL_MS);
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

  const summary = insights?.summary;
  const buckets = insights?.dailyUsageBuckets ?? [];
  const maxTokens = Math.max(...buckets.map((b) => b.tokens), summary?.peakDailyTokens ?? 1, 1);

  return createPortal(
    <div className="modal-overlay modal-overlay--top" onClick={onClose}>
      <div className="modal-content insights-modal-shell" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="insights-modal-header">
          <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)" }}>
            OpenAI Codex · Activity & Insights
          </span>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Toolbar / Nav */}
        <div className="insights-modal-nav">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {insights?.subscriptionType && (
              <span className="usage-plan-badge" style={{ textTransform: "capitalize" }}>
                {insights.subscriptionType} Plan
              </span>
            )}
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
              disabled={refreshing || loading}
              title="Refresh live telemetry"
            >
              <RefreshIcon size={12} />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="insights-modal-body">
          {error && <div className="usage-error" style={{ marginBottom: "12px" }}>{error}</div>}

          {loading && !insights && (
            <div className="usage-loading" style={{ padding: "32px 0", textAlign: "center" }}>
              Loading Codex telemetry…
            </div>
          )}

          {insights && (
            <>
              {/* Allowance Windows */}
              {(insights.primaryWindow || insights.secondaryWindow) && (
                <div className="settings-card active" style={{ margin: 0, padding: "14px" }}>
                  <div className="settings-card-header">
                    <span className="settings-card-title">Allowance Windows</span>
                  </div>
                  <div className="usage-rows">
                    {insights.primaryWindow?.usedPercent !== undefined && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                          <span className="usage-row-label">
                            Primary Window ({insights.primaryWindow.windowDurationMins ? `${insights.primaryWindow.windowDurationMins / 60}h` : "5h"})
                            {insights.primaryWindow.resetsAt && ` · resets ${resetTime(insights.primaryWindow.resetsAt)}`}
                          </span>
                          <span className={`usage-row-value ${insights.primaryWindow.usedPercent >= 90 ? "accent-red" : insights.primaryWindow.usedPercent >= 75 ? "accent-amber" : ""}`}>
                            {fmtPct(insights.primaryWindow.usedPercent)} used
                          </span>
                        </div>
                        <Bar ratio={insights.primaryWindow.usedPercent / 100} color="" allowance />
                      </div>
                    )}

                    {insights.secondaryWindow?.usedPercent !== undefined && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                          <span className="usage-row-label">
                            Secondary Window ({insights.secondaryWindow.windowDurationMins ? `${Math.round(insights.secondaryWindow.windowDurationMins / 1440)}d` : "7d"})
                            {insights.secondaryWindow.resetsAt && ` · resets ${resetTime(insights.secondaryWindow.resetsAt)}`}
                          </span>
                          <span className={`usage-row-value ${insights.secondaryWindow.usedPercent >= 90 ? "accent-red" : insights.secondaryWindow.usedPercent >= 75 ? "accent-amber" : ""}`}>
                            {fmtPct(insights.secondaryWindow.usedPercent)} used
                          </span>
                        </div>
                        <Bar ratio={insights.secondaryWindow.usedPercent / 100} color="" allowance />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Lifetime Highlights Grid */}
              {summary && (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: "10px",
                }}>
                  <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>Lifetime Tokens</div>
                    <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                      {summary.lifetimeTokens.toLocaleString()}
                    </div>
                  </div>

                  <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>Peak Daily Tokens</div>
                    <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                      {summary.peakDailyTokens.toLocaleString()}
                    </div>
                  </div>

                  <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>Current Streak</div>
                    <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                      {summary.currentStreakDays} day{summary.currentStreakDays === 1 ? "" : "s"}
                    </div>
                  </div>

                  <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                    <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>Longest Streak</div>
                    <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                      {summary.longestStreakDays} day{summary.longestStreakDays === 1 ? "" : "s"}
                    </div>
                  </div>

                  {insights.manualResetsAvailable !== undefined && (
                    <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                      <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>Manual Resets</div>
                      <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                        {insights.manualResetsAvailable}
                      </div>
                    </div>
                  )}

                  {insights.hasCredits && (
                    <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                      <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>Credits Balance</div>
                      <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                        {insights.unlimitedCredits ? "Unlimited" : (insights.creditsBalance ?? 0)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Daily Token Buckets History */}
              {buckets.length > 0 && (
                <div className="settings-card" style={{ margin: 0, padding: "14px" }}>
                  <div className="settings-card-header">
                    <span className="settings-card-title">Daily Token History (Last 30 Days)</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "280px", overflowY: "auto", paddingRight: "4px" }}>
                    {buckets.map((b) => {
                      const ratio = maxTokens > 0 ? b.tokens / maxTokens : 0;
                      return (
                        <div key={b.startDate} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                            <span className="usage-row-label">
                              {b.startDate}
                            </span>
                            <span className="usage-row-value" style={{ fontSize: "12px" }}>
                              {b.tokens.toLocaleString()} tokens
                            </span>
                          </div>
                          <Bar ratio={ratio} color="var(--accent)" />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="insights-modal-footer">
          <button type="button" className="modal-btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
