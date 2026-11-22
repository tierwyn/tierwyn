/** Mirrors MAX_KEYS in plugins/openrouter-usage/index.js. */
export const KEY_LIST_MAX = 12;

export interface KeyRow { name: string; key: string }

// ponytail: hardcoded pairs instead of a manifest `listGrammar` flag — openrouter-usage
// and kilo-usage share this grammar. Next plugin wanting it: add the flag to
// PluginCredentialDecl and switch this predicate to read it.
export function usesKeyListEditor(pluginId: string, credKey: string): boolean {
  return (pluginId === 'openrouter-usage' && credKey === 'OPENROUTER_API_KEY')
    || (pluginId === 'kilo-usage' && credKey === 'KILO_API_KEY');
}

/** First problem with the composed rows, or null. Never echoes key material. */
export function validateKeyRows(rows: KeyRow[]): string | null {
  if (rows.length > KEY_LIST_MAX) return 'Maximum 12 keys';
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const key = row.key.trim();
    if (/[,=]/.test(name)) return 'Key name must not contain , or =';
    if (/[,=]/.test(key)) return 'API key must not contain , or =';
    if (name && !key) return 'Named row is missing an API key';
    if (!key) continue;
    if (seen.has(key)) return 'Duplicate API key';
    seen.add(key);
  }
  return null;
}

/** Serialise to the parseKeyList grammar. Assumes validateKeyRows returned null. */
export function serialiseKeyList(rows: KeyRow[]): string {
  return rows
    .map((r) => ({ name: r.name.trim(), key: r.key.trim() }))
    .filter((r) => r.key)
    .map((r) => (r.name ? `${r.name}=${r.key}` : r.key))
    .join(',');
}

/** Non-secret summary, e.g. "3 keys (2 named)". */
export function keyListSummary(rows: KeyRow[]): string {
  const filled = rows.filter((r) => r.key.trim());
  const named = filled.filter((r) => r.name.trim());
  return `${filled.length} key${filled.length === 1 ? '' : 's'} (${named.length} named)`;
}
