import type { Workdir } from './domain.js';

export interface AgentProfile {
  id: string;           // stable slug, e.g. "claude-code:opus-4.8"
  agentType: string;    // e.g. "claude-code"
  model: string;        // e.g. "claude-opus-4-8"
  provider?: string;    // for multi-provider agents (Pi)
  label: string;        // UI display, e.g. "Claude Code · Opus 4.8"
  description: string;  // routing hint + tooltip text
  vision: boolean;
  steer: boolean;
  enabled: boolean;
  contextWindow?: number; // optional context window in tokens (e.g. GLM-5.2 = 1_000_000)
  /** When this profile is the SPAWNER, max children it may run at once.
   *  undefined/0 = spawning disabled (fail closed). */
  maxConcurrentSpawns?: number;
  /** When this profile is the SPAWNER, max grandchildren a single child may
   *  spawn (depth-2 descendants from this profile's root turn). undefined/0 =
   *  grandchild spawning disabled (fail closed). */
  maxGrandchildSpawns?: number;
  /** Derived field (not stored in DB): true when this agent's adapter implements
   *  the permission round-trip and will honour `interactionMode !== 'bypass'`.
   *  Stamped by the server on the /profiles response. */
  permissionCapable?: boolean;
}

/** Adapters whose CLI/SDK can actually receive an image attachment.
 *  - claude-code: SDK / stream-json image content blocks
 *  - pi: base64 image blocks via RPC
 *  - opencode/kilocode: --file flag
 *  - antigravity, grok-build, cursor, hermes, openclaw, kimi, kiro, qwen: no native image
 *    input flag, but the model can resolve `@<path>` references against
 *    the local fs, so we pass tempPaths as text mentions instead of base64.
 *  - copilot: --attachment flag; grok-bot: CDP file input
 *  - deepseek: SDK `image` content blocks (base64 + mimeType). */
export const IMAGE_CAPABLE_ADAPTERS = new Set([
  'claude-code',
  'pi',
  'opencode',
  'kilocode',
  'antigravity',
  'hermes',
  'codex',
  'grok-build',
  'cursor',
  'openclaw',
  'kiro',
  'kimi',
  'qwen',
  'copilot',
  'deepseek',
  'grok-bot',
]);

/** True when the user can attach an image to this profile. Requires both
 *  a vision-capable model AND an adapter whose CLI can deliver images
 *  (either inline or via local path reference). */
export function profileAcceptsImages(profile: AgentProfile | undefined | null): boolean {
  if (!profile) return false;
  return Boolean(profile.vision) && IMAGE_CAPABLE_ADAPTERS.has(profile.agentType);
}

/** Adapters whose CLI interprets leading-`/` tokens as slash commands or skills.
 *  antigravity (agy): print mode interprets leading slash commands/skills unless
 *  --disable-slash-commands is passed. */
export const SLASH_COMMAND_CAPABLE_ADAPTERS = new Set([
  'claude-code',
  'pi',
  'opencode',
  'kilocode', // OpenCodeAdapter with bin 'kilo'; runCommand → kilo run --command (command templates)
  'cursor',
  'hermes',
  'codex',
  'grok-build', // ACP session/prompt treats /name as shell builtins + skills
  'antigravity',
  'kiro',
  'qwen', // available_commands_update; runCommand sends /name
  'kimi', // available_commands_update; runCommand sends /name
  'deepseek', // dsh host commands and skills
]);

export function agentSupportsSlashCommands(agentType: string | undefined | null): boolean {
  if (!agentType) return false;
  return SLASH_COMMAND_CAPABLE_ADAPTERS.has(agentType);
}

/** Slash verbs Tierwyn intercepts itself (client-side side channels). Never
 *  dispatched to the agent CLI, so they are allowed even when the selected
 *  adapter is not slash-command capable. Keep in sync with InputBar/App
 *  interceptors (currently `/btw` only). */
export const TIERWYN_NATIVE_SLASH_COMMANDS = new Set(['btw']);
/** @deprecated Use TIERWYN_NATIVE_SLASH_COMMANDS. */

