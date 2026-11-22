import type { Database } from 'better-sqlite3';
import type {
  AgentUsageAgentView,
  AgentUsageGroup,
  CompactionSettings,
  UsageProviderCard,
} from '@tierwyn/shared';

export const USAGE_CONFIRM_PCT = 99;
export const RESET_GRACE_MS = 120_000;
export const LAYER3_MIN_INTERVAL_MS = 60_000;
export const LAYER3_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const AUTO_RESUME_SWEEP_CAP = 10;
export const AUTO_RESUME_JITTER_MS = 60_000;
export const DEFAULT_RESET_DELAY_MS = 60 * 60 * 1000;

export interface LimitCandidate {
  conversationId: string;
  sessionId: string;
  at: number;
  reason: 'error_text' | 'final_prose' | 'degenerate';
}

export type ProbeVerdict =
  | { kind: 'limited'; resetsAt: number | null; cardLabel: string }
  | { kind: 'headroom' }
  | { kind: 'unclassified' };

export interface Layer2Action {
  conversationId: string;
  verdict: ProbeVerdict;
}

/**
 * [S2-5] The watcher's own push shape. Deliberately NOT NotificationInput:
 * reusing category 'conversationComplete' + agentStatus 'error' made the
 * watcher render as "Failed" with the completion tag `tierwyn:conv:<id>`,
 * indistinguishable from a real completion push. The caller delivers this
 * with the `tierwyn:usage:<id>` tag and [usage-watcher] identity.
 */
export interface UsageWatcherNotification {
  tag: string;
  title: string;
  body: string;
  conversationId: string;
}

export interface UsageCardInput {
  id?: string;
  label?: string;
  groups?: AgentUsageGroup[];
  error?: string;
  installed?: boolean;
  ok?: boolean;
}

/** Credits are exhausted only when both sides are known and used >= limit. */
export function isLimitedGroup(g: AgentUsageGroup): boolean {
  if (g.creditsLimit != null && g.creditsUsed != null && g.creditsUsed >= g.creditsLimit) return true;
  return (
    (g.fiveHourPct != null && g.fiveHourPct >= USAGE_CONFIRM_PCT) ||
    (g.sevenDayPct != null && g.sevenDayPct >= USAGE_CONFIRM_PCT) ||
    (g.monthlyPct != null && g.monthlyPct >= USAGE_CONFIRM_PCT)
  );
}

export function earliestResetsAt(g: AgentUsageGroup): number | undefined {
  const candidates = [g.fiveHourResetsAt, g.sevenDayResetsAt, g.monthlyResetsAt]
    .filter((t): t is number => t != null);
  return candidates.length ? Math.min(...candidates) : undefined;
}

/**
 * [S2-4b] Provider card whose stamped `profiles` route this exact
 * agentType+model. Providers are addressed by their profiles, never by
 * `p.id === agentType` (agent types are not plugin ids).
 */
export function findUsageProvider(
  providers: UsageProviderCard[],
  agentType: string,
  model: string,
): UsageProviderCard | undefined {
  return providers.find(
    (p) => p.profiles?.some((r) => r.agentType === agentType && r.model === model),
  );
}

/**
 * [S2-4b] Builtin card for this agentType whose stamped profiles include this
 * exact model. No any-model fallback: a stale model must not win the probe.
 */
export function findBuiltinUsageCard(
  builtins: AgentUsageAgentView[],
  agentType: string,
  model: string,
): AgentUsageAgentView | undefined {
  return builtins.find(
    (c) => c.agentType === agentType && c.profiles?.some((r) => r.agentType === agentType && r.model === model),
  );
}

export function classifyUsageCard(card: UsageCardInput): ProbeVerdict {
  if (card.error || card.installed === false || card.ok === false) return { kind: 'unclassified' };
  const groups = card.groups ?? [];
  // S2-4a: an ok card with no groups carries no numbers — headroom cannot be
  // computed from nothing. The caller logs this as an unclassified probe and
  // notifies; it never silently drops as headroom.
  if (groups.length === 0) return { kind: 'unclassified' };
  const limited = groups.filter(isLimitedGroup);
  if (limited.length > 0) {
    const resets = limited
      .map(earliestResetsAt)
      .filter((t): t is number => t != null);
    return {
      kind: 'limited',
      resetsAt: resets.length ? Math.min(...resets) : null,
      cardLabel: card.label ?? card.id ?? '',
    };
  }
  return { kind: 'headroom' };
}

export interface UsageLimitWatcherDeps {
  getDb: () => Database;
  now?: () => number;
  probeCard: (agentType: string, model: string) => Promise<UsageCardInput>;
  notify?: (push: UsageWatcherNotification) => void;
  log?: (line: string) => void; // default console.log with [usage-watcher] prefix
  /** [S2-5] False means this agent/model has no usage card at all — quota
   * text on such an agent is noise, so arm() drops it (and says so). */
  hasUsageCard?: (agentType: string, model: string) => boolean;
  listProfiles?: () => Array<{ id: string; agentType: string; model: string; enabled: boolean }>;
  findUsageProviderForAgent?: (agentType?: string, model?: string) => { pluginId: string } | undefined;
  hasLiveSession?: (conversationId: string) => boolean;
  getSettings?: () => CompactionSettings;
}

export interface UsageLimitWatcher {
  arm(c: LimitCandidate): void;
  drainLayer2(now: number): Promise<Layer2Action[]>;
  // sweepLayer3 is added in Phase 6; omitted in Phase 5.
}

