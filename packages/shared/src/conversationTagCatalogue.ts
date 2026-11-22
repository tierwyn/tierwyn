/**
 * Jev auto-tag catalogue — the tags Jev may apply, each with a hint that
 * becomes the "true" criterion of its question.
 *
 * Built-ins live in code (disable-able, never deletable). Customs live in the
 * `conversation_tag_catalogue` settings row and are capped. Tag text goes
 * through normaliseTags so the tag rules have a single source of truth.
 */
import { MAX_TAGS, normaliseTags } from './conversationTags.js';

export interface CatalogueTag { tag: string; hint: string }
export interface TagCatalogueSettings { custom: CatalogueTag[]; disabledBuiltins: string[] }

export const TAG_CATALOGUE_DEFAULTS: TagCatalogueSettings = { custom: [], disabledBuiltins: [] };

export const MAX_CUSTOM_CATALOGUE_TAGS = 16;
export const MAX_TAG_HINT_LENGTH = 120;

export const BUILTIN_TAG_CATALOGUE = [
  { tag: 'bug', hint: 'Diagnosing or fixing broken behaviour, errors, crashes or regressions.' },
  { tag: 'feature', hint: 'Building new user-facing functionality or capabilities.' },
  { tag: 'refactor', hint: 'Restructuring existing code without changing its behaviour.' },
  { tag: 'research', hint: 'Investigating options, reading sources or comparing approaches before deciding.' },
  { tag: 'planning', hint: 'Writing a plan, spec, design or roadmap before implementation.' },
  { tag: 'review', hint: "Reviewing code, a pull request or someone else's work for problems." },
  { tag: 'testing', hint: 'Writing, fixing or running automated tests.' },
  { tag: 'docs', hint: 'Writing or editing documentation, READMEs or guides.' },
  { tag: 'deploy', hint: 'Releasing, deploying, restarting services or production rollout.' },
  { tag: 'config', hint: 'Editing configuration files, settings, environment variables or tooling setup.' },
  { tag: 'infra', hint: 'Servers, containers, networking, systemd, CI pipelines or hosting.' },
  { tag: 'database', hint: 'Schema, migrations, queries or data stored in a database.' },
  { tag: 'performance', hint: 'Speed, latency, memory or resource usage improvements.' },
  { tag: 'security', hint: 'Authentication, secrets, permissions, vulnerabilities or hardening.' },
  { tag: 'ui', hint: 'Visual layout, styling, components or front-end user experience.' },
  { tag: 'api', hint: 'HTTP endpoints, protocols or integration contracts between systems.' },
  { tag: 'dependencies', hint: 'Upgrading, adding or removing packages and libraries.' },
  { tag: 'git', hint: 'Branches, commits, merges, rebases or repository history.' },
  { tag: 'data', hint: 'Processing, cleaning, analysing or transforming datasets or files.' },
  { tag: 'automation', hint: 'Scheduled jobs, scripts or workflows that run without a human.' },
  { tag: 'ai-agents', hint: 'Configuring, prompting or orchestrating AI models and agents.' },
  { tag: 'writing', hint: 'Drafting prose such as emails, posts or articles that are not documentation.' },
  { tag: 'learning', hint: 'Explaining a concept or answering a how-does-this-work question.' },
  { tag: 'personal', hint: 'Non-work, everyday or household topics.' },
] as const satisfies readonly CatalogueTag[];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type TagCatalogueParseResult =
  | { ok: true; catalogue: TagCatalogueSettings }
  | { ok: false; error: string };

/**
 * Whole-document validator for the tag-catalogue settings row and route body.
 * Strict by default (POST). `lenient` is for READing a stored row after the built-in list
 * has evolved: stale `disabledBuiltins` entries and customs that now collide with a built-in are dropped, not fatal.
 */
