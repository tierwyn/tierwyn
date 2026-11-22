/**
 * Artificial Analysis catalogue: boot-captured env key, 24 h in-memory cache,
 * slug matcher, template-draft formatter.
 *
 * ponytail: in-memory only — a refresh costs 4 of 100 daily requests and prod
 * restarts are rare. Upgrade path: a settings row (no migration) if restarts
 * start costing quota.
 */
import type { AgentProfile } from '@tierwyn/shared';
import type { Database } from 'better-sqlite3';
import { MIN_SECRET_LEN } from '../plugins/host.js';
import { vaultAvailable, vaultGet } from '../plugins/vault.js';
import { safeFetch } from '../net/outboundUrl.js';

export const AA_VAULT_NS = 'tierwyn:integrations';
export const AA_VAULT_KEY = 'ARTIFICIAL_ANALYSIS_API_KEY';
export const AA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const AA_PAGE_SIZE = 200;
const AA_MAX_PAGES = 8;
const AA_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';

const SKIP_MODELS = new Set(['auto', 'default', 'deepseek-chat', 'deepseek-reasoner']);
const PREFIXES = [
  'zai:', 'zai/', 'z.ai/', 'zai-coding-plan/', 'deepseek-official/', 'openrouter/', 'cursor-',
];
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max|thinking|fast|highspeed|non-reasoning)$/;

export type AaMatchKind = 'override' | 'exact' | 'alias' | 'base' | 'none';

export type AaRow = {
  slug: string;
  name: string;
  intel: number | null;
  eng: number | null;
  priceIn: number | null;
  priceOut: number | null;
  tps: number | null;
  releaseDate: string | null;
};

export type AaMetrics = {
  intel: number | null;
  eng: number | null;
  priceIn: number | null;
  priceOut: number | null;
  tps: number | null;
};

export type AaErrorCode = 'aa_unauthorized' | 'aa_tier' | 'aa_quota' | 'aa_unreachable';

