/** Agent home bind profiles. */

export interface SandboxProfile {
  rw: string[];
  ro?: string[];
}

export const SANDBOX_PROFILES: Record<string, SandboxProfile> = {
  'claude-code': { rw: ['.claude', '.claude.json'] },
  codex: { rw: ['.codex'] },
  opencode: {
    rw: ['.config/opencode', '.local/share/opencode', '.local/state/opencode'],
    ro: ['.opencode/bin'],
  },
  kilocode: {
    rw: ['.config/kilo', '.local/share/kilo', '.local/state/kilo', '.kilo'],
    ro: ['.agents/skills'],
  },
  cursor: { rw: ['.cursor', '.config/cursor'] },
  qwen: { rw: ['.qwen'] },
  kimi: { rw: ['.kimi-code'] },
  kiro: { rw: ['.kiro', '.local/share/kiro-cli'] },
  hermes: { rw: ['.hermes'] },
  pi: { rw: ['.pi'] },
  deepseek: { rw: ['.dsh'] },
  'grok-build': { rw: ['.grok'] },
  antigravity: { rw: ['.gemini'] },
  openclaw: { rw: ['.openclaw'] },
  copilot: { rw: ['.copilot'], ro: ['.agents/skills'] },
};

export function hasSandboxProfile(agent: string): boolean {
  return Object.hasOwn(SANDBOX_PROFILES, agent);
}
