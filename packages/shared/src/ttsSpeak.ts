/**
 * Shared TTS speak helpers — used by the web client and the server speak-record
 * pipeline so code as-is / summarize-fallback notices stay identical.
 */

/** Friendly language label from a file extension (for code as-is notices). */
const LANG_LABELS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', cs: 'C#',
  swift: 'Swift', kt: 'Kotlin', scala: 'Scala', sh: 'Shell', bash: 'Shell',
  zsh: 'Shell', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  vue: 'Vue', svelte: 'Svelte', r: 'R', lua: 'Lua', dart: 'Dart',
  md: 'Markdown', txt: 'Text', log: 'Log', diff: 'Diff', patch: 'Patch',
};

export function languageLabel(extOrLang: string): string {
  const key = extOrLang.trim().toLowerCase();
  if (!key) return 'Code';
  return LANG_LABELS[key] ?? key.toUpperCase();
}

/** Local short notice for code as-is TTS — never includes source. */
export function codeSpeakNotice(lang: string, lineCount: number): string {
  const label = languageLabel(lang);
  const lines = lineCount === 1 ? '1 line' : `${Math.max(0, lineCount)} lines`;
  return `${label} file, ${lines}`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  // Trailing newline does not add an extra empty line for speech purposes.
  return text.replace(/\n$/, '').split('\n').length;
}
