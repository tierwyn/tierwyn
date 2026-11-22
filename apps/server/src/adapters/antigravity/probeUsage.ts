import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type { AntigravityInsights, AntigravityGroupDetail, AntigravityBucketDetail, AntigravitySkill, AntigravityPermissionScope } from '@tierwyn/shared';
import type { ProbedRateLimits } from '../claude-code/probeUsage.js';

export type { ProbedRateLimits };

export const AGY_USAGE_PROBE_ARGS = ['--print', '/usage', '--output-format', 'json'] as const;
export const AGY_CREDITS_PROBE_ARGS = ['--print', '/credits', '--output-format', 'json'] as const;
export const AGY_SKILLS_PROBE_ARGS = ['--print', '/skills', '--output-format', 'json'] as const;
export const AGY_PERMISSIONS_PROBE_ARGS = ['--print', '/permissions', '--output-format', 'json'] as const;

const TTL_MS = 20_000;
const TIMEOUT_MS = 8_000;

let cache: { at: number; raw: unknown } | undefined;
let inflight: Promise<unknown> | undefined;

let insightsCache: { at: number; insights: AntigravityInsights } | undefined;
let insightsInflight: Promise<AntigravityInsights> | undefined;

export type AgyUsageSpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export function resetAgyUsageProbeForTests(): void {
  cache = undefined;
  inflight = undefined;
  insightsCache = undefined;
  insightsInflight = undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

interface AgyBucket {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
}

export interface AgyUsageGroup {
  id: string;
  label: string;
  limits: ProbedRateLimits;
}

function usedPct(remaining: unknown): number | undefined {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined;
  return Math.min(100, Math.max(0, (1 - remaining) * 100));
}

function resetMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function slugifyLabel(label: string, index: number): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `group-${index}`;
}

function limitsFromBuckets(buckets: unknown): ProbedRateLimits {
  if (!Array.isArray(buckets)) return {};
  const out: ProbedRateLimits = {};
  for (const b of buckets) {
    const bucket = asRecord(b) as AgyBucket | undefined;
    if (!bucket) continue;
    const window = String(bucket.window ?? '');
    const pct = usedPct(bucket.remaining_fraction);
    const at = resetMs(bucket.reset_time);
    if (window === '5h') {
      if (pct !== undefined) out.fiveHourPct = pct;
      if (at !== undefined) out.fiveHourResetsAt = at;
    } else if (window === 'weekly') {
      if (pct !== undefined) out.sevenDayPct = pct;
      if (at !== undefined) out.sevenDayResetsAt = at;
    }
  }
  return out;
}

/** All quota groups from one `agy /usage` payload, in payload order. */
export function parseAgyUsageGroups(raw: unknown): AgyUsageGroup[] {
  const root = asRecord(raw);
  const command = asRecord(root?.command);
  const data = asRecord(command?.data);
  const groupsRaw = data?.groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) return [];

  const out: AgyUsageGroup[] = [];
  for (let i = 0; i < groupsRaw.length; i++) {
    const rec = asRecord(groupsRaw[i]);
    if (!rec) continue;
    const label = typeof rec.name === 'string' ? rec.name : String(rec.name ?? '');
    out.push({
      id: slugifyLabel(label, i),
      label,
      limits: limitsFromBuckets(rec.buckets),
    });
  }
  return out;
}

function pickGroup(groups: AgyUsageGroup[], modelSlug: string): AgyUsageGroup | undefined {
  if (groups.length === 0) return undefined;
  const slug = modelSlug.toLowerCase();
  const nameOf = (g: AgyUsageGroup) => g.label;

  if (/\bgemini\b/.test(slug)) {
    return groups.find((g) => /gemini/i.test(nameOf(g))) ?? groups[0];
  }
  if (/\b(claude|gpt)\b/.test(slug)) {
    return groups.find((g) => /claude|gpt/i.test(nameOf(g))) ?? groups[0];
  }
  return groups.find((g) => /gemini/i.test(nameOf(g))) ?? groups[0];
}

