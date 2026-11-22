/**
 * FW-15 — conversation tags. The single source of truth for tag validation.
 *
 * Both the server PATCH route (authoritative) and the web Edit modal
 * (pre-flight UX) call normaliseTags. Keeping one implementation here is the
 * only way the two stay honest about the same caps.
 *
 * Storage is a JSON array in conversations.tags (TEXT NOT NULL DEFAULT '[]');
 * there is deliberately no SQL CHECK constraint — SQLite json checks are
 * fussy and this function is the guard.
 */

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 32;

export type TagNormaliseResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: string };

// ponytail: control chars only. Tags are free text for one operator — a
// charset allowlist would reject "café" and "needs review" for no benefit.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate + normalise an untrusted `tags` value.
 *
 * Accepts: an array of strings. Each is trimmed; entries that are empty after
 * trimming are dropped (not an error — an empty chip input is a no-op, not a
 * mistake). Duplicates are dropped case-sensitively, first occurrence wins.
 *
 * Rejects (ok:false): non-array input, a non-string element, an element with a
 * control character, an element longer than MAX_TAG_LENGTH after trim, or more
 * than MAX_TAGS tags once normalised.
 */
export function normaliseTags(input: unknown): TagNormaliseResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'tags must be an array of strings' };
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'tags must be an array of strings' };
    }
    if (CONTROL_CHARS.test(raw)) {
      return { ok: false, error: 'tag must not contain control characters' };
    }
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      return { ok: false, error: `tag must be at most ${MAX_TAG_LENGTH} characters` };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) {
    return { ok: false, error: `at most ${MAX_TAGS} tags` };
  }
  return { ok: true, tags: out };
}

/**
 * Sidebar filter predicate. `tag === null` means "no filter active" and
 * matches everything, so callers can drop it straight into a .filter() chain
 * without branching.
 */
export function hasTag(conv: { tags?: string[] }, tag: string | null): boolean {
  if (!tag) return true;
  return (conv.tags ?? []).includes(tag);
}

/** Unique tags across a list, first-seen order then locale-sorted for menus. */
export function collectKnownTags(items: Array<{ tags?: string[] }>): string[] {
  const out: string[] = [];
  for (const item of items) {
    for (const t of item.tags ?? []) {
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Autocomplete: known tags matching `draft` (case-insensitive substring),
 * excluding tags already applied. Empty draft lists unused known tags.
 */
export function suggestTags(
  known: string[],
  draft: string,
  exclude: string[] = [],
  limit = 8,
): string[] {
  const q = draft.trim().toLowerCase();
  const skip = new Set(exclude);
  const matches = known.filter((t) => !skip.has(t) && (!q || t.toLowerCase().includes(q)));
  return matches.slice(0, limit);
}

/**
 * Sidebar tag-search predicate. Empty/null query matches everything.
 * Otherwise a conversation matches when any of its tags contains the query
 * (case-insensitive), so typing "re" hits "research" and a chip click on
 * "research" still matches.
 */
export function matchesTagQuery(conv: { tags?: string[] }, query: string | null): boolean {
  const q = query?.trim() ?? '';
  if (!q) return true;
  const needle = q.toLowerCase();
  return (conv.tags ?? []).some((t) => t.toLowerCase().includes(needle));
}
