import type { Database } from 'better-sqlite3';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';

/**
 * Host auto-discovery for agents (Phase 5, FR-3): report which agent binaries are
 * actually installed on this machine so the catalogue can show "installed vs missing"
 * with an install hint. The probe is NON-spawning — it only checks for the binary's
 * presence on PATH (or at an explicit `executable_path` from the agents table) — so it
 * is cheap and side-effect free.
 */

export interface AgentInstallInfo {
  agentType: string;
  installed: boolean;
  /** Present only when not installed — how the operator can install it. */
  installHint?: string;
  bin?: string;
}

/** `install`: exact shell command the installer (scripts/install.sh) may run on the operator's
 *  request — an `npm i -g <pkg>` or the vendor's own `curl -fsSL https://… | bash`. Omitted when
 *  the agent has no scriptable install (desktop app / website download).
 *  `prereqs`: system binaries required by the vendor installer on Linux (e.g. `['unzip']` for kiro). */
export interface KnownAgent {
  bin: string;
  hint: string;
  install?: string;
  prereqs?: string[];
  pkg?: string;
  releasesRepo?: string;
  /** Direct HTTP latest-version feed for agents with no npm/GitHub source.
   *  `json` → body's `version` field, `text` → bare version string,
   *  `script` → vendor install script embedding the release in a download URL. */
  latestFeed?: { url: string; kind: 'json' | 'text' | 'script' };
  noVersion?: true;
}

/** Default binary + install hint per known agent type. Keep aligned with the
 *  adapters registered in index.ts. */
export const AGENT_BINARIES: Record<string, KnownAgent> = {
  'claude-code': { bin: 'claude',     hint: 'Install Claude Code — https://claude.com/claude-code',
                 install: 'curl -fsSL https://claude.ai/install.sh | bash',
                 pkg: '@anthropic-ai/claude-code' },
  pi:            { bin: 'pi',         hint: 'Install Pi — npm i -g @earendil-works/pi-coding-agent',
                 install: 'npm i -g @earendil-works/pi-coding-agent',
                 pkg: '@earendil-works/pi-coding-agent' },
  antigravity:   { bin: 'agy',        hint: 'Install Antigravity CLI — curl -fsSL https://antigravity.google/cli/install.sh | bash',
                 install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
                 releasesRepo: 'google-antigravity/antigravity-cli' },
  opencode:      { bin: 'opencode',   hint: 'Install OpenCode — curl -fsSL https://opencode.ai/install | bash',
                 install: 'curl -fsSL https://opencode.ai/install | bash',
                 releasesRepo: 'sst/opencode' },
  kilocode:      { bin: 'kilo',       hint: 'Install KiloCode CLI — npm i -g @kilocode/cli',
                 install: 'npm i -g @kilocode/cli',
                 pkg: '@kilocode/cli' },
  cursor:        { bin: 'cursor-agent', hint: 'Install Cursor CLI — https://cursor.com/cli',
                 install: 'curl -fsSL https://cursor.com/install | bash',
                 latestFeed: { url: 'https://cursor.com/install', kind: 'script' } },
  hermes:        { bin: 'hermes',       hint: 'Install Hermes Agent — https://hermes-agent.nousresearch.com',
                 install: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
                 releasesRepo: 'NousResearch/hermes-agent' },
  codex:         { bin: 'codex',        hint: 'Install Codex CLI — npm i -g @openai/codex',
                 install: 'npm i -g @openai/codex',
                 pkg: '@openai/codex' },
  'grok-build':  { bin: 'grok',         hint: 'Install Grok CLI — curl -fsSL https://x.ai/cli/install.sh | bash (needs SuperGrok/X Premium Plus)',
                 install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
                 latestFeed: { url: 'https://x.ai/cli/stable', kind: 'text' } },
  openclaw:      { bin: 'openclaw',     hint: 'Install OpenClaw — npm i -g openclaw@latest',
                 install: 'npm i -g openclaw@latest',
                 pkg: 'openclaw' },
  kiro:          { bin: 'kiro-cli',     hint: 'Install Kiro CLI — https://kiro.dev/docs/cli (then `kiro-cli login`)',
                 install: 'rm -f "$HOME/.local/bin/kiro-cli" "$HOME/.local/bin/kiro-cli-chat"; curl -fsSL https://cli.kiro.dev/install | bash -s -- --force',
                 latestFeed: { url: 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json', kind: 'json' },
                 prereqs: ['unzip'] },
  qwen:          { bin: 'qwen',         hint: 'Install Qwen Code — https://qwenlm.github.io/qwen-code-docs/',
                 install: 'npm i -g @qwen-code/qwen-code',
                 pkg: '@qwen-code/qwen-code' },
  kimi:          { bin: 'kimi',         hint: 'Install Kimi Code — npm i -g @moonshot-ai/kimi-code',
                 install: 'npm i -g @moonshot-ai/kimi-code',
                 pkg: '@moonshot-ai/kimi-code' },
  copilot:       { bin: 'copilot',      hint: 'Install GitHub Copilot CLI — npm i -g @github/copilot (then `copilot login`)',
                 install: 'npm i -g @github/copilot',
                 pkg: '@github/copilot' },
  'grok-bot':    { bin: '/opt/Grok Bot/grok-bot',
                   hint: 'Install Grok Bot desktop (x.ai/bot → Download for Linux) and enable the Grok Bot sidecar',
                   noVersion: true },
  deepseek:      { bin: 'dsh',          hint: 'Install DeepSeek Harness — npm i -g @deepseek-ai/dsh',
                 install: 'npm i -g @deepseek-ai/dsh',
                 pkg: '@deepseek-ai/dsh' },
};

/** Static install-hint map (FR-3), derived from AGENT_BINARIES. */
export const INSTALL_HINTS: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_BINARIES).map(([type, a]) => [type, a.hint]),
);

