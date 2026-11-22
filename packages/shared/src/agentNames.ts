/**
 * Canonical display names for agent types.
 *
 * Single source of truth for turning a lowercase agentType slug
 * (e.g. 'grok-build') into the human-facing label (e.g. 'Grok Build').
 * Lives in shared because the DB seed (apps/server/src/db/seed.ts) runs
 * BEFORE the adapter registry is populated at boot, so it cannot read
 * labels from the registry. Keep this in sync with the `label` passed to
 * registry.register() in apps/server/src/index.ts.
 */
export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'pi': 'Pi',
  'antigravity': 'Antigravity',
  'opencode': 'OpenCode',
  'kilocode': 'KiloCode',
  'cursor': 'Cursor',
  'hermes': 'Hermes',
  'codex': 'Codex',
  'grok-build': 'Grok Build',
  'kiro': 'Kiro',
  'qwen': 'Qwen Code',
  'openclaw': 'OpenClaw',
  'copilot': 'GitHub Copilot',
  'grok-bot': 'Grok Bot',
  'kimi': 'Kimi Code',
  'deepseek': 'DeepSeek Harness',
};

/**
 * Display name for an agent type: canonical map first, then a fallback
 * that title-cases each word of the slug ('my-agent' → 'My Agent').
 */
export function agentDisplayName(agentType: string): string {
  const known = AGENT_DISPLAY_NAMES[agentType];
  if (known) return known;
  return agentType
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Types the hub can still drive. Stale node hellos may list retired names (e.g. openclaude). */
export function isRemoteCapableAgentType(agentType: string): boolean {
  return agentType !== 'grok-bot' && Object.prototype.hasOwnProperty.call(AGENT_DISPLAY_NAMES, agentType);
}
