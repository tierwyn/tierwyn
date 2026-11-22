import { useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import type { AntigravityInsights } from "@tierwyn/shared";
import { api } from "../api.js";
import { ago, Bar, fmtPct, RefreshIcon, resetTime } from "./usageBars.js";
import { lsGet } from "../prefixedStorage.js";

interface Props {
  onClose: () => void;
}

const STORAGE_KEY = "tierwyn.cache.antigravityInsights";
const CACHE_TTL_MS = 60_000;

function readPersistedAntigravityInsights(): { data: AntigravityInsights; at: number } | null {
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

const initialCache = readPersistedAntigravityInsights();
let cachedAntigravityInsights: AntigravityInsights | null = initialCache?.data ?? null;
let cachedAntigravityInsightsFetchedAt = initialCache?.at ?? 0;

export function AntigravityInsightsModal({ onClose }: Props) {
  const [insights, setInsights] = useState<AntigravityInsights | null>(cachedAntigravityInsights);
  const [loading, setLoading] = useState(!cachedAntigravityInsights);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"quotas" | "skills" | "permissions">("quotas");
  const [skillSearch, setSkillSearch] = useState("");

  const load = async (fresh = false) => {
    if (fresh) setRefreshing(true);
    else if (!cachedAntigravityInsights) setLoading(true);
    try {
      const res = await api.antigravityInsights(fresh);
      cachedAntigravityInsights = res;
      cachedAntigravityInsightsFetchedAt = Date.now();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: cachedAntigravityInsightsFetchedAt, data: res }));
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
    const isFresh = cachedAntigravityInsights && (Date.now() - cachedAntigravityInsightsFetchedAt < CACHE_TTL_MS);
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
  const skills = insights?.skills ?? [];
  const permissions = insights?.permissions ?? [];

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return skills;
    const q = skillSearch.toLowerCase();
    return skills.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      (s.plugin && s.plugin.toLowerCase().includes(q)),
    );
  }, [skills, skillSearch]);

  return createPortal(
    <div className="modal-overlay modal-overlay--top" onClick={onClose}>
      <div className="modal-content insights-modal-shell" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="insights-modal-header">
          <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-1)" }}>
            Google Antigravity · Activity & Insights
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
              className={`modal-btn${tab === "quotas" ? " accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("quotas")}
            >
              Model Quotas & Policy
            </button>
            <button
              type="button"
              className={`modal-btn${tab === "skills" ? " accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("skills")}
            >
              Skills & Plugins ({skills.length})
            </button>
            <button
              type="button"
              className={`modal-btn${tab === "permissions" ? " accent" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => setTab("permissions")}
            >
              Permissions ({permissions.length})
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
          {error && <div className="usage-error">{error}</div>}

          {loading && !insights && (
            <div className="usage-loading" style={{ padding: "32px 0", textAlign: "center" }}>
              Loading Antigravity telemetry…
            </div>
          )}

          {insights && (
            <>
              {tab === "quotas" && (
                <>
                  {/* Highlights Card */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "10px",
                  }}>
                    <div className="settings-card" style={{ padding: "12px", margin: 0 }}>
                      <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase" }}>G1 Remaining Credits</div>
                      <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-1)", marginTop: "4px" }}>
                        {insights.remainingCredits ?? 0}
                      </div>
                    </div>

                    {insights.upgradeUri && /^https:\/\//i.test(insights.upgradeUri) && (
                      <div className="settings-card" style={{ padding: "12px", margin: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                        <div className="usage-row-label" style={{ fontSize: "10px", textTransform: "uppercase", marginBottom: "6px" }}>Google One Credits</div>
                        <a
                          href={insights.upgradeUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="modal-btn accent"
                          style={{ fontSize: "11px", padding: "5px 10px", textDecoration: "none", textAlign: "center", alignSelf: "flex-start" }}
                        >
                          Upgrade / Buy Credits ↗
                        </a>
                      </div>
                    )}
                  </div>

                  {/* Quota Policy Note */}
                  {insights.policyDescription && (
                    <div className="usage-note" style={{ fontSize: "12px", lineHeight: "1.5", background: "var(--bg-card, rgba(255, 255, 255, 0.03))", padding: "12px 14px", borderRadius: "6px", border: "1px solid var(--border)" }}>
                      {insights.policyDescription}
                    </div>
                  )}

                  {/* Model Groups */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {groups.map((group) => (
                      <div key={group.id} className="settings-card active" style={{ margin: 0, padding: "14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "4px" }}>
                          <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-1)" }}>
                            {group.name}
                          </span>
                        </div>
                        {group.description && (
                          <div className="usage-row-label" style={{ fontSize: "11px", marginBottom: "12px" }}>
                            {group.description}
                          </div>
                        )}

                        <div className="usage-rows" style={{ gap: "10px" }}>
                          {group.buckets.map((b) => (
                            <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                                <span className="usage-row-label" title={b.description}>
                                  {b.name}
                                  {b.resetsAt && <span style={{ opacity: 0.7 }}> · resets {resetTime(b.resetsAt)}</span>}
                                </span>
                                <span className={`usage-row-value ${b.usedPct >= 90 ? "accent-red" : b.usedPct >= 75 ? "accent-amber" : ""}`}>
                                  {fmtPct(b.usedPct)} used ({fmtPct(b.remainingFraction * 100)} left)
                                </span>
                              </div>
                              <Bar ratio={b.usedPct / 100} color="" allowance />
                              {b.description && (
                                <span className="usage-row-label" style={{ fontSize: "10px", opacity: 0.8 }}>
                                  {b.description}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {tab === "skills" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <input
                    type="text"
                    placeholder="Filter skills by name, description, or plugin…"
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    style={{
                      padding: "8px 12px",
                      fontSize: "12px",
                      background: "var(--bg-input, rgba(0,0,0,0.2))",
                      border: "1px solid var(--border)",
                      borderRadius: "6px",
                      color: "var(--text-1)",
                    }}
                  />

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {filteredSkills.map((s) => (
                      <div
                        key={s.name}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "6px",
                          border: "1px solid var(--border)",
                          background: "var(--bg-card, rgba(255,255,255,0.02))",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-1)" }}>
                            {s.name}
                          </span>
                          <div style={{ display: "flex", gap: "4px" }}>
                            {s.plugin && (
                              <span className="usage-plan-badge" style={{ fontSize: "9px" }}>
                                {s.plugin}
                              </span>
                            )}
                            {s.builtin && (
                              <span className="usage-plan-badge" style={{ fontSize: "9px", opacity: 0.7 }}>
                                builtin
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="usage-row-label" style={{ fontSize: "12px", lineHeight: "1.4" }}>
                          {s.description}
                        </div>
                        {s.path && (
                          <div className="usage-row-label" style={{ fontSize: "10px", opacity: 0.6, marginTop: "6px", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s.path}
                          </div>
                        )}
                      </div>
                    ))}
                    {filteredSkills.length === 0 && (
                      <div className="usage-note" style={{ textAlign: "center", padding: "20px 0" }}>
                        No matching skills found.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === "permissions" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {permissions.map((p, idx) => (
                    <div
                      key={p.scope || idx}
                      style={{
                        padding: "12px 14px",
                        borderRadius: "6px",
                        border: "1px solid var(--border)",
                        background: "var(--bg-card, rgba(255,255,255,0.02))",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontWeight: 600, fontSize: "12px", textTransform: "uppercase", color: "var(--text-2)" }}>
                          Scope: {p.scope}
                        </span>
                        <span className="usage-row-label" style={{ fontSize: "11px" }}>
                          {p.allow?.length ?? 0} allowed tools/commands
                        </span>
                      </div>
                      {p.allow && p.allow.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                          {p.allow.map((rule) => (
                            <span
                              key={rule}
                              style={{
                                fontSize: "11px",
                                fontFamily: "monospace",
                                padding: "3px 8px",
                                background: "rgba(255,255,255,0.06)",
                                borderRadius: "4px",
                                color: "var(--text-1)",
                              }}
                            >
                              {rule}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="usage-note" style={{ fontSize: "11px" }}>
                          No specific permission rules declared in this scope.
                        </div>
                      )}
                    </div>
                  ))}
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