/** Map verified `agy --print "/usage"` JSON onto Claude-style used-percent rate limits. */
export function parseAgyUsageJson(raw: unknown, modelSlug: string): ProbedRateLimits {
  const root = asRecord(raw);
  const command = asRecord(root?.command);
  const data = asRecord(command?.data);
  const group = pickGroup(parseAgyUsageGroups(raw), modelSlug);
  const limits: ProbedRateLimits = { ...(group?.limits ?? {}) };
  const sub = typeof data?.subscription_type === 'string' ? data.subscription_type
    : typeof data?.subscriptionType === 'string' ? data.subscriptionType
    : typeof data?.plan === 'string' ? data.plan
    : typeof data?.tier === 'string' ? data.tier
    : undefined;
  if (sub && !limits.subscriptionType) {
    limits.subscriptionType = sub;
  }
  return limits;
}

/** Extract full Antigravity insights from combined raw payloads. */
export function parseAgyInsights(
  usageRaw: unknown,
  creditsRaw?: unknown,
  skillsRaw?: unknown,
  permissionsRaw?: unknown,
): AntigravityInsights {
  const usageRoot = asRecord(usageRaw);
  const usageCmd = asRecord(usageRoot?.command);
  const usageData = asRecord(usageCmd?.data);

  const policyDescription = typeof usageData?.description === 'string' ? usageData.description : undefined;

  const rawGroups = Array.isArray(usageData?.groups) ? usageData.groups : [];
  const groups: AntigravityGroupDetail[] = [];

  for (let i = 0; i < rawGroups.length; i++) {
    const g = asRecord(rawGroups[i]);
    if (!g) continue;
    const name = typeof g.name === 'string' ? g.name : `Group ${i + 1}`;
    const desc = typeof g.description === 'string' ? g.description : undefined;
    const buckets: AntigravityBucketDetail[] = [];

    if (Array.isArray(g.buckets)) {
      for (const b of g.buckets) {
        const bucket = asRecord(b) as AgyBucket | undefined;
        if (!bucket) continue;
        const window = String(bucket.window ?? '');
        const fraction = typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 1;
        const pct = usedPct(fraction) ?? 0;
        const resetTime = typeof bucket.reset_time === 'string' ? bucket.reset_time : undefined;
        const resetsAt = resetMs(resetTime);

        buckets.push({
          id: typeof bucket.id === 'string' ? bucket.id : `${window}-bucket`,
          name: typeof bucket.name === 'string' ? bucket.name : `${window} Limit`,
          description: typeof bucket.description === 'string' ? bucket.description : undefined,
          window,
          remainingFraction: fraction,
          usedPct: pct,
          resetTime,
          resetsAt,
        });
      }
    }

    groups.push({
      id: slugifyLabel(name, i),
      name,
      description: desc,
      buckets,
    });
  }

  // Parse credits
  let remainingCredits: number | undefined;
  let upgradeUri: string | undefined;
  const creditsRoot = asRecord(creditsRaw);
  const creditsCmd = asRecord(creditsRoot?.command);
  const creditsData = asRecord(creditsCmd?.data);
  if (typeof creditsData?.remaining_credits === 'number') {
    remainingCredits = creditsData.remaining_credits;
  }
  if (typeof creditsData?.upgrade_uri === 'string') {
    try {
      const u = new URL(creditsData.upgrade_uri);
      if (u.protocol === 'https:') upgradeUri = u.toString();
    } catch { /* drop javascript:/data:/relative */ }
  }

  // Parse skills
  const skills: AntigravitySkill[] = [];
  const skillsRoot = asRecord(skillsRaw);
  const skillsCmd = asRecord(skillsRoot?.command);
  const skillsData = asRecord(skillsCmd?.data);
  const rawSkillsList = Array.isArray(skillsData?.commands) ? skillsData.commands : [];
  for (const s of rawSkillsList) {
    const item = asRecord(s);
    if (!item || typeof item.name !== 'string') continue;
    skills.push({
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      path: typeof item.path === 'string' ? item.path : undefined,
      plugin: typeof item.plugin === 'string' ? item.plugin : undefined,
      builtin: typeof item.builtin === 'boolean' ? item.builtin : undefined,
      modelInvocable: typeof item.model_invocable === 'boolean' ? item.model_invocable : undefined,
    });
  }

  // Parse permissions
  const permissions: AntigravityPermissionScope[] = [];
  const permRoot = asRecord(permissionsRaw);
  const permCmd = asRecord(permRoot?.command);
  const permData = asRecord(permCmd?.data);
  const rawPermList = Array.isArray(permData?.permissions) ? permData.permissions : [];
  for (const p of rawPermList) {
    const item = asRecord(p);
    if (!item || typeof item.scope !== 'string') continue;
    const allow = Array.isArray(item.allow) ? item.allow.map(String) : undefined;
    permissions.push({
      scope: item.scope,
      allow,
    });
  }

  return {
    remainingCredits,
    upgradeUri,
    policyDescription,
    groups,
    skills,
    permissions,
    updatedAt: Date.now(),
  };
}