/** True when the typed input is a Tierwyn-native slash verb (`/btw` or `/btw …`).
 *  Exact verb match only — partial prefixes like `/bt` still count as agent
 *  slash input and keep the unsupported warning on non-capable adapters. */
export function isTierwynNativeSlashInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const body = trimmed.slice(1);
  if (!body) return false;
  const name = body.split(/\s+/, 1)[0] ?? '';
  return TIERWYN_NATIVE_SLASH_COMMANDS.has(name);
}
/** @deprecated Use isTierwynNativeSlashInput. */

/** Warning when the selected agent cannot receive slash commands.
 *  Pass `text` (current input) so Tierwyn-native verbs like `/btw` are exempt. */
export function slashCommandUnsupportedMessage(agentType: string, text?: string): string | null {
  if (text !== undefined && isTierwynNativeSlashInput(text)) return null;
  if (agentSupportsSlashCommands(agentType)) return null;
  return 'This agent does not support slash commands.';
}

/** Adapters that implement the permission round-trip — i.e. can surface tool
 *  gates (and AskUserQuestion-style prompts) to the operator UI via
 *  `interaction_request` events in non-bypass modes.
 *
 *  - claude-code: `canUseTool` callback + AskUserQuestion
 *  - codex: server→client approval RPC
 *  - hermes: ACP `session/request_permission`
 *  - grok-build: ACP `session/request_permission` (same protocol as hermes)
 *  - kiro: ACP `session/request_permission`
 *  - qwen: ACP `session/request_permission`
 *  - kimi: ACP `session/request_permission`
 *  - grok-bot: desktop Allow once / Deny / Always allow cards via CDP
 *
 *  All other adapters (pi, opencode, kilocode, cursor, antigravity, openclaw, copilot, deepseek)
 *  ignore `interactionMode` and run bypass-equivalent regardless of the global
 *  setting — so they MUST be hidden/disabled when the parent conversation is
 *  in full 'prompt' permission mode (not 'questions', which bypasses tool gates). */
export const PERMISSION_CAPABLE_ADAPTERS = new Set([
  'claude-code',
  'codex',
  'hermes',
  'grok-build',
  'kiro',
  'qwen',
  'kimi',
  'grok-bot',
]);

/** True when this agentType honours `interactionMode === 'prompt'`. Used by
 *  Phase 4 capability enforcement to hide bypass-only agents in full-permission
 *  mode and to reject incompatible spawn targets. Returns false for unknown
 *  agentTypes (fail closed). */
export function agentSupportsPermissionMode(agentType: string | undefined | null): boolean {
  if (!agentType) return false;
  return PERMISSION_CAPABLE_ADAPTERS.has(agentType);
}

/** Adapters that are consumer chat surfaces rather than Tierwyn-API-capable coding
 *  agents. No delegation/schedule preamble or Bearer (the preamble would hand out
 *  a token we do not want in their chat surface). Handoff/resume priming still
 *  applies when a ResumePlan produces one — see assembleAgentPromptText. */
export const BARE_PROMPT_ADAPTERS = new Set(['grok-bot']);

/** Adapters whose native resume applies a *different* model (same-agent "Continue same session").
 *  Verified: claude-code, codex, grok-build, hermes, kiro, kimi, qwen,
 *  antigravity, cursor, opencode, pi, copilot.
 *  Excluded: openclaw (gateway rejects model overrides), deepseek (in-memory RPC only,
 *  no cold resume), grok-bot (model is remote bot pin). */
export const MODEL_SWITCH_RESUME_ADAPTERS = new Set([
  'claude-code', 'codex', 'grok-build', 'hermes', 'kiro', 'kimi', 'qwen',
  'antigravity', 'cursor', 'opencode', 'pi', 'copilot',
]);

export function agentTakesBarePrompt(agentType: string | undefined | null): boolean {
  return Boolean(agentType) && BARE_PROMPT_ADAPTERS.has(agentType as string);
}

