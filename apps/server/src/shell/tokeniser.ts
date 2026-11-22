export type TokeniseResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: 'empty' | 'shell_metachar' };

// Shell control metachars. NOTE: glob chars (* ? [ ]) and ~ are NOT here — with
// shell:false they never expand; they pass literally as argv tokens. Backslash IS
// rejected (escape ambiguity). Newlines/CR rejected. Null byte rejected (would
// otherwise throw synchronously out of spawn() with no audit card persisted).
const METACHAR = /[|&;<>$`\\(){}\n\r\0]/;

/** Shell-free argv parser. Honours quotes only for grouping args-with-spaces;
 *  rejects shell metacharacters anywhere in the input (including inside quotes). */
export function tokenise(input: string): TokeniseResult {
  const s = input.trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (METACHAR.test(s)) return { ok: false, reason: 'shell_metachar' };
  // Unbalanced quotes → malformed → treat as metachar refusal (fail closed).
  const dq = (s.match(/"/g) ?? []).length;
  const sq = (s.match(/'/g) ?? []).length;
  if (dq % 2 !== 0 || sq % 2 !== 0) return { ok: false, reason: 'shell_metachar' };
  const argv: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const tok = m[1] ?? m[2] ?? m[3];
    // Skip empty captures produced by `""` / `''` — they're not real tokens,
    // and an empty-string argv[0] would throw synchronously out of spawn()
    // with no audit card persisted.
    if (tok !== '') argv.push(tok);
  }
  if (argv.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, argv };
}