async function runAgyCommand(
  args: readonly string[],
  opts?: { cwd?: string; spawnFn?: AgyUsageSpawnFn },
): Promise<unknown> {
  const spawnFn = opts?.spawnFn ?? ((cmd, a, o) => nodeSpawn(cmd, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'antigravity') }));
  let child: ChildProcess;
  try {
    child = spawnFn('agy', [...args], { cwd: opts?.cwd });
  } catch {
    return undefined;
  }

  const chunks: string[] = [];
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
  child.stdin?.on('error', () => {});
  child.stdin?.end();

  return new Promise<unknown>((resolve) => {
    const finish = (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish(undefined);
    }, TIMEOUT_MS);

    child.on('error', () => finish(undefined));
    child.on('close', () => {
      try {
        finish(JSON.parse(chunks.join('').trim()) as unknown);
      } catch {
        finish(undefined);
      }
    });
  });
}

async function rawPayload(opts?: {
  cwd?: string;
  force?: boolean;
  spawnFn?: AgyUsageSpawnFn;
}): Promise<unknown> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) {
    return cache.raw;
  }
  if (!inflight) {
    inflight = runAgyCommand(AGY_USAGE_PROBE_ARGS, opts).then((raw) => {
      cache = { at: Date.now(), raw };
      return raw;
    }).finally(() => { inflight = undefined; });
  }
  return inflight;
}

export async function probeAgyRateLimits(opts?: {
  model?: string;
  cwd?: string;
  force?: boolean;
  spawnFn?: AgyUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  return parseAgyUsageJson(await rawPayload(opts), opts?.model ?? '');
}

export async function probeAgyUsageGroups(opts?: {
  cwd?: string;
  force?: boolean;
  spawnFn?: AgyUsageSpawnFn;
}): Promise<AgyUsageGroup[]> {
  return parseAgyUsageGroups(await rawPayload(opts));
}

export async function probeAntigravityInsights(opts?: {
  cwd?: string;
  force?: boolean;
  spawnFn?: AgyUsageSpawnFn;
}): Promise<AntigravityInsights> {
  if (!opts?.force && insightsCache && Date.now() - insightsCache.at < TTL_MS) {
    return insightsCache.insights;
  }
  if (!insightsInflight) {
    insightsInflight = Promise.all([
      runAgyCommand(AGY_USAGE_PROBE_ARGS, opts),
      runAgyCommand(AGY_CREDITS_PROBE_ARGS, opts),
      runAgyCommand(AGY_SKILLS_PROBE_ARGS, opts),
      runAgyCommand(AGY_PERMISSIONS_PROBE_ARGS, opts),
    ]).then(([usageRaw, creditsRaw, skillsRaw, permissionsRaw]) => {
      const insights = parseAgyInsights(usageRaw, creditsRaw, skillsRaw, permissionsRaw);
      insightsCache = { at: Date.now(), insights };
      return insights;
    }).finally(() => {
      insightsInflight = undefined;
    });
  }
  return insightsInflight;
}
