/** Fixed-base allow-list. A rule is a token array; an argv is permitted iff it
 *  starts with (deep-equals prefix) some rule. Single token = trust the whole
 *  read-only binary; multi-token = restrict a multi-tool to a read subcommand.
 *  INVARIANT (enforced in server gate + per-project add): never a shell/interpreter. */
export const SHELL_BASE_ALLOW: readonly (readonly string[])[] = [
  ['ls'], ['pwd'], ['cat'], ['head'], ['tail'], ['wc'], ['grep'], ['rg'], ['echo'],
  ['df'], ['du'], ['uptime'], ['whoami'], ['date'],
  ['git', 'status'], ['git', 'log'], ['git', 'diff'], ['git', 'branch'], ['git', 'show'],
];

/** Binaries that must NEVER be allow-listed (base OR per-project). Any of these
 *  as argv[0] re-introduces arbitrary execution and defeats the whole model.
 *  Enforced server-side when adding a per-project rule (fail 400). None are in
 *  SHELL_BASE_ALLOW, so gate() already fail-closes them — this list is the
 *  guardrail against an operator *adding* one per-project.
 *
 *  Includes process-wrapper binaries (timeout/nice/nohup/setsid/etc.) because
 *  argv[1] after them is the real command: ["busybox"] → `!busybox sh`;
 *  ["timeout"] → `!timeout 10 rm file`. */
export const SHELL_FORBIDDEN_ARGV0: readonly string[] = [
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'env',
  'python', 'python2', 'python3', 'node', 'nodejs', 'ruby', 'perl',
  'awk', 'gawk', 'xargs', 'eval', 'exec', 'source', 'nc', 'ncat', 'socat', 'ssh',
  // process-wrapper / multi-tool binaries — argv[1] is the real command
  'busybox', 'timeout', 'nohup', 'nice', 'ionice',
  'time', 'stdbuf', 'setsid', 'chroot', 'chvt',
  'coproc', 'command', 'builtin',
];

/** Secondary seatbelt: reject argv containing any of these exact tokens.
 *  NOT the gate (the allow-list is). Catches a destructive flag on an allowed prefix. */
export const SHELL_DENY_ARG_TOKENS: readonly string[] = [
  '-rf', '-fr', '--force', '--hard', '--delete', '-delete', '-D',
  '--no-preserve-root', '-exec', '-execdir',
];

export const SHELL_TIMEOUT_MS = 60_000;
export const SHELL_OUTPUT_CAP_BYTES = 1_048_576; // 1 MiB total (stdout+stderr)

/** Trailing-`*` wildcard marker for per-project allow rules. Only ever a SUFFIX
 *  on the LAST token of a rule (validated at add time in shellAllow.ts). Not a
 *  glob: no `?`, no char classes, no `**`, no infix `*`. */
export const WILDCARD_SUFFIX = '*';

/** Match one rule token against one argv token at the same position.
 *  `isLast` = this is the final token of the rule. A trailing `*` on the last
 *  token means prefix-match (strip the `*`, argvTok.startsWith(prefix)).
 *  Everywhere else: strict equality — unchanged legacy behaviour. */
export function matchesRuleToken(ruleTok: string, argvTok: string, isLast: boolean): boolean {
  if (isLast && ruleTok.endsWith(WILDCARD_SUFFIX)) {
    return argvTok.startsWith(ruleTok.slice(0, -1)); // '' prefix ⇒ any single token (bare `*`)
  }
  return ruleTok === argvTok;
}
