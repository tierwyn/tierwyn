import { SHELL_BASE_ALLOW, SHELL_DENY_ARG_TOKENS, matchesRuleToken } from '@tierwyn/shared';

export type GateResult = { ok: true } | { ok: false; reason: 'not_allowlisted' | 'denied' };

/** argv matches rule R iff argv starts with (deep-equals prefix) R.
 *  Last rule token may end with `*` for prefix match (see matchesRuleToken). */
function matchesRule(argv: string[], rule: readonly string[]): boolean {
  if (argv.length < rule.length) return false;
  for (let i = 0; i < rule.length; i++) {
    if (!matchesRuleToken(rule[i]!, argv[i]!, i === rule.length - 1)) return false;
  }
  return true;
}

/** Allow-first (fail-closed not_allowlisted), then deny-list seatbelt (denied).
 *  The deny-list is NOT the gate — the allow-list is. Deny only catches a
 *  destructive flag on an otherwise-allowed prefix. */
export function gate(argv: string[], projectRules: readonly (readonly string[])[]): GateResult {
  const allowed =
    SHELL_BASE_ALLOW.some((r) => matchesRule(argv, r)) ||
    projectRules.some((r) => matchesRule(argv, r));
  if (!allowed) return { ok: false, reason: 'not_allowlisted' };
  // ponytail: seatbelt, NOT the gate — the allow-list above is. This only catches a
  // destructive flag on an otherwise-allowed prefix (e.g. a per-project ["git"] rule).
  if (argv.some((t) => (SHELL_DENY_ARG_TOKENS as readonly string[]).includes(t))) {
    return { ok: false, reason: 'denied' };
  }
  return { ok: true };
}
