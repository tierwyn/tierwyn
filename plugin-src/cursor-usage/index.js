// Cursor Usage Plugin for Tierwyn
// Extracts Cursor Models (Grok & Composer), Other Models, Grok Bot weekly quota, plan tier, activity analytics & insights.

const TTL_MS = 30_000;
let tokenCache = null; // { key, token, expiresAt }
let quotaCache = null; // { at, data }
let insightsCache = null; // { at, data }

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function numVal(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function parseDateMs(raw) {
  if (!raw) return undefined;
  if (typeof raw === "object") {
    if (typeof raw.seconds === "number" || typeof raw.seconds === "string") {
      const s = Number(raw.seconds);
      const nanos = Number(raw.nanos ?? 0);
      return Math.round(s * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0));
    }
  }
  if (typeof raw === "number") {
    return raw < 100_000_000_000 ? raw * 1000 : raw;
  }
  const str = String(raw).trim();
  const asNum = Number(str);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum < 100_000_000_000 ? asNum * 1000 : asNum;
  }
  const t = new Date(str).getTime();
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** Cursor DashboardService pool / Sand fields are already 0–100 percents.
 *  Do not treat values ≤ 1 as 0–1 fractions — that inflates sub-1% usage (e.g. 0.758 → 75.8). */
function asPercentUsed(raw) {
  const n = numVal(raw);
  if (n === undefined) return undefined;
  return Math.round(n * 10) / 10;
}

/**
 * Normalise Cursor usage response from either ConnectRPC (api2.cursor.sh)
 * or web dashboard REST (cursor.com/api/usage).
 */
