import type { PromptCollectionEntry } from '@tierwyn/shared';

function varText(e: PromptCollectionEntry): string {
  return (e.variables ?? []).map((v) => `${v.name} ${v.label ?? ''}`).join(' ');
}

export type SearchMode = 'words' | 'regex';
export type OriginFilter = 'all' | 'preset' | 'custom';

export interface RegexBuildResult {
  re: RegExp | null;
  invalid: boolean;
}

export function buildSearchRegex(query: string): RegexBuildResult {
  if (!query) return { re: null, invalid: false };
  try {
    return { re: new RegExp(query, 'i'), invalid: false };
  } catch {
    return { re: null, invalid: true };
  }
}

export function matchesWords(entry: PromptCollectionEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const target = `${entry.name} ${entry.description} ${entry.body} ${varText(entry)}`.toLowerCase();
  return terms.every((term) => target.includes(term));
}

export function matchesRegex(entry: PromptCollectionEntry, re: RegExp | null): boolean {
  if (!re) return true;
  return re.test(entry.name) || re.test(entry.description) || re.test(entry.body) || re.test(varText(entry));
}

export function filterPrompts(
  entries: PromptCollectionEntry[],
  query: string,
  mode: SearchMode,
  origin: OriginFilter = 'all',
): { visible: PromptCollectionEntry[]; regexInvalid: boolean } {
  let filtered = entries;
  if (origin !== 'all') {
    filtered = filtered.filter((e) => e.origin === origin);
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return { visible: [...filtered], regexInvalid: false };
  }

  if (mode === 'words') {
    const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    return {
      visible: filtered.filter((e) => matchesWords(e, terms)),
      regexInvalid: false,
    };
  }

  const { re, invalid } = buildSearchRegex(trimmed);
  if (invalid) {
    // On invalid regex, return all matching the origin filter with flag
    return { visible: [...filtered], regexInvalid: true };
  }

  return {
    visible: filtered.filter((e) => matchesRegex(e, re)),
    regexInvalid: false,
  };
}
