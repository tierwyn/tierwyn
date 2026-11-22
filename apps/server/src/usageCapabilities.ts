/** Per-agent usage telemetry capabilities, used by the /usage route to tell the
 *  UI which panel sections are meaningful for the active agent. Updated as each
 *  adapter gains support (see the phased plan). `supportsRateLimits` is true
 *  for agents whose account-level allowance we can probe (Claude ~/.claude,
 *  Grok `_x.ai/billing`, Codex `account/rateLimits/read`,
 *  Antigravity `agy --print /usage`, Kiro `kiro-cli chat --no-interactive /usage`). */
export interface UsageCapabilities {
  supportsContextWindow: boolean;
  supportsRateLimits: boolean;
}

const CAPABILITIES: Record<string, UsageCapabilities> = {
  'claude-code': { supportsContextWindow: true, supportsRateLimits: true },
  pi: { supportsContextWindow: true, supportsRateLimits: false },
  // cursor / opencode flip to true in their respective phases.
  // grok-build: ACP occupancy % plus account weekly credits via `_x.ai/billing`.
  'grok-build': { supportsContextWindow: true, supportsRateLimits: true },
  cursor: { supportsContextWindow: false, supportsRateLimits: false },
  opencode: { supportsContextWindow: false, supportsRateLimits: false },
  hermes: { supportsContextWindow: false, supportsRateLimits: false },
  // antigravity: rate limits via `agy --print /usage` quota groups; context
  // window % from the last `agent_response` step's `input + cache_read` snapshot.
  antigravity: { supportsContextWindow: true, supportsRateLimits: true },
  // codex: context window via tokenUsage mapping; rate limits via a throwaway
  // `codex app-server` account/rateLimits/read probe.
  codex: { supportsContextWindow: true, supportsRateLimits: true },
  // kiro: ACP contextUsagePercentage plus account monthly credits via
  // `kiro-cli chat --no-interactive /usage` (stderr on older CLIs, stdout on newer).
  kiro: { supportsContextWindow: true, supportsRateLimits: true },
  // qwen: context % from ACP usage_update; no account quota endpoint.
  qwen: { supportsContextWindow: true, supportsRateLimits: false },
  // kimi: context % from ACP usage_update {used,size}; no account quota endpoint.
  kimi: { supportsContextWindow: true, supportsRateLimits: false },
  // copilot: context % from model.model_call_success (responseUsage / maxPromptTokens);
  // monthly premium requests via api.github.com/copilot_internal/user (gh token).
  copilot: { supportsContextWindow: true, supportsRateLimits: true },
  // deepseek: dsh reports token counts per turn. Context % computed from
  // turn occupancy vs model context window.
  deepseek: { supportsContextWindow: true, supportsRateLimits: false },
};

export function usageCapabilitiesFor(agentType: string | undefined): UsageCapabilities {
  if (agentType && CAPABILITIES[agentType]) return CAPABILITIES[agentType];
  return { supportsContextWindow: false, supportsRateLimits: false };
}