/** Static map: true when the adapter's listModels() returns real data from the
 *  CLI/API; false when it returns [] and the operator must add models manually.
 *  Unknown/custom agent types not listed here default to true at the call site. */
export const DYNAMIC_MODEL_DISCOVERY: Record<string, boolean> = {
  'claude-code': true,  // ~/.claude/cache/model-catalog/*-cc.json (no spawn); [] when absent → seed only
  'pi':          true,
  'antigravity': true,
  'opencode':    true,
  'kilocode':    true,
  'cursor':      true,   // cursor-agent models
  'hermes':      true,   // ~/.hermes/models.json (fallback to seeded profiles)
  'codex':       true,   // ~/.codex/models_cache.json (fallback to seeded profiles)
  'grok-build':  true,   // ~/.grok/models_cache.json (no spawn); seed is the cold-start fallback
  'openclaw':    true,   // openclaw models list --json works
  'kiro':        true,   // kiro-cli chat --list-models --format json; cached at data/kiro-models.json
  'qwen':        true,   // ACP session/new → models.availableModels
  'kimi':        true,   // ACP session/new → configOptions[id=model].options
  'copilot':     false,  // no CLI model-list command; models come from agent-profiles.json seed
  'grok-bot':    true,   // readRoster over CDP; seed is grok-bot:default
  'deepseek':    false,  // no CLI model-list command; models come from agent-profiles.json seed
};

/** First PATH hit for `bin`, or the explicit path when `bin` contains `/`. */
export function resolveOnPath(bin: string, exists: (p: string) => boolean = existsSync): string | undefined {
  if (!bin) return undefined;
  if (bin.includes('/')) return exists(bin) ? bin : undefined;
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin);
    if (exists(p)) return p;
  }
  return undefined;
}

/** Non-spawning PATH lookup: true when a file named `bin` exists in a PATH dir,
 *  or when `bin` is an explicit path that exists. */
export function binaryOnPath(bin: string, exists: (p: string) => boolean = existsSync): boolean {
  return resolveOnPath(bin, exists) !== undefined;
}

interface AgentRow { id: string; type: string; executable_path: string | null; }

/**
 * Probe every known agent type plus any agent stored in the DB. An explicit
 * `executable_path` (set via the catalogue UI) overrides the default binary name.
 * `exists` is injectable for tests.
 */
export function discoverInstalledAgents(
  db: Database,
  exists: (p: string) => boolean = existsSync,
): AgentInstallInfo[] {
  const rows = db.prepare('SELECT id, type, executable_path FROM agents').all() as AgentRow[];
  const byType = new Map<string, AgentRow>();
  for (const r of rows) byType.set(r.type, r);

  const types = new Set<string>([...Object.keys(AGENT_BINARIES), ...byType.keys()]);
  const out: AgentInstallInfo[] = [];
  for (const type of [...types].sort()) {
    const known = AGENT_BINARIES[type];
    const row = byType.get(type);
    const bin = (row?.executable_path && row.executable_path.trim()) || known?.bin || type;
    const installed = binaryOnPath(bin, exists);
    out.push({
      agentType: type,
      installed,
      installHint: installed ? undefined : (known?.hint ?? `Install "${type}" — binary "${bin}" not found on PATH`),
      bin,
    });
  }
  return out;
}
