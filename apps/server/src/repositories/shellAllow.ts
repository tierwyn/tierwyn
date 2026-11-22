import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SHELL_FORBIDDEN_ARGV0, SHELL_DENY_ARG_TOKENS, WILDCARD_SUFFIX, REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';

export interface ShellRule { id: string; rule: string[]; }

export function listShellAllow(db: Database, projectId: string): ShellRule[] {
  if (projectId === REMOTE_AGENTS_PROJECT_ID) return [];
  return (db.prepare('SELECT id, rule FROM shell_allow WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as { id: string; rule: string }[])
    .map((r) => ({ id: r.id, rule: JSON.parse(r.rule) as string[] }));
}

export type AddResult = { ok: true; row: ShellRule } | { ok: false; reason: 'invalid' | 'forbidden' };

/** Add a per-project prefix rule. Enforces the no-interpreter invariant:
 *  reject if argv[0] ∈ SHELL_FORBIDDEN_ARGV0 or any token is on the deny-list. */
export function addShellAllow(db: Database, projectId: string, rule: unknown): AddResult {
  if (projectId === REMOTE_AGENTS_PROJECT_ID) {
    return { ok: false, reason: 'forbidden' };
  }
  if (!Array.isArray(rule) || rule.length === 0 || !rule.every((t) => typeof t === 'string' && t.length > 0)) {
    return { ok: false, reason: 'invalid' };
  }
  // Wildcard placement: `*` is legal ONLY as a lone trailing char on the LAST token.
  // Any other `*` (non-last token, mid-token, or multiple) → invalid (fail-closed).
  const lastIdx = rule.length - 1;
  for (let i = 0; i < rule.length; i++) {
    const tok = rule[i] as string;
    if (!tok.includes(WILDCARD_SUFFIX)) continue;
    const legalTrailing = i === lastIdx && tok.endsWith(WILDCARD_SUFFIX) && tok.indexOf(WILDCARD_SUFFIX) === tok.length - 1;
    if (!legalTrailing) return { ok: false, reason: 'invalid' };
  }

  // Forbidden argv0: strip a trailing `*` so ["bash*"] is judged as `bash` and rejected.
  const argv0 = (rule[0] as string).endsWith(WILDCARD_SUFFIX)
    ? (rule[0] as string).slice(0, -1)
    : (rule[0] as string);
  if (
    (SHELL_FORBIDDEN_ARGV0 as readonly string[]).includes(argv0) ||
    rule.some((t) => (SHELL_DENY_ARG_TOKENS as readonly string[]).includes(t as string))
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  const id = randomUUID();
  db.prepare('INSERT INTO shell_allow (id, project_id, rule, created_at) VALUES (?,?,?,?)')
    .run(id, projectId, JSON.stringify(rule), Date.now());
  return { ok: true, row: { id, rule: rule as string[] } };
}

export function removeShellAllow(db: Database, ruleId: string): boolean {
  return db.prepare('DELETE FROM shell_allow WHERE id = ?').run(ruleId).changes > 0;
}