export function parseTagCatalogue(raw: unknown, opts: { lenient?: boolean } = {}): TagCatalogueParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'catalogue must be an object' };
  }
  const { custom: rawCustom, disabledBuiltins: rawDisabled } = raw as Record<string, unknown>;
  if (!Array.isArray(rawCustom)) return { ok: false, error: 'custom must be an array' };
  if (!Array.isArray(rawDisabled)) return { ok: false, error: 'disabledBuiltins must be an array' };
  if (rawCustom.length > MAX_CUSTOM_CATALOGUE_TAGS) {
    return { ok: false, error: `at most ${MAX_CUSTOM_CATALOGUE_TAGS} custom tags` };
  }

  const builtinTags = new Set<string>(BUILTIN_TAG_CATALOGUE.map((b) => b.tag));
  const seen = new Set<string>();
  const custom: CatalogueTag[] = [];
  for (const entry of rawCustom) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'each custom tag must be an object with tag and hint' };
    }
    const { tag: rawTag, hint: rawHint } = entry as Record<string, unknown>;
    if (typeof rawTag !== 'string') return { ok: false, error: 'tag must be a string' };
    const normalised = normaliseTags([rawTag]);
    if (!normalised.ok) return normalised;
    const tag = normalised.tags[0];
    if (!tag) return { ok: false, error: 'tag must not be empty' };
    if (typeof rawHint !== 'string') return { ok: false, error: 'hint must be a string' };
    const hint = rawHint.trim();
    if (!hint) return { ok: false, error: 'hint must not be empty' };
    if (hint.length > MAX_TAG_HINT_LENGTH) {
      return { ok: false, error: `hint must be at most ${MAX_TAG_HINT_LENGTH} characters` };
    }
    if (CONTROL_CHARS.test(hint)) return { ok: false, error: 'hint must not contain control characters' };
    const key = tag.toLowerCase();
    if (builtinTags.has(key)) {
      if (opts.lenient) continue;
      return { ok: false, error: `"${tag}" is a built-in tag` };
    }
    if (seen.has(key)) return { ok: false, error: `"${tag}" is already in the catalogue` };
    seen.add(key);
    custom.push({ tag, hint });
  }

  const disabledBuiltins: string[] = [];
  for (const d of rawDisabled) {
    if (typeof d !== 'string' || !builtinTags.has(d)) {
      if (opts.lenient) continue;
      return { ok: false, error: 'disabledBuiltins must list built-in tags only' };
    }
    if (!disabledBuiltins.includes(d)) disabledBuiltins.push(d);
  }
  return { ok: true, catalogue: { custom, disabledBuiltins } };
}

/** Built-ins minus the disabled ones, then the customs. Order fixes the `t<i>` question keys. */
export function enabledTagCatalogue(s: TagCatalogueSettings): CatalogueTag[] {
  const off = new Set(s.disabledBuiltins);
  return [...BUILTIN_TAG_CATALOGUE.filter((b) => !off.has(b.tag)), ...s.custom];
}

/** Additive merge: the operator's tags first, then new picks (case-insensitive dedupe), capped at MAX_TAGS. */
export function mergeAutoTags(existing: string[], picked: string[]): string[] {
  const out = [...existing];
  const have = new Set(out.map((t) => t.toLowerCase()));
  for (const t of picked) {
    if (have.has(t.toLowerCase())) continue;
    have.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

/**
 * Keep `t<i>` noul answers at or above `threshold`, highest probability first
 * (ties by catalogue order), at most `max`. Unknown or out-of-range keys are ignored.
 */
export function pickAutoTags(
  catalogue: readonly CatalogueTag[],
  answers: Record<string, { type: string; noul?: number }>,
  threshold: number,
  max: number,
): string[] {
  const hits: Array<{ i: number; p: number }> = [];
  // Iterate catalogue positions so only the exact canonical key `t<i>` is ever read (no t01 aliases).
  catalogue.forEach((_, i) => {
    const a = answers[`t${i}`];
    if (a?.type === 'noul' && typeof a.noul === 'number' && a.noul >= threshold) hits.push({ i, p: a.noul });
  });
  hits.sort((x, y) => y.p - x.p || x.i - y.i);
  return hits.slice(0, max).map((h) => catalogue[h.i].tag);
}
