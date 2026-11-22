import { describe, it, expect } from "vitest";
import { parseClaudeUsagePayload, parseClaudeInsights } from "./probeUsage.js";

describe("parseClaudeUsagePayload", () => {
  it("parses standard five_hour, seven_day and subscriptionType", () => {
    const raw = {
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: 20,
          resets_at: "2026-01-01T00:00:00.000000+00:00",
        },
        seven_day: {
          utilization: 56,
          resets_at: "2026-01-05T00:00:00.000000+00:00",
        },
      },
    };
    const out = parseClaudeUsagePayload(raw);
    expect(out.subscriptionType).toBe("pro");
    expect(out.fiveHourPct).toBe(20);
    expect(out.fiveHourResetsAt).toBe(Date.parse("2026-01-01T00:00:00.000000+00:00"));
    expect(out.sevenDayPct).toBe(56);
    expect(out.sevenDayResetsAt).toBe(Date.parse("2026-01-05T00:00:00.000000+00:00"));
    expect(out.extraUsageUsed).toBeUndefined();
  });

  it("parses extra_usage and spend structures when enabled", () => {
    const raw = {
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 20, resets_at: "2026-01-01T00:00:00Z" },
        seven_day: { utilization: 56, resets_at: "2026-01-05T00:00:00Z" },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 4000,
          used_credits: 3999,
          utilization: 99.975,
          currency: "GBP",
          decimal_places: 2,
        },
        spend: {
          used: { amount_minor: 3999, currency: "GBP", exponent: 2 },
          limit: { amount_minor: 4000, currency: "GBP", exponent: 2 },
          percent: 100,
          enabled: true,
        },
      },
    };
    const out = parseClaudeUsagePayload(raw);
    expect(out.extraUsageUsed).toBe(39.99);
    expect(out.extraUsageLimit).toBe(40.00);
    expect(out.extraUsagePct).toBe(99.975);
    expect(out.extraUsageCurrency).toBe("GBP");
  });

  it("handles null, empty or malformed payloads gracefully", () => {
    expect(parseClaudeUsagePayload(null)).toEqual({});
    expect(parseClaudeUsagePayload({})).toEqual({});
    expect(parseClaudeUsagePayload({ rate_limits_available: false })).toEqual({});
  });
});

describe("parseClaudeInsights", () => {
  it("extracts activity windows, behaviors, skills, plugins and session stats", () => {
    const raw = {
      subscription_type: "pro",
      session: {
        total_cost_usd: 1.25,
        total_api_duration_ms: 3500,
        total_duration_ms: 12000,
        total_lines_added: 45,
        total_lines_removed: 12,
      },
      behaviors: {
        day: {
          request_count: 135,
          session_count: 7,
          behaviors: [
            { key: "long_context", pct: 13, count: 11 },
            { key: "cache_miss", pct: 0, count: 0 },
          ],
          skills: [{ name: "firecrawl-search", pct: 1 }],
          plugins: [],
          mcp_servers: [],
        },
        week: {
          request_count: 1540,
          session_count: 63,
          behaviors: [
            { key: "long_context", pct: 9, count: 98 },
          ],
          skills: [{ name: "superpowers:writing-plans", pct: 11 }],
          plugins: [{ name: "superpowers", pct: 11 }],
          mcp_servers: [],
        },
      },
      rate_limits: {
        limits: [
          { kind: "session", group: "session", percent: 20, severity: "normal" },
          { kind: "weekly_all", group: "weekly", percent: 56, severity: "normal" },
        ],
      },
    };

    const insights = parseClaudeInsights(raw);
    expect(insights.subscriptionType).toBe("pro");
    expect(insights.sessionStats?.totalCostUsd).toBe(1.25);
    expect(insights.sessionStats?.totalLinesAdded).toBe(45);
    expect(insights.sessionStats?.totalLinesRemoved).toBe(12);

    expect(insights.day?.requestCount).toBe(135);
    expect(insights.day?.sessionCount).toBe(7);
    expect(insights.day?.behaviors).toEqual([
      { key: "long_context", pct: 13, count: 11 },
      { key: "cache_miss", pct: 0, count: 0 },
    ]);
    expect(insights.day?.skills).toEqual([{ name: "firecrawl-search", pct: 1 }]);

    expect(insights.week?.requestCount).toBe(1540);
    expect(insights.week?.plugins).toEqual([{ name: "superpowers", pct: 11 }]);
    expect(insights.extraLimits?.length).toBe(2);
    expect(insights.updatedAt).toEqual(expect.any(Number));
  });

  it("handles null or empty payloads gracefully", () => {
    const empty = parseClaudeInsights(null);
    expect(empty.updatedAt).toEqual(expect.any(Number));
    expect(empty.day).toBeUndefined();
    expect(empty.week).toBeUndefined();
  });
});