/** Adapters that fold operator text into the *running* turn (true mid-turn
 *  inject) rather than delivering it as a post-turn follow-up. For these,
 *  "Steer" is real and Interrupt & Send is neither offered nor needed.
 *  pi: RPC prompt with streamingBehavior:'steer' — pi delivers it after the
 *  current assistant turn's tool calls, before the next LLM call (mid-run). */
export const LIVE_INJECT_ADAPTERS = new Set(['claude-code', 'codex', 'grok-bot', 'pi']);

/** Adapters whose "steer" is deferred (post status:done) but that expose a
 *  soft `interruptTurn()` — UI offers Queue vs Interrupt & Send. */
export const SOFT_CANCEL_ADAPTERS = new Set(['hermes', 'grok-build', 'kiro', 'qwen', 'kimi']);

/**
 * Adapters whose subprocess stays alive after status:done, so the next
 * operator prompt must reuse the parked SessionRecord instead of reaping it:
 *  - deepseek: dsh treats a reused native id as an on-disk collision
 *  - antigravity: stream-json stdin stay-open; reaping would cold `--conversation` respawn
 */
export const HOLD_OPEN_FOLLOWUP_ADAPTERS = new Set(['deepseek', 'antigravity']);

/** Adapters with no soft cancel — Interrupt & Send = hard `stop()` kill then
 *  reinject via the end-drain follow-up. Catalogue may advertise steer:false
 *  (no mid-turn inject); the UI still offers the Queue vs Interrupt & Send modal. */
export const HARD_STOP_ADAPTERS = new Set([
  'cursor',
  'opencode',
  'kilocode',
  'antigravity',
  'openclaw',
  'kiro',
  'copilot',
]);

export type SteerClass = 'live' | 'force' | 'queue';

/** Soft cancel (interruptTurn) vs hard kill+reinject for Force Steer, or null
 *  if the agentType cannot force-steer. */
export function forceMechanism(agentType: string): 'soft' | 'hard' | null {
  if (SOFT_CANCEL_ADAPTERS.has(agentType)) return 'soft';
  if (HARD_STOP_ADAPTERS.has(agentType)) return 'hard';
  return null;
}

/** Classify running-turn Enter/Send behaviour for a profile. */
export function steerClass(agentType: string, steer: boolean): SteerClass {
  // Hard-stop agents get the force modal even when catalogue steer is false
  // (they never soft-inject; Interrupt & Send is kill+reinject).
  if (!steer && !HARD_STOP_ADAPTERS.has(agentType)) return 'queue';
  if (LIVE_INJECT_ADAPTERS.has(agentType)) return 'live';
  if (SOFT_CANCEL_ADAPTERS.has(agentType) || HARD_STOP_ADAPTERS.has(agentType)) return 'force';
  return 'queue';
}

/** True when the interaction mode requires a permission-capable agent.
 *  'questions' bypasses tool permissions (only AskUserQuestion is surfaced),
 *  so bypass-only agents are allowed. */
export function interactionModeRequiresPermissionCapable(
  mode: 'bypass' | 'questions' | 'prompt' | undefined | null,
): boolean {
  return mode === 'prompt';
}

// ── Effort / thinking level ──────────────────────────────────────────
// Capability is a property of the CLI, keyed by agentType — code-versioned,
// not stored in the DB or agent-profiles.json. See plan D1.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Universal default: present in every adapter's enum, never clamps on switch. */
export const DEFAULT_EFFORT: EffortLevel = 'medium';

const EFFORT_LEVELS_BY_ADAPTER: Record<string, readonly EffortLevel[]> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex':       ['low', 'medium', 'high'],
  'grok-build':  ['low', 'medium', 'high', 'xhigh'],
  'kiro':        ['low', 'medium', 'high', 'xhigh', 'max'],
  // agy 1.1.27+: native `--effort <low|medium|high>`. Baked model names
  // (`gemini-3.5-flash-medium`, `Gemini 3.5 Flash (Medium)`) still omit the
  // flag at spawn time via modelNameBakesEffort — this list only drives the
  // picker + clamp. `max`/`xhigh` are not accepted by agy. The Claude
  // Thinking rows reject the flag outright — modelRejectsEffort omits it.
  'antigravity': ['low', 'medium', 'high'],
  // copilot: CLI has --effort, but it is only accepted alongside a pinned
  // --model, and account policy (model_picker_enabled=false) can make every
  // model pin rejected, leaving auto-only routing — which rejects effort
  // outright ("Model \"auto\" does not support reasoning effort
  // configuration"). Effort is therefore unreachable in practice; excluded.
  // Verified against live `dsh --profile sdk` (deepseek-official/deepseek-chat):
  // accepts low, high, max; rejects medium and xhigh.
  'deepseek':    ['low', 'high', 'max'],
};

