import type { AgentSelfTimersMode } from '@tierwyn/shared';
import { envPref } from '../config/env.js';

/** How deep spawn chains may go (spawn-policy depth via spawnPolicyDepth).
 *  Policy root = 0 (true roots + schedule ⏱ runs under schedule_home); a
 *  conversation at depth >= MAX_SPAWN_DEPTH may not spawn. Default 5. Tunable
 *  via TIERWYN_MAX_SPAWN_DEPTH. Not
 *  sufficient alone — preamble gate must also permit the depth, and non-root
 *  parents need maxGrandchildSpawns > 0. */
export const MAX_SPAWN_DEPTH = parseMaxSpawnDepth(envPref('MAX_SPAWN_DEPTH'));

function parseMaxSpawnDepth(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 5;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 5;
  return n;
}

/** TIERWYN_AGENT_SELF_TIMERS: who may POST /conversations/:id/timers/agent.
 *  level0 (default) = roots only; all = any conversation; off = disabled.
 *  Unknown values fall back to level0 — a typo must never widen to all. */
export function parseAgentSelfTimersMode(raw: string | undefined): AgentSelfTimersMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'all' || v === 'off' || v === 'level0') return v;
  if (v !== '') console.warn(`[config] TIERWYN_AGENT_SELF_TIMERS=${raw} is not level0|all|off — using level0`);
  return 'level0';
}
export const AGENT_SELF_TIMERS = parseAgentSelfTimersMode(envPref('AGENT_SELF_TIMERS'));