export class AaError extends Error {
  readonly code: AaErrorCode;
  readonly retryAfter?: string;
  constructor(code: AaErrorCode, retryAfter?: string) {
    super(code);
    this.name = 'AaError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

type Cache = { rows: AaRow[]; tier: string; indexVersion: number; fetchedAt: number };

let cache: Cache | null = null;
let inflight: Promise<{ rows: AaRow[]; tier: string; fetchedAt: number; stale?: true }> | null = null;
let capturedKey: string | null = null;

export const aaDeps = {
  fetch: safeFetch,
  now: () => Date.now(),
};

export function captureAaEnv(env: { TIERWYN_AA_API_KEY?: string } = process.env): void {
  const v = env.TIERWYN_AA_API_KEY;
  if (typeof v === 'string' && v.length >= MIN_SECRET_LEN) capturedKey = v;
  delete env.TIERWYN_AA_API_KEY;
}

export function capturedAaEnvValue(): string | undefined {
  return capturedKey ?? undefined;
}

export function resolveAaKey(db: Database): { key: string; source: 'vault' | 'env' } | null {
  if (vaultAvailable()) {
    try {
      const hit = vaultGet(db, AA_VAULT_NS, AA_VAULT_KEY);
      if (hit?.value && hit.value.length >= MIN_SECRET_LEN) return { key: hit.value, source: 'vault' };
    } catch { /* key mismatch / decrypt — fall through to env */ }
  }
  if (capturedKey && capturedKey.length >= MIN_SECRET_LEN) return { key: capturedKey, source: 'env' };
  return null;
}

export function dropAaCache(): void {
  cache = null;
}

export function peekAaCache(): { tier: string; fetchedAt: number } | null {
  return cache ? { tier: cache.tier, fetchedAt: cache.fetchedAt } : null;
}

/** Test seam. */
export function _resetAaCache(): void {
  cache = null;
  inflight = null;
}

/** Test seam. */
export function _resetCapturedAaEnv(): void {
  capturedKey = null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseRow(item: Record<string, unknown>): AaRow | null {
  const slug = typeof item.slug === 'string' ? item.slug : '';
  const name = typeof item.name === 'string' ? item.name : '';
  if (!slug || !name) return null;
  const evaluations = (item.evaluations ?? {}) as Record<string, unknown>;
  const pricing = (item.pricing ?? {}) as Record<string, unknown>;
  const perf = (item.performance_v3 ?? {}) as Record<string, unknown>;
  return {
    slug,
    name,
    intel: num(evaluations.artificial_analysis_intelligence_index),
    eng: num(evaluations.artificial_analysis_engineering_index),
    priceIn: num(pricing.price_1m_input_tokens),
    priceOut: num(pricing.price_1m_output_tokens),
    tps: num(perf.mean_output_tokens_per_second),
    releaseDate: typeof item.release_date === 'string' ? item.release_date : null,
  };
}

async function pullCatalogue(key: string): Promise<Cache> {
  const rows: AaRow[] = [];
  let tier = 'free';
  let indexVersion = 0;
  for (let page = 1; page <= AA_MAX_PAGES; page++) {
    const url = `${AA_URL}?page=${page}&page_size=${AA_PAGE_SIZE}`;
    let res: Response;
    try {
      res = await aaDeps.fetch(url, {
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(15_000),
      }, 'public-only');
    } catch {
      throw new AaError('aa_unreachable');
    }
    if (res.status === 401) {
      cache = null;
      throw new AaError('aa_unauthorized');
    }
    if (res.status === 403) {
      cache = null;
      throw new AaError('aa_tier');
    }
    if (res.status === 429) {
      throw new AaError('aa_quota', res.headers.get('Retry-After') ?? undefined);
    }
    if (!res.ok) {
      console.warn('[aa] fetch failed: %d', res.status);
      throw new AaError('aa_unreachable');
    }
    let body: Record<string, unknown>;
    try {
      body = await res.json() as Record<string, unknown>;
    } catch {
      throw new AaError('aa_unreachable');
    }
    const bodyTier = typeof body.tier === 'string' && body.tier ? body.tier : res.headers.get('X-AA-Tier');
    if (bodyTier) tier = bodyTier;
    if (typeof body.intelligence_index_version === 'number') indexVersion = body.intelligence_index_version;
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      if (item && typeof item === 'object') {
        const parsed = parseRow(item as Record<string, unknown>);
        if (parsed) rows.push(parsed);
      }
    }
    const pagination = body.pagination as { has_more?: boolean } | undefined;
    if (!pagination?.has_more) break;
  }
  return { rows, tier, indexVersion, fetchedAt: aaDeps.now() };
}

export async function ensureCatalogue(key: string): Promise<{
  rows: AaRow[];
  tier: string;
  fetchedAt: number;
  stale?: true;
}> {
  const now = aaDeps.now();
  if (cache && now - cache.fetchedAt < AA_CACHE_TTL_MS) {
    return { rows: cache.rows, tier: cache.tier, fetchedAt: cache.fetchedAt };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await pullCatalogue(key);
      cache = next;
      return { rows: next.rows, tier: next.tier, fetchedAt: next.fetchedAt };
    } catch (e) {
      if (e instanceof AaError && (e.code === 'aa_quota' || e.code === 'aa_unreachable') && cache) {
        return { rows: cache.rows, tier: cache.tier, fetchedAt: cache.fetchedAt, stale: true };
      }
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function tokens(slug: string): string[] {
  return slug.split('-').filter(Boolean);
}

function sortedKey(slug: string): string {
  return tokens(slug).slice().sort().join('-');
}

function normalizeModel(model: string): string {
  let s = model.toLowerCase();
  for (const p of PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  s = s.replace(/[._/\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s;
}

function skipProfile(profile: AgentProfile): boolean {
  if (profile.agentType === 'grok-bot') return true;
  const m = profile.model.toLowerCase();
  if (SKIP_MODELS.has(m)) return true;
  if (m.startsWith('composer-')) return true;
  return false;
}

function scoreRow(row: AaRow, base: string): number {
  const baseTok = new Set(tokens(base));
  let n = 0;
  for (const t of tokens(row.slug)) if (baseTok.has(t)) n += 3;
  if (row.intel != null) n += 1;
  return n;
}

function rankCandidates(rows: AaRow[], base: string, chosen: AaRow | null): AaRow[] {
  const scored = rows
    .map((r) => ({ r, s: scoreRow(r, base) }))
    .sort((a, b) => b.s - a.s || a.r.slug.localeCompare(b.r.slug));
  const out: AaRow[] = [];
  const seen = new Set<string>();
  const take = (r: AaRow) => {
    if (seen.has(r.slug)) return;
    seen.add(r.slug);
    out.push(r);
  };
  if (chosen) take(chosen);
  for (const r of rows) {
    if (r.slug === base || r.slug.startsWith(`${base}-`)) take(r);
  }
  for (const { r } of scored) {
    if (out.length >= 8) break;
    take(r);
  }
  return out.slice(0, 8);
}

export function matchAaSlug(
  profile: AgentProfile,
  rows: AaRow[],
): { match: AaMatchKind; row: AaRow | null; candidates: AaRow[] } {
  if (skipProfile(profile)) {
    return { match: 'none', row: null, candidates: rankCandidates(rows, normalizeModel(profile.model), null) };
  }
  const norm = normalizeModel(profile.model);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const byAlias = new Map<string, AaRow>();
  for (const r of rows) {
    const k = sortedKey(r.slug);
    if (!byAlias.has(k)) byAlias.set(k, r);
  }

  const exact = bySlug.get(norm);
  if (exact) {
    return { match: 'exact', row: exact, candidates: rankCandidates(rows, norm, exact) };
  }
  const alias = byAlias.get(sortedKey(norm));
  if (alias) {
    return { match: 'alias', row: alias, candidates: rankCandidates(rows, norm, alias) };
  }
  const base = norm.replace(EFFORT_SUFFIX, '');
  if (base !== norm) {
    const baseExact = bySlug.get(base);
    if (baseExact) {
      return { match: 'base', row: baseExact, candidates: rankCandidates(rows, base, baseExact) };
    }
    const baseAlias = byAlias.get(sortedKey(base));
    if (baseAlias) {
      return { match: 'base', row: baseAlias, candidates: rankCandidates(rows, base, baseAlias) };
    }
  }
  return { match: 'none', row: null, candidates: rankCandidates(rows, base !== norm ? base : norm, null) };
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

export function formatTemplateDraft(metrics: AaMetrics): string {
  const parts: string[] = [];
  if (metrics.intel != null) parts.push(`Intel ${fmtNum(Math.round(metrics.intel))}`);
  if (metrics.eng != null) parts.push(`eng ${fmtNum(Math.round(metrics.eng))}`);
  if (metrics.priceIn != null && metrics.priceOut != null) {
    parts.push(`$${fmtNum(metrics.priceIn)}/$${fmtNum(metrics.priceOut)} per Mtok`);
  } else if (metrics.priceIn != null) {
    parts.push(`$${fmtNum(metrics.priceIn)} per Mtok in`);
  } else if (metrics.priceOut != null) {
    parts.push(`$${fmtNum(metrics.priceOut)} per Mtok out`);
  }
  if (metrics.tps != null) parts.push(`${fmtNum(Math.round(metrics.tps))} tok/s`);
  const body = parts.join(' · ');
  return body ? `${body} — <edit: when to use>` : '<edit: when to use>';
}

export function rowMetrics(row: AaRow): AaMetrics {
  return {
    intel: row.intel,
    eng: row.eng,
    priceIn: row.priceIn,
    priceOut: row.priceOut,
    tps: row.tps,
  };
}