export function parseCursorUsageJson(raw, planInfo, sandInfo, context) {
  const root = asRecord(raw);
  if (!root) throw new Error("Cursor usage: empty response");

  const planUsage = asRecord(root.planUsage ?? root.plan_usage);
  const spendUsage = asRecord(root.spendLimitUsage ?? root.spend_limit_usage);
  const planObj = asRecord(planInfo?.planInfo ?? planInfo?.plan_info ?? root.planInfo ?? root.plan_info);
  const sand = asRecord(sandInfo);

  const plan = typeof planObj?.planName === "string" && planObj.planName.trim() !== ""
    ? planObj.planName.trim()
    : typeof root.membershipType === "string" && root.membershipType.trim() !== ""
      ? root.membershipType.trim()
      : typeof root.subscriptionTier === "string" && root.subscriptionTier.trim() !== ""
        ? root.subscriptionTier.trim()
        : "Pro";

  const resetsAt = parseDateMs(root.billingCycleEnd ?? root.billing_cycle_end ?? root.endOfMonth ?? root.nextBillingDate);

  let onDemandUsed = undefined;
  let onDemandCap = undefined;
  if (spendUsage) {
    const spTot = numVal(spendUsage.totalSpend ?? spendUsage.total_spend);
    const spLim = numVal(spendUsage.limit);
    if (spTot !== undefined && spTot > 0) onDemandUsed = spTot / 100;
    if (spLim !== undefined && spLim > 0) onDemandCap = spLim / 100;
  } else {
    const od = numVal(root.onDemandUsage ?? root.onDemandSpend);
    const cl = numVal(root.usageBasedLimit ?? root.costLimit);
    if (od !== undefined && od > 0) onDemandUsed = od;
    if (cl !== undefined && cl > 0) onDemandCap = cl;
  }

  const groups = [];

  // 1. Cursor Models (Cursor Grok & Composer)
  let autoPct = undefined;
  if (planUsage) {
    const autoSpend = numVal(planUsage.autoSpend ?? planUsage.auto_spend);
    const autoLimit = numVal(planUsage.autoLimit ?? planUsage.auto_limit);
    const fromApi = asPercentUsed(planUsage.autoPercentUsed ?? planUsage.auto_percent_used);
    if (fromApi !== undefined) {
      autoPct = fromApi;
    } else if (autoSpend !== undefined && autoLimit !== undefined && autoLimit > 0) {
      autoPct = asPercentUsed((autoSpend / autoLimit) * 100);
    }
  }

  if (autoPct !== undefined) {
    groups.push({
      id: "cursor-models",
      label: "Cursor Models",
      monthlyPct: autoPct,
      monthlyResetsAt: resetsAt,
      monthlyWindowLabel: "Cursor Grok and Composer used"
    });
  }

  // 2. Other Models
  let apiPct = undefined;
  if (planUsage) {
    const apiSpend = numVal(planUsage.apiSpend ?? planUsage.api_spend);
    const apiLimit = numVal(planUsage.apiLimit ?? planUsage.api_limit);
    const fromApi = asPercentUsed(planUsage.apiPercentUsed ?? planUsage.api_percent_used);
    if (fromApi !== undefined) {
      apiPct = fromApi;
    } else if (apiSpend !== undefined && apiLimit !== undefined && apiLimit > 0) {
      apiPct = asPercentUsed((apiSpend / apiLimit) * 100);
    }
  } else {
    // REST fallback
    const fastUsed = numVal(root.numFastRequests ?? root.gpt4?.numRequests);
    const fastLimit = numVal(root.fastRequestsLimit ?? root.gpt4?.maxRequestUsage ?? root.gpt4?.numRequestsLimit);
    if (fastUsed !== undefined && fastLimit !== undefined && fastLimit > 0) {
      apiPct = asPercentUsed((fastUsed / fastLimit) * 100);
    }
  }

  if (apiPct !== undefined) {
    groups.push({
      id: "other-models",
      label: "Other Models",
      monthlyPct: apiPct,
      monthlyResetsAt: resetsAt,
      monthlyWindowLabel: "Other models used",
      onDemandUsed,
      onDemandCap
    });
  }

  // If neither auto nor api percent was found, fallback to total percent or spend
  if (groups.length === 0) {
    const totPct = asPercentUsed(planUsage?.totalPercentUsed ?? planUsage?.total_percent_used);
    const totSpend = numVal(planUsage?.totalSpend ?? planUsage?.total_spend);
    const lim = numVal(planUsage?.limit);
    let fallbackPct = totPct;
    if (fallbackPct === undefined && totSpend !== undefined && lim !== undefined && lim > 0) {
      fallbackPct = asPercentUsed((totSpend / lim) * 100);
    }
    groups.push({
      id: "default",
      label: "Cursor Usage",
      monthlyPct: fallbackPct,
      monthlyResetsAt: resetsAt,
      monthlyWindowLabel: "plan allowance used",
      onDemandUsed,
      onDemandCap
    });
  }

  // 3. Grok Bot (Weekly usage) — never inherit billing-cycle monthlyResetsAt
  if (sand) {
    const sandPct = asPercentUsed(sand.usagePercent ?? sand.usage_percent);
    const sandReset = parseDateMs(sand.nextResetTimestampUtc ?? sand.next_reset_timestamp_utc);
    if (sandPct !== undefined || sandReset !== undefined) {
      groups.push({
        id: "grok-bot",
        label: "Grok Bot",
        sevenDayPct: sandPct,
        sevenDayResetsAt: sandReset,
        longWindowLabel: "weekly usage"
      });
    }
  }

  // Base / Conversation-level flat fields:
  const primaryGroup = groups.find(g => g.id === "other-models") ?? groups[0];
  const grokBotGroup = groups.find(g => g.id === "grok-bot");

  const data = {
    plan,
    groups,
    monthlyPct: primaryGroup?.monthlyPct,
    monthlyResetsAt: resetsAt,
    monthlyWindowLabel: primaryGroup?.monthlyWindowLabel ?? "plan usage used",
    sevenDayPct: grokBotGroup?.sevenDayPct,
    sevenDayResetsAt: grokBotGroup?.sevenDayResetsAt,
    longWindowLabel: grokBotGroup?.longWindowLabel,
    onDemandUsed,
    onDemandCap,
    fetchedAt: Date.now()
  };

  if (sandInfo && typeof sandInfo === "object" && !("usagePercent" in sandInfo) && !("usage_percent" in sandInfo) && ("agentType" in sandInfo || "model" in sandInfo)) {
    return selectQuotaForContext(data, sandInfo);
  }
  if (context && typeof context === "object") {
    return selectQuotaForContext(data, context);
  }

  return data;
}

/** Keep billing-cycle / weekly reset timestamps when a later Cursor payload
 *  reports percent used but omits the reset date (partial dashboard response). */