interface ResolvedAgent {
  agentType: string;
  model: string;
}

export function createUsageLimitWatcher(deps: UsageLimitWatcherDeps): UsageLimitWatcher {
  // Layer 1: in-memory, last arm wins. Lost on restart (layer 3 re-derives in Phase 6).
  const armed = new Map<string, LimitCandidate>();
  const log = (line: string): void => {
    if (deps.log) deps.log(line);
    else console.log(`[usage-watcher] ${line}`);
  };

  /** [S3-8] The session row that produced the quota signal — NOT the
   *  conversation's most recent session, which can be a different agent. */
  function sessionAgent(sessionId: string): ResolvedAgent | undefined {
    const row = deps.getDb().prepare(
      `SELECT a.type AS agentType, m.model_name AS model
         FROM sessions s
         JOIN agents a ON a.id = s.agent_id
        LEFT JOIN agent_models m ON m.id = s.agent_model_id
        WHERE s.id = ?`,
    ).get(sessionId) as { agentType: string; model: string | null } | undefined;
    if (!row) return undefined;
    return { agentType: row.agentType, model: row.model ?? '' };
  }

  function conversationTitle(conversationId: string): string | undefined {
    const row = deps.getDb().prepare(
      `SELECT title FROM conversations WHERE id = ?`,
    ).get(conversationId) as { title: string | null } | undefined;
    return row?.title ?? undefined;
  }

  return {
    arm(c: LimitCandidate): void {
      // [S2-5] Never arm an agent with no usage card at all — quota-looking
      // text there is noise. Log the drop so silence is auditable.
      const resolved = sessionAgent(c.sessionId);
      if (resolved && deps.hasUsageCard && !deps.hasUsageCard(resolved.agentType, resolved.model)) {
        log(
          `dropped arm for conversation ${c.conversationId} — ` +
            `${resolved.agentType}:${resolved.model} has no usage card (reason ${c.reason})`,
        );
        return;
      }
      log(`armed conversation ${c.conversationId} (session ${c.sessionId}, reason ${c.reason})`);
      armed.set(c.conversationId, c);
    },

    async drainLayer2(_now: number): Promise<Layer2Action[]> {
      const candidates = [...armed.values()];
      armed.clear();
      if (candidates.length === 0) return [];

      // Group candidates by the signalling session's agentType:model BEFORE
      // probing, so 10 children on the same pool cost one probe, not ten.
      const groups = new Map<string, { probe: ResolvedAgent; candidates: LimitCandidate[] }>();
      for (const c of candidates) {
        const resolved = sessionAgent(c.sessionId);
        if (!resolved) {
          // [S2-5] every drop is logged, never silent.
          log(`dropped arm for conversation ${c.conversationId} — no session row for the signal`);
          continue;
        }
        const key = `${resolved.agentType}:${resolved.model}`;
        const bucket = groups.get(key);
        if (bucket) bucket.candidates.push(c);
        else groups.set(key, { probe: resolved, candidates: [c] });
      }

      const actions: Layer2Action[] = [];
      for (const { probe, candidates: bucket } of groups.values()) {
        // [S3-1] A throwing probe must not nuke the whole drain — the armed
        // map is already cleared above, so an escaped rejection would lose
        // every remaining candidate. Degrade this bucket to the unclassified
        // path and keep going.
        let verdict: ProbeVerdict;
        try {
          verdict = classifyUsageCard(await deps.probeCard(probe.agentType, probe.model));
        } catch (err) {
          log(
            `probe threw for ${probe.agentType}:${probe.model} — ` +
              `${err instanceof Error ? err.message : String(err)}; treating as unclassified`,
          );
          verdict = { kind: 'unclassified' };
        }
        if (verdict.kind === 'headroom') {
          // [S2-5] drop with reason — never silent.
          for (const c of bucket) {
            log(`dropped arm for conversation ${c.conversationId} — probe shows headroom`);
          }
          continue;
        }
        for (const c of bucket) {
          actions.push({ conversationId: c.conversationId, verdict });
          const title = conversationTitle(c.conversationId);
          const resetsSuffix =
            verdict.kind === 'limited' && verdict.resetsAt != null
              ? ` (resets ${new Date(verdict.resetsAt).toISOString()})`
              : '';
          if (verdict.kind === 'limited') {
            log(
              `confirmed limited for conversation ${c.conversationId} (${verdict.cardLabel}` +
                `${resetsSuffix}) — ` +
                'watcher did NOT resume (notification only)',
            );
          } else {
            log(
              `unclassified probe for conversation ${c.conversationId} (suspected: ${c.reason}) — ` +
                'watcher did NOT resume (notification only)',
            );
          }
          // [S2-5] Distinct tag + [usage-watcher] identity: this must never
          // render as a failed-conversation completion push.
          deps.notify?.({
            tag: `tierwyn:usage:${c.conversationId}`,
            title: `[usage-watcher] ${title ?? c.conversationId}`,
            body:
              verdict.kind === 'limited'
                ? `[usage-watcher] usage limit confirmed: ${verdict.cardLabel}${resetsSuffix} — ` +
                  'watcher did NOT resume (notification only)'
                : `[usage-watcher] usage limit suspected: ${c.reason} — probe unclassified; ` +
                  'watcher did NOT resume (notification only)',
            conversationId: c.conversationId,
          });
        }
      }
      return actions;
    },
  };
}
