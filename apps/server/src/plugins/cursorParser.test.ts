import { describe, it, expect } from "vitest";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../plugin-src/cursor-usage/index.js");
const plugin = await import(pluginPath) as {
  stickyCursorQuota: (prev: unknown, next: unknown) => {
    monthlyPct?: number;
    monthlyResetsAt?: number;
    sevenDayResetsAt?: number;
    groups: Array<{ id: string; monthlyResetsAt?: number; sevenDayResetsAt?: number }>;
  };
  parseCursorUsageJson: (raw: unknown, planInfo?: unknown, sandInfo?: unknown, context?: unknown) => {
  plan: string;
  groups: Array<{
    id: string;
    label: string;
    monthlyPct?: number;
    monthlyResetsAt?: number;
    monthlyWindowLabel?: string;
    sevenDayPct?: number;
    sevenDayResetsAt?: number;
    longWindowLabel?: string;
    onDemandUsed?: number;
    onDemandCap?: number;
  }>;
  monthlyPct?: number;
  monthlyResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  onDemandUsed?: number;
  onDemandCap?: number;
  fetchedAt: number;
} };

describe("Cursor usage plugin parser", () => {
  it("parses ConnectRPC GetCurrentPeriodUsage & GetPlanInfo & GetSandUsageStatus response", () => {
    // Cursor DashboardService returns pool percents already on a 0–100 scale
    // (see OpenUsage CursorUsageMapper + forum get-current-period-usage samples).
    const usageRpc = {
      billingCycleStart: 1787354538000,
      billingCycleEnd: 1788220800000,
      planUsage: {
        totalSpend: 6396,
        limit: 2000,
        autoPercentUsed: 8, // 8% Cursor Models
        apiPercentUsed: 58, // 58% Other Models
      },
      spendLimitUsage: {
        totalSpend: 0,
        limit: 0
      },
      enabled: true
    };
    const planRpc = {
      planInfo: {
        planName: "Pro"
      }
    };
    const sandRpc = {
      usagePercent: 2, // 2% Grok Bot
      nextResetTimestampUtc: {
        seconds: 1788825600,
        nanos: 0
      }
    };

    const parsed = plugin.parseCursorUsageJson(usageRpc, planRpc, sandRpc);
    expect(parsed.plan).toBe("Pro");
    expect(parsed.groups).toHaveLength(3);

    // Group 1: Cursor Models
    const cursorModels = parsed.groups.find(g => g.id === "cursor-models");
    expect(cursorModels).toBeDefined();
    expect(cursorModels?.label).toBe("Cursor Models");
    expect(cursorModels?.monthlyPct).toBe(8);
    expect(cursorModels?.monthlyResetsAt).toBe(1788220800000);

    // Group 2: Other Models
    const otherModels = parsed.groups.find(g => g.id === "other-models");
    expect(otherModels).toBeDefined();
    expect(otherModels?.label).toBe("Other Models");
    expect(otherModels?.monthlyPct).toBe(58);
    expect(otherModels?.monthlyResetsAt).toBe(1788220800000);

    // Group 3: Grok Bot
    const grokBot = parsed.groups.find(g => g.id === "grok-bot");
    expect(grokBot).toBeDefined();
    expect(grokBot?.label).toBe("Grok Bot");
    expect(grokBot?.sevenDayPct).toBe(2);
    expect(grokBot?.sevenDayResetsAt).toBe(1788825600000);
    expect(grokBot?.longWindowLabel).toBe("weekly usage");
    expect(grokBot?.monthlyResetsAt).toBeUndefined();
  });

  it("does not inflate sub-1% Cursor pool / Sand percents (API is already 0–100)", () => {
    const parsed = plugin.parseCursorUsageJson(
      {
        billingCycleEnd: 1788220800000,
        planUsage: {
          autoPercentUsed: 0.758, // 0.758% — NOT a 0–1 fraction
          apiPercentUsed: 0,
        },
      },
      { planInfo: { planName: "Premium" } },
      { usagePercent: 0.758, nextResetTimestampUtc: { seconds: 1788825600, nanos: 0 } },
    );

    expect(parsed.groups.find((g) => g.id === "cursor-models")?.monthlyPct).toBe(0.8);
    expect(parsed.groups.find((g) => g.id === "other-models")?.monthlyPct).toBe(0);
    expect(parsed.groups.find((g) => g.id === "grok-bot")?.sevenDayPct).toBe(0.8);
  });

  it("parses legacy REST response from cursor.com/api/usage", () => {
    const raw = {
      membershipType: "Pro",
      numFastRequests: 142,
      fastRequestsLimit: 500,
      onDemandUsage: 5.5,
      usageBasedLimit: 50,
      endOfMonth: "2026-09-01T00:00:00.000Z"
    };

    const parsed = plugin.parseCursorUsageJson(raw);
    expect(parsed.plan).toBe("Pro");
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].id).toBe("other-models");
    expect(parsed.groups[0].monthlyPct).toBeCloseTo(28.4);
    expect(parsed.groups[0].onDemandUsed).toBe(5.5);
    expect(parsed.groups[0].onDemandCap).toBe(50);
  });

  it("selects Cursor Models for composer and grok models in cursor agent", () => {
    const usageRpc = {
      planUsage: {
        autoPercentUsed: 10.1,
        apiPercentUsed: 75.9,
      }
    };
    const sandRpc = {
      usagePercent: 4,
    };

    // Composer model
    const composerParsed = plugin.parseCursorUsageJson(usageRpc, {}, sandRpc, { agentType: "cursor", model: "composer-2.5" });
    expect(composerParsed.monthlyPct).toBe(10.1);
    expect(composerParsed.monthlyWindowLabel).toBe("Cursor Grok and Composer used");
    expect(composerParsed.sevenDayPct).toBeUndefined();

    // Grok model
    const grokParsed = plugin.parseCursorUsageJson(usageRpc, {}, sandRpc, { agentType: "cursor", model: "cursor:grok-4.6" });
    expect(grokParsed.monthlyPct).toBe(10.1);
    expect(grokParsed.monthlyWindowLabel).toBe("Cursor Grok and Composer used");
    expect(grokParsed.sevenDayPct).toBeUndefined();
  });

  it("selects Other Models for non-Grok/Composer cursor models", () => {
    const usageRpc = {
      planUsage: {
        autoPercentUsed: 10.1,
        apiPercentUsed: 75.9,
      }
    };
    const sandRpc = {
      usagePercent: 4,
    };

    const opusParsed = plugin.parseCursorUsageJson(usageRpc, {}, sandRpc, { agentType: "cursor", model: "claude-opus-4-8-thinking-high" });
    expect(opusParsed.monthlyPct).toBe(75.9);
    expect(opusParsed.monthlyWindowLabel).toBe("Other models used");
    expect(opusParsed.sevenDayPct).toBeUndefined();
  });

  it("selects weekly usage for grok-bot agent", () => {
    const usageRpc = {
      planUsage: {
        autoPercentUsed: 10.1,
        apiPercentUsed: 75.9,
      }
    };
    const sandRpc = {
      usagePercent: 4,
    };

    const grokBotParsed = plugin.parseCursorUsageJson(usageRpc, {}, sandRpc, { agentType: "grok-bot" });
    expect(grokBotParsed.sevenDayPct).toBe(4);
    expect(grokBotParsed.longWindowLabel).toBe("weekly usage");
    expect(grokBotParsed.monthlyPct).toBeUndefined();
  });

  it("throws on empty response", () => {
    expect(() => plugin.parseCursorUsageJson(null)).toThrow("Cursor usage: empty response");
  });

  it("keeps billing-cycle reset from the previous quota when a refresh omits it", () => {
    const withReset = plugin.parseCursorUsageJson({
      billingCycleEnd: 1788220800000,
      planUsage: { autoPercentUsed: 10 },
    });
    const withoutReset = plugin.parseCursorUsageJson({
      planUsage: { autoPercentUsed: 10.9 },
    });
    const sticky = plugin.stickyCursorQuota(withReset, withoutReset);
    expect(sticky.monthlyPct).toBe(10.9);
    expect(sticky.monthlyResetsAt).toBe(1788220800000);
    expect(sticky.groups.find((g) => g.id === "cursor-models")?.monthlyResetsAt).toBe(1788220800000);
  });

  it("does not paint billing-cycle monthlyResetsAt onto the Grok Bot group", () => {
    const withReset = plugin.parseCursorUsageJson(
      {
        billingCycleEnd: 1788220800000,
        planUsage: { autoPercentUsed: 10, apiPercentUsed: 20 },
      },
      undefined,
      { usagePercent: 4, nextResetTimestampUtc: { seconds: 1788825600, nanos: 0 } },
    );
    const withoutMonthlyOnSand = plugin.parseCursorUsageJson(
      {
        planUsage: { autoPercentUsed: 11, apiPercentUsed: 21 },
      },
      undefined,
      { usagePercent: 5 },
    );
    const sticky = plugin.stickyCursorQuota(withReset, withoutMonthlyOnSand);
    const grokBot = sticky.groups.find((g) => g.id === "grok-bot");
    expect(grokBot?.sevenDayPct).toBe(5);
    expect(grokBot?.sevenDayResetsAt).toBe(1788825600000); // sticky weekly reset only
    expect(grokBot?.monthlyResetsAt).toBeUndefined();
    expect(sticky.groups.find((g) => g.id === "cursor-models")?.monthlyResetsAt).toBe(1788220800000);
  });
});

describe("cursor-usage manifest agent surface", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../plugin-src/cursor-usage");

  function cap(raw: unknown, name: string) {
    const m = raw as { capabilities: Array<{ name: string; agentCallable: boolean }> };
    return m.capabilities.find((c) => c.name === name);
  }

  it("keeps usage.get agent-callable and hides insights.get from agents", async () => {
    const { existsSync, readFileSync } = await import("fs");
    const example = JSON.parse(readFileSync(join(dir, "plugin.json.example"), "utf8"));
    expect(cap(example, "usage.get")?.agentCallable).toBe(true);
    expect(cap(example, "insights.get")?.agentCallable).toBe(false);

    // plugin.json is instance-only (gitignored). Present when live-devving
    // with TIERWYN_PLUGINS_DIR=./plugin-src; absent in a clean clone.
    const livePath = join(dir, "plugin.json");
    if (existsSync(livePath)) {
      const live = JSON.parse(readFileSync(livePath, "utf8"));
      expect(cap(live, "usage.get")?.agentCallable).toBe(true);
      expect(cap(live, "insights.get")?.agentCallable).toBe(false);
    }
  });
});