export function stickyCursorQuota(prev, next) {
  if (!next || typeof next !== "object" || !prev || typeof prev !== "object") return next;
  const monthlyResetsAt = next.monthlyResetsAt ?? prev.monthlyResetsAt;
  const sevenDayResetsAt = next.sevenDayResetsAt ?? prev.sevenDayResetsAt;
  const groups = Array.isArray(next.groups)
    ? next.groups.map((g) => {
        if (!g || typeof g !== "object") return g;
        const out = { ...g };
        // Billing-cycle reset belongs on Cursor Models / Other Models only —
        // painting it onto grok-bot makes AllowanceRows show a phantom
        // "monthly credits used —" row under Grok Bot.
        if (
          out.id !== "grok-bot"
          && out.monthlyResetsAt === undefined
          && monthlyResetsAt !== undefined
        ) {
          out.monthlyResetsAt = monthlyResetsAt;
        }
        if (out.sevenDayResetsAt === undefined && sevenDayResetsAt !== undefined && out.id === "grok-bot") {
          out.sevenDayResetsAt = sevenDayResetsAt;
        }
        return out;
      })
    : next.groups;
  return {
    ...next,
    ...(monthlyResetsAt !== undefined ? { monthlyResetsAt } : {}),
    ...(sevenDayResetsAt !== undefined ? { sevenDayResetsAt } : {}),
    groups,
  };
}

/**
 * Filter quota metrics to the specific agent and model used in a conversation.
 * - Grok Bot agent -> weekly usage quota only.
 * - Cursor agent -> monthly usage quota based on last model used:
 *   - Composer or Grok models -> Cursor Models quota ("Cursor Grok and Composer used")
 *   - Other models -> Other Models quota ("Other models used")
 */
export function selectQuotaForContext(data, context = {}) {
  if (!data || typeof data !== "object") return data;
  const agentType = typeof context?.agentType === "string" ? context.agentType.trim().toLowerCase() : "";
  const model = typeof context?.model === "string" ? context.model.trim().toLowerCase() : "";

  const cursorModelsGroup = data.groups?.find(g => g.id === "cursor-models");
  const otherModelsGroup = data.groups?.find(g => g.id === "other-models");
  const grokBotGroup = data.groups?.find(g => g.id === "grok-bot");

  // 1. Grok Bot agent -> weekly usage only
  if (agentType === "grok-bot" || /grok-bot/i.test(agentType)) {
    return {
      plan: data.plan,
      groups: data.groups,
      sevenDayPct: grokBotGroup?.sevenDayPct,
      sevenDayResetsAt: grokBotGroup?.sevenDayResetsAt,
      longWindowLabel: grokBotGroup?.longWindowLabel ?? "weekly usage",
      fetchedAt: data.fetchedAt ?? Date.now()
    };
  }

  // 2. Cursor agent (or context where model was provided) -> select based on last model used
  if (agentType === "cursor" || /cursor/i.test(agentType) || model) {
    const isComposerOrGrok = /composer|grok/i.test(model);
    if (isComposerOrGrok) {
      const selected = cursorModelsGroup ?? data.groups?.[0];
      return {
        plan: data.plan,
        groups: data.groups,
        monthlyPct: selected?.monthlyPct,
        monthlyResetsAt: selected?.monthlyResetsAt ?? data.monthlyResetsAt,
        monthlyWindowLabel: selected?.monthlyWindowLabel ?? "Cursor Grok and Composer used",
        fetchedAt: data.fetchedAt ?? Date.now()
      };
    } else {
      const selected = otherModelsGroup ?? data.groups?.[0];
      return {
        plan: data.plan,
        groups: data.groups,
        monthlyPct: selected?.monthlyPct,
        monthlyResetsAt: selected?.monthlyResetsAt ?? data.monthlyResetsAt,
        monthlyWindowLabel: selected?.monthlyWindowLabel ?? "Other models used",
        onDemandUsed: selected?.onDemandUsed ?? data.onDemandUsed,
        onDemandCap: selected?.onDemandCap ?? data.onDemandCap,
        fetchedAt: data.fetchedAt ?? Date.now()
      };
    }
  }

  // 3. Fallback when called without context
  return data;
}