export function effortLevelsFor(agentType: string | undefined | null): readonly EffortLevel[] {
  return (agentType && EFFORT_LEVELS_BY_ADAPTER[agentType]) || [];
}

/** Server-side defense: return level only if the adapter supports it, else undefined (omit flag). */
export function clampEffort(agentType: string, level: EffortLevel | undefined): EffortLevel | undefined {
  if (!level) return undefined;
  return effortLevelsFor(agentType).includes(level) ? level : undefined;
}

/** The stored user preference: a concrete level, or 'off' to omit the effort
 *  flag entirely at spawn — needed for adapters/models that reject --effort. */
export type EffortPreference = EffortLevel | 'off';

/** Client display/transport clamp (D7/B2): the *effective* level for an adapter —
 *  the stored pick if supported, else the highest allowed level, else undefined
 *  (adapter has no effort). 'off' always resolves to undefined so nothing is
 *  sent. Distinct from clampEffort, which omits an unsupported
 *  level; this one falls back to the ceiling so the badge and payload always carry
 *  a concrete level for effort-capable adapters. */
export function resolveEffort(agentType: string | undefined | null, stored: EffortPreference): EffortLevel | undefined {
  if (stored === 'off') return undefined;
  const allowed = effortLevelsFor(agentType);
  if (allowed.length === 0) return undefined;
  return allowed.includes(stored) ? stored : allowed[allowed.length - 1];
}

/**
 * agy 1.1.x (and some other CLIs) bake effort into the model id or display
 * name: slug `gemini-3.7-flash-low` / label `Gemini 3.7 Flash (Low)`.
 * Those rows already pick the level in the model picker; a separate --effort
 * flag is ignored or rejected. Claude Thinking slugs do not match.
 */
export function modelNameBakesEffort(model: string | undefined | null): boolean {
  if (!model) return false;
  if (/\((Low|Medium|High)\)/i.test(model)) return true;
  if (/(?:^|-)(low|medium|high)$/i.test(model.trim())) return true;
  return false;
}

/**
 * Models whose CLI rejects the effort flag outright for a given adapter —
 * distinct from modelNameBakesEffort, where the level is already encoded in
 * the model id/label. agy rejects the combo for its Claude Thinking rows:
 * `invalid model selection (--model "claude-opus-4-6-thinking" --effort
 * "medium"): --effort is not supported for model "claude-opus-4-6-thinking"`.
 * Matches either the slug passed as --model or the display label.
 */
const EFFORT_REJECTED_MODEL_PATTERNS: readonly { agent: string; pattern: RegExp }[] = [
  { agent: 'antigravity', pattern: /thinking/i },
];

export function modelRejectsEffort(agentType: string | undefined | null, model: string | undefined | null): boolean {
  if (!agentType || !model) return false;
  return EFFORT_REJECTED_MODEL_PATTERNS.some(
    (entry) => entry.agent === agentType && entry.pattern.test(model),
  );
}

/** Model-aware spawn-time gate for the effort flag: undefined (omit) when the
 *  stored preference is 'off', the adapter has no effort levels, the model
 *  bakes the level into its name, or the model's CLI rejects the flag
 *  outright (agy Claude Thinking rows). */
export function resolveEffortForModel(
  agentType: string | undefined | null,
  model: string | undefined | null,
  stored: EffortPreference,
): EffortLevel | undefined {
  if (modelNameBakesEffort(model) || modelRejectsEffort(agentType, model)) return undefined;
  return resolveEffort(agentType, stored);
}
