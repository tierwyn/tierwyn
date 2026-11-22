import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ClaudeActivityWindow, ClaudeInsights } from "@tierwyn/shared";
import { api } from "../api.js";
import { ago, Bar, fmtPct, RefreshIcon } from "./usageBars.js";
import { lsGet } from "../prefixedStorage.js";

interface Props {
  onClose: () => void;
}

const STORAGE_KEY = "tierwyn.cache.claudeInsights";
const CACHE_TTL_MS = 60_000;

function readPersistedClaudeInsights(): { data: ClaudeInsights; at: number } | null {
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

const initialCache = readPersistedClaudeInsights();
let cachedClaudeInsights: ClaudeInsights | null = initialCache?.data ?? null;
let cachedClaudeInsightsFetchedAt = initialCache?.at ?? 0;

const BEHAVIOR_LABELS: Record<string, string> = {
  general_coding: "General Coding",
  code_review: "Code Review",
  refactoring: "Refactoring",
  debugging: "Debugging",
  testing: "Testing & QA",
  documentation: "Documentation",
  architecture: "Architecture",
};

export function ClaudeInsightsModal({ onClose }: Props) {
  const [insights, setInsights] = useState<ClaudeInsights | null>(cachedClaudeInsights);
  const [loading, setLoading] = useState(!cachedClaudeInsights);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"day" | "week">("day");

  async function load(fresh = false) {
    if (fresh) setRefreshing(true);
    else if (!cachedClaudeInsights) setLoading(true);
    setError("");
    try {
      const data = await api.claudeInsights(fresh);
      cachedClaudeInsights = data;
      cachedClaudeInsightsFetchedAt = Date.now();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: cachedClaudeInsightsFetchedAt, data }));
      } catch { /* ignore quota */ }
      setInsights(data);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const isFresh = cachedClaudeInsights && (Date.now() - cachedClaudeInsightsFetchedAt < CACHE_TTL_MS);
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

  const activeWindow: ClaudeActivityWindow | undefined = tab === "day" ? insights?.day : insights?.week;
  const hasBehaviors = (activeWindow?.behaviors?.length ?? 0) > 0;
  const hasSkills = (activeWindow?.skills?.length ?? 0) > 0;
  const hasPlugins = (activeWindow?.plugins?.length ?? 0) > 0;
  const hasMcp = (activeWindow?.mcpServers?.length ?? 0) > 0;
  const stats = insights?.sessionStats;
  const hasStats = stats && (stats.totalLinesAdded !== undefined || stats.totalLinesRemoved !== undefined || stats.totalApiDurationMs !== undefined);

  return createPortal(
    <div className="modal-overlay modal-overlay--top" onClick={onClose}>
      <div className="modal-content insights-modal-shell" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="insights-modal-header">
          <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)" }}>
            Claude Code · Activity & Insights
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
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              className={`modal-btn ${tab === "day" ? "accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("day")}
            >
              Today (24h)
            </button>
            <button
              type="button"
              className={`modal-btn ${tab === "week" ? "accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("week")}
            >
              Past 7 Days
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
              disabled={refreshing || loading}
              title="Refresh live telemetry"
            >
              <RefreshIcon size={12} />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="insights-modal-body">
          {loading && !insights && (
            <div className="usage-note" style={{ padding: "32px 0", textAlign: "center" }}>
              Probing Claude Code telemetry…
            </div>
          )}

          {error && (
            <div className="usage-note accent-red" style={{ padding: "12px 0" }}>
              Failed to load telemetry: {error}
            </div>
          )}

          {insights && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* Activity volume metrics */}
              <div>
                <div className="usage-section-label" style={{ marginBottom: "6px" }}>
                  activity volume ({tab === "day" ? "today" : "past 7 days"})
                </div>
                <div className="usage-rows">
                  <div className="usage-row">
                    <span className="usage-row-label">requests</span>
                    <span className="usage-row-value">{activeWindow?.requestCount ?? 0}</span>
                  </div>
                  <div className="usage-row">
                    <span className="usage-row-label">sessions</span>
                    <span className="usage-row-value">{activeWindow?.sessionCount ?? 0}</span>
                  </div>
                </div>
              </div>

              {/* Behavior Profile */}
              {hasBehaviors && (
                <div>
                  <div className="usage-section-label" style={{ marginBottom: "6px" }}>
                    behavior profile
                  </div>
                  <div className="usage-rows">
                    {activeWindow!.behaviors.map((b) => {
                      const label = BEHAVIOR_LABELS[b.key] ?? b.key.replace(/_/g, " ");
                      const pctClass = b.pct >= 50 ? "accent-amber" : "accent-dim";
                      return (
                        <div key={b.key} style={{ marginBottom: "6px" }}>
                          <div className="usage-row">
                            <span className="usage-row-label">{label}</span>
                            <span className={`usage-row-value ${pctClass}`}>
                              {fmtPct(b.pct)} {b.count > 0 ? `(${b.count} reqs)` : ""}
                            </span>
                          </div>
                          <Bar ratio={b.pct / 100} color="" allowance />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Skills & Plugins */}
              {(hasSkills || hasPlugins || hasMcp) && (
                <div>
                  <div className="usage-section-label" style={{ marginBottom: "6px" }}>
                    skills & plugins
                  </div>
                  <div className="usage-rows">
                    {activeWindow!.skills.map((s) => (
                      <div key={s.name} className="usage-row">
                        <span className="usage-row-label">⚡ {s.name}</span>
                        <span className="usage-row-value accent-dim">{fmtPct(s.pct)}</span>
                      </div>
                    ))}
                    {activeWindow!.plugins.map((p) => (
                      <div key={p.name} className="usage-row">
                        <span className="usage-row-label">🔌 {p.name}</span>
                        <span className="usage-row-value accent-dim">{fmtPct(p.pct)}</span>
                      </div>
                    ))}
                    {activeWindow!.mcpServers.map((m) => (
                      <div key={m.name} className="usage-row">
                        <span className="usage-row-label">🛠️ {m.name}</span>
                        <span className="usage-row-value accent-dim">{fmtPct(m.pct)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Session Impact & Performance */}
              {hasStats && (
                <div>
                  <div className="usage-section-label" style={{ marginBottom: "6px" }}>
                    probe session code churn & latency
                  </div>
                  <div className="usage-rows">
                    {stats.totalLinesAdded !== undefined && stats.totalLinesRemoved !== undefined && (
                      <div className="usage-row">
                        <span className="usage-row-label">lines churned</span>
                        <span className="usage-row-value">
                          +{stats.totalLinesAdded} / -{stats.totalLinesRemoved}
                        </span>
                      </div>
                    )}
                    {stats.totalApiDurationMs !== undefined && stats.totalApiDurationMs > 0 && (
                      <div className="usage-row">
                        <span className="usage-row-label">api duration</span>
                        <span className="usage-row-value">
                          {(stats.totalApiDurationMs / 1000).toFixed(2)}s
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
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