export default {
  activate(ctx) {
    async function getAccessToken(apiBase) {
      const directAuth = ctx.credentials.get("CURSOR_AUTH_TOKEN");
      if (directAuth) return { token: directAuth, isBearer: true };

      const apiKey = ctx.credentials.get("CURSOR_API_KEY");
      if (apiKey) {
        const now = Date.now();
        if (tokenCache && tokenCache.key === apiKey && tokenCache.expiresAt > now) {
          return { token: tokenCache.token, isBearer: true };
        }
        const res = await ctx.http.fetch(`${apiBase}/auth/exchange_user_api_key`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            throw new Error("Invalid or expired Cursor API Key.");
          }
          throw new Error(`Cursor key exchange failed: HTTP ${res.status}`);
        }
        const body = await res.json();
        const accessToken = body?.accessToken;
        if (!accessToken) throw new Error("Cursor key exchange did not return an access token.");
        tokenCache = {
          key: apiKey,
          token: accessToken,
          expiresAt: now + 15 * 60 * 1000
        };
        return { token: accessToken, isBearer: true };
      }

      const sessionToken = ctx.credentials.get("CURSOR_SESSION_TOKEN");
      if (sessionToken) {
        return { token: sessionToken, isCookie: true };
      }

      throw Object.assign(
        new Error("Cursor credentials not configured — set CURSOR_API_KEY in the Plugin Vault."),
        { code: "credential_missing" }
      );
    }

    async function fetchQuota(args = {}) {
      if (quotaCache && Date.now() - quotaCache.at < TTL_MS) {
        return selectQuotaForContext(quotaCache.data, args);
      }

      const settings = ctx.settings.get();
      const apiBase = String(settings.apiBaseUrl ?? "https://api2.cursor.sh").replace(/\/+$/, "");
      const webBase = String(settings.webBaseUrl ?? "https://cursor.com").replace(/\/+$/, "");

      const auth = await getAccessToken(apiBase);

      let usageBody = null;
      let planBody = null;
      let sandBody = null;

      if (auth.isBearer) {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": "Mozilla/5.0 (compatible; Tierwyn/1.0)"
        };

        const res = await ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(12_000)
        });

        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            throw new Error("Cursor credentials unauthorized or expired. Please update in Plugin Vault.");
          }
          throw new Error(`Cursor DashboardService error: HTTP ${res.status}`);
        }
        usageBody = await res.json();

        try {
          const pRes = await ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetPlanInfo`, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(8_000)
          });
          if (pRes.ok) planBody = await pRes.json();
        } catch { /* optional */ }

        try {
          const sRes = await ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetSandUsageStatus`, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(8_000)
          });
          if (sRes.ok) sandBody = await sRes.json();
        } catch { /* optional */ }

      } else if (auth.isCookie) {
        const res = await ctx.http.fetch(`${webBase}/api/usage`, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Tierwyn/1.0)",
            Accept: "application/json",
            Cookie: `WorkosCursorSessionToken=${auth.token}`
          },
          signal: AbortSignal.timeout(12_000)
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            throw new Error("Cursor credentials unauthorized or expired. Please update in Plugin Vault.");
          }
          throw new Error(`Cursor web API error: HTTP ${res.status}`);
        }
        usageBody = await res.json();
      }

      let data = parseCursorUsageJson(usageBody, planBody, sandBody);
      if (quotaCache?.data) data = stickyCursorQuota(quotaCache.data, data);
      quotaCache = { at: Date.now(), data };
      return selectQuotaForContext(data, args);
    }

    async function fetchInsights() {
      if (insightsCache && Date.now() - insightsCache.at < TTL_MS) {
        return insightsCache.data;
      }

      const settings = ctx.settings.get();
      const apiBase = String(settings.apiBaseUrl ?? "https://api2.cursor.sh").replace(/\/+$/, "");
      const auth = await getAccessToken(apiBase);

      if (!auth.isBearer) {
        throw new Error("Cursor Insights requires CURSOR_API_KEY (or CURSOR_AUTH_TOKEN).");
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        "User-Agent": "Mozilla/5.0 (compatible; Tierwyn/1.0)"
      };

      let meBody = null;
      let usageBody = null;
      let planBody = null;
      let sandBody = null;
      let dailySpendBody = null;
      let hardLimitBody = null;
      let analyticsBody = null;

      try {
        const meRes = await ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetMe`, {
          method: "POST", headers, body: JSON.stringify({}), signal: AbortSignal.timeout(10_000)
        });
        if (meRes.ok) meBody = await meRes.json();
      } catch { /* optional */ }

      const userId = numVal(meBody?.userId ?? meBody?.user_id);
      const teamId = numVal(meBody?.teamId ?? meBody?.team_id) ?? 0;

      // Parallel fetch all dashboard metrics
      await Promise.allSettled([
        ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
          method: "POST", headers, body: JSON.stringify({}), signal: AbortSignal.timeout(12_000)
        }).then(async r => { if (r.ok) usageBody = await r.json(); }),

        ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetPlanInfo`, {
          method: "POST", headers, body: JSON.stringify({}), signal: AbortSignal.timeout(10_000)
        }).then(async r => { if (r.ok) planBody = await r.json(); }),

        ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetSandUsageStatus`, {
          method: "POST", headers, body: JSON.stringify({}), signal: AbortSignal.timeout(10_000)
        }).then(async r => { if (r.ok) sandBody = await r.json(); }),

        ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetDailySpendByCategory`, {
          method: "POST", headers, body: JSON.stringify({}), signal: AbortSignal.timeout(12_000)
        }).then(async r => { if (r.ok) dailySpendBody = await r.json(); }),

        ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetHardLimit`, {
          method: "POST", headers, body: JSON.stringify({}), signal: AbortSignal.timeout(10_000)
        }).then(async r => { if (r.ok) hardLimitBody = await r.json(); }),

        ctx.http.fetch(`${apiBase}/aiserver.v1.DashboardService/GetUserAnalytics`, {
          method: "POST",
          headers,
          body: JSON.stringify({ user_id: userId, team_id: teamId }),
          signal: AbortSignal.timeout(12_000)
        }).then(async r => { if (r.ok) analyticsBody = await r.json(); })
      ]);

      const baseQuota = parseCursorUsageJson(usageBody, planBody, sandBody);

      // Parse user profile
      const email = typeof meBody?.email === "string" ? meBody.email : undefined;
      const firstName = typeof meBody?.firstName === "string" ? meBody.firstName : (typeof meBody?.first_name === "string" ? meBody.first_name : "");
      const lastName = typeof meBody?.lastName === "string" ? meBody.lastName : (typeof meBody?.last_name === "string" ? meBody.last_name : "");
      const displayName = [firstName, lastName].filter(Boolean).join(" ") || undefined;
      const teamName = typeof meBody?.teamName === "string" ? meBody.teamName : (typeof meBody?.team_name === "string" ? meBody.team_name : undefined);

      // Parse daily spend breakdown
      const rawDaily = Array.isArray(dailySpendBody?.dailySpend) ? dailySpendBody.dailySpend : (Array.isArray(dailySpendBody?.daily_spend) ? dailySpendBody.daily_spend : []);
      const dailySpend = rawDaily.map(d => {
        const dayMs = parseDateMs(d.day);
        const spendCents = numVal(d.spendCents ?? d.spend_cents) ?? 0;
        const totalTokens = numVal(d.totalTokens ?? d.total_tokens);
        return {
          day: dayMs ?? Date.now(),
          category: String(d.category ?? "Unknown"),
          spendCents,
          ...(totalTokens !== undefined ? { totalTokens } : {})
        };
      });

      // Parse activity metrics
      let activitySummary = undefined;
      const dailyMetrics = Array.isArray(analyticsBody?.dailyMetrics)
        ? analyticsBody.dailyMetrics
        : (Array.isArray(analyticsBody?.daily_metrics) ? analyticsBody.daily_metrics : []);

      if (dailyMetrics.length > 0) {
        let subReqs = 0;
        let usageReqs = 0;
        let apiReqs = 0;
        let composerReqs = 0;
        let chatReqs = 0;
        let agentReqs = 0;
        let cmdk = 0;
        let bugbot = 0;
        let tabsAccepted = 0;
        let tabsShown = 0;
        let appliesAccepted = 0;
        let appliesRejected = 0;
        let linesAccepted = 0;
        const modelCounts = {};

        for (const m of dailyMetrics) {
          subReqs += numVal(m.subscriptionIncludedReqs ?? m.subscription_included_reqs) ?? 0;
          usageReqs += numVal(m.usageBasedReqs ?? m.usage_based_reqs) ?? 0;
          apiReqs += numVal(m.apiKeyReqs ?? m.api_key_reqs) ?? 0;
          composerReqs += numVal(m.composerRequests ?? m.composer_requests) ?? 0;
          chatReqs += numVal(m.chatRequests ?? m.chat_requests) ?? 0;
          agentReqs += numVal(m.agentRequests ?? m.agent_requests) ?? 0;
          cmdk += numVal(m.cmdkUsages ?? m.cmdk_usages) ?? 0;
          bugbot += numVal(m.bugbotUsages ?? m.bugbot_usages) ?? 0;
          tabsAccepted += numVal(m.totalTabsAccepted ?? m.total_tabs_accepted) ?? 0;
          tabsShown += numVal(m.totalTabsShown ?? m.total_tabs_shown) ?? 0;
          appliesAccepted += numVal(m.totalAccepts ?? m.total_accepts) ?? 0;
          appliesRejected += numVal(m.totalRejects ?? m.total_rejects) ?? 0;
          linesAccepted += numVal(m.acceptedLinesAdded ?? m.accepted_lines_added) ?? 0;

          const models = Array.isArray(m.modelUsage) ? m.modelUsage : (Array.isArray(m.model_usage) ? m.model_usage : []);
          for (const mu of models) {
            const name = String(mu.modelName ?? mu.model_name ?? mu.name ?? "");
            const count = numVal(mu.count ?? mu.requests ?? mu.usages) ?? 1;
            if (name) modelCounts[name] = (modelCounts[name] ?? 0) + count;
          }
        }

        let mostUsedModel = undefined;
        let maxCount = 0;
        for (const [model, cnt] of Object.entries(modelCounts)) {
          if (cnt > maxCount) {
            maxCount = cnt;
            mostUsedModel = model;
          }
        }

        const tabAcceptancePct = tabsShown > 0 ? Math.round((tabsAccepted / tabsShown) * 1000) / 10 : undefined;
        const totalDiffs = appliesAccepted + appliesRejected;
        const diffAcceptancePct = totalDiffs > 0 ? Math.round((appliesAccepted / totalDiffs) * 1000) / 10 : undefined;

        activitySummary = {
          subscriptionIncludedRequests: subReqs,
          usageBasedRequests: usageReqs,
          apiKeyRequests: apiReqs,
          composerRequests: composerReqs,
          chatRequests: chatReqs,
          agentRequests: agentReqs,
          cmdkUsages: cmdk,
          bugbotUsages: bugbot,
          totalTabsAccepted: tabsAccepted,
          totalTabsShown: tabsShown,
          tabAcceptancePct,
          totalAppliesAccepted: appliesAccepted,
          totalAppliesRejected: appliesRejected,
          diffAcceptancePct,
          acceptedLinesAdded: linesAccepted,
          mostUsedModel
        };
      }

      const categories = Array.isArray(dailySpendBody?.categories) ? dailySpendBody.categories : undefined;
      const hardLimitDollars = numVal(hardLimitBody?.hardLimit ?? hardLimitBody?.hard_limit ?? hardLimitBody?.perUserMonthlyLimitDollars ?? hardLimitBody?.per_user_monthly_limit_dollars);
      const noUsageBasedAllowed = typeof hardLimitBody?.noUsageBasedAllowed === "boolean" ? hardLimitBody.noUsageBasedAllowed : (typeof hardLimitBody?.no_usage_based_allowed === "boolean" ? hardLimitBody.no_usage_based_allowed : undefined);

      const insightsData = {
        subscriptionType: baseQuota.plan,
        email,
        displayName,
        teamName,
        billingCycleStart: parseDateMs(usageBody?.billingCycleStart ?? usageBody?.billing_cycle_start),
        billingCycleEnd: baseQuota.monthlyResetsAt,
        groups: baseQuota.groups,
        categories,
        dailySpend,
        activitySummary,
        hardLimitDollars,
        noUsageBasedAllowed,
        updatedAt: Date.now()
      };

      insightsCache = { at: Date.now(), data: insightsData };
      return insightsData;
    }

    ctx.capability("usage.get", async (input) => fetchQuota(input && typeof input === "object" ? input : {}));
    ctx.capability("insights.get", async () => fetchInsights());
  }
};
