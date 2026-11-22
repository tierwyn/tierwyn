/**
 * Per-message prompt options descriptor and validation system.
 * Ephemeral per-turn CLI flags/options for agent adapters (Antigravity first).
 */

export type PromptOptionValue = string | boolean;

export type PromptOptions = Record<string, PromptOptionValue>;

export type PromptOptionDescriptor =
  | {
      kind: 'toggle';
      key: string;
      label: string;
      description?: string;
      caveat?: string;
    }
  | {
      kind: 'select';
      key: string;
      label: string;
      description?: string;
      caveat?: string;
      /** First entry is the neutral default and MUST map to "emit no flag". */
      choices: readonly { value: string; label: string; description?: string }[];
    }
  | {
      kind: 'text';
      key: string;
      label: string;
      description?: string;
      caveat?: string;
      placeholder?: string;
      presets?: readonly { value: string; label: string }[];
      maxLength?: number;
      validate?: 'json';
    };

const JSON_SCHEMA_PRESETS: readonly { value: string; label: string }[] = [
  {
    label: 'Structured Summary',
    value: JSON.stringify(
      {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          details: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['summary'],
      },
      null,
      2,
    ),
  },
  {
    label: 'Action Plan',
    value: JSON.stringify(
      {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { step: { type: 'integer' }, description: { type: 'string' } },
              required: ['step', 'description'],
            },
          },
        },
        required: ['steps'],
      },
      null,
      2,
    ),
  },
];

const CLAUDE_FAMILY_BASE: readonly PromptOptionDescriptor[] = [
  {
    kind: 'text',
    key: 'jsonSchema',
    label: 'JSON schema',
    description: 'Constrain the final answer to a JSON schema (--json-schema). Paste an inline JSON schema object.',
    placeholder: '{"type":"object","properties":{…}}',
    maxLength: 8192,
    validate: 'json',
    presets: JSON_SCHEMA_PRESETS,
  },
  {
    kind: 'toggle',
    key: 'disableSlashCommands',
    label: 'Disable slash commands',
    description: 'Suppresses slash/skill expansion (--disable-slash-commands).',
  },
  {
    kind: 'select',
    key: 'maxTurns',
    label: 'Max agentic turns',
    description: 'Cap tool loops (--max-turns).',
    choices: [
      { value: 'default', label: 'Unlimited' },
      { value: '1', label: '1 turn' },
      { value: '3', label: '3 turns' },
      { value: '5', label: '5 turns' },
      { value: '10', label: '10 turns' },
    ],
  },
];

const PERMISSION_MODE_CAVEAT =
  'Overrides the conversation\'s interaction mode for this turn. Escalating modes (bypass / full access) are deliberately not offered here — use the conversation\'s interaction mode.';

const CLAUDE_CODE_PERMISSION_MODE: PromptOptionDescriptor = {
  kind: 'select',
  key: 'permissionMode',
  label: 'Permission mode',
  description: 'Maps to --permission-mode for this turn.',
  caveat: PERMISSION_MODE_CAVEAT,
  choices: [
    { value: 'default', label: 'Use conversation setting' },
    { value: 'manual', label: 'Manual (prompt for tools)' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'plan', label: 'Plan first' },
    { value: 'dontAsk', label: 'Don\'t ask' },
  ],
};

const CLAUDE_CODE_RESTRICTED: PromptOptionDescriptor = {
  kind: 'toggle',
  key: 'restricted',
  label: 'Restricted mode',
  description:
    'Remove command/code-running tools and WebFetch, confine file tools to the working dirs, ignore user/project/local settings (claude --restricted).',
  caveat:
    'Applied through the Claude Agent SDK (extraArgs: --restricted). Never runs with bypass permissions — file edits inside the working dirs are auto-approved, other gated tools ask for approval.',
};

const CLAUDE_CODE_SAFE_MODE: PromptOptionDescriptor = {
  kind: 'toggle',
  key: 'safeMode',
  label: 'Safe mode (no customizations)',
  description:
    'Disable CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents (claude --safe-mode).',
  caveat:
    'Applied through the Claude Agent SDK (extraArgs: --safe-mode). Keeps your interaction/permission mode; skills, MCP servers and hooks are off for this turn.',
};

const CLAUDE_CODE_PROMPT_OPTIONS: readonly PromptOptionDescriptor[] = [
  ...CLAUDE_FAMILY_BASE,
  CLAUDE_CODE_PERMISSION_MODE,
  CLAUDE_CODE_RESTRICTED,
  CLAUDE_CODE_SAFE_MODE,
];

const OPENCODE_PROMPT_OPTIONS: readonly PromptOptionDescriptor[] = [
  {
    kind: 'select',
    key: 'variant',
    label: 'Reasoning variant',
    description: 'Provider-specific reasoning effort (--variant).',
    choices: [
      { value: 'default', label: 'Default' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ],
  },
  {
    kind: 'toggle',
    key: 'thinking',
    label: 'Show thinking',
    description: 'Include thinking blocks in the JSON stream (--thinking).',
  },
  {
    kind: 'toggle',
    key: 'pure',
    label: 'Pure mode',
    description: 'Disable external plugins for this turn (--pure).',
  },
  {
    kind: 'text',
    key: 'agent',
    label: 'Agent profile',
    description: 'Override the agent profile (--agent).',
    placeholder: 'build',
    maxLength: 64,
  },
];

export const PROMPT_OPTIONS_BY_ADAPTER: Record<string, readonly PromptOptionDescriptor[]> = {
  antigravity: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Execution mode',
      description: 'Maps to agy --mode.',
      caveat: 'In headless print mode agy still executes tools in plan mode — plan biases the model toward proposing first, it is not a hard gate.',
      choices: [
        { value: 'default', label: 'Default' }, // neutral default: no flag emitted
        { value: 'plan', label: 'Plan first' },
        { value: 'accept-edits', label: 'Accept edits' },
      ],
    },
    {
      kind: 'toggle',
      key: 'sandbox',
      label: 'Terminal sandbox',
      description: 'Run shell tools inside the OS sandbox (agy --sandbox).',
    },
    {
      kind: 'text',
      key: 'jsonSchema',
      label: 'JSON schema',
      description: 'Constrain the final answer to a JSON schema (agy --json-schema). Paste an inline JSON schema object.',
      placeholder: '{"type":"object","properties":{…}}',
      maxLength: 8192,
      validate: 'json',
      presets: JSON_SCHEMA_PRESETS,
    },
    {
      kind: 'toggle',
      key: 'disableSlashCommands',
      label: 'Disable slash commands',
      description: 'Suppresses slash/skill expansion (agy --disable-slash-commands).',
    },
  ],
  cursor: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Execution mode',
      description: 'Maps to cursor-agent --mode.',
      caveat: 'plan and ask are read-only — no file edits or shell writes. Default agent mode (no flag) allows full tool use.',
      choices: [
        { value: 'default', label: 'Agent (default)' },
        { value: 'plan', label: 'Plan first' },
        { value: 'ask', label: 'Ask / Q&A' },
      ],
    },
    {
      kind: 'select',
      key: 'sandbox',
      label: 'Sandbox',
      description: 'Override cursor-agent sandbox mode (--sandbox).',
      choices: [
        { value: 'default', label: 'CLI default' },
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
    {
      kind: 'toggle',
      key: 'autoReview',
      label: 'Auto-review (Smart Auto)',
      description: 'Server classifier auto-runs safe tool calls; prompts for the rest (--auto-review).',
      caveat: 'Tierwyn normally omits this flag because unanswered approval prompts hang non-interactive runs. Enabling may stall the turn.',
    },
  ],
  copilot: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Agent mode',
      description: 'Maps to copilot --mode.',
      choices: [
        { value: 'default', label: 'Default' },
        { value: 'plan', label: 'Plan' },
        { value: 'autopilot', label: 'Autopilot' },
      ],
    },
    {
      kind: 'select',
      key: 'effort',
      label: 'Reasoning effort',
      description: 'Maps to --effort. Requires a pinned model (not auto).',
      caveat: 'Ignored when the profile model is "auto". Use the model picker to pin a concrete model first.',
      choices: [
        { value: 'default', label: 'Profile default' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
    {
      kind: 'select',
      key: 'toolsPolicy',
      label: 'Tool policy',
      description: 'Which tools Copilot may use without confirmation.',
      choices: [
        { value: 'default', label: 'Allow all (minus deny list)' },
        { value: 'readOnly', label: 'Read-only (view, grep, glob)' },
      ],
    },
    {
      kind: 'toggle',
      key: 'assistedApproval',
      label: 'Assisted approval',
      description: 'Route permission requests through the safety judge (--assisted-approval).',
      caveat: 'Requires experimental feature flag on the Copilot side; may conflict with --allow-all-tools.',
    },
  ],
  opencode: OPENCODE_PROMPT_OPTIONS,
  kilocode: OPENCODE_PROMPT_OPTIONS,
  'claude-code': CLAUDE_CODE_PROMPT_OPTIONS,
  openclaw: [
    {
      kind: 'select',
      key: 'thinking',
      label: 'Thinking level',
      description: 'Maps to openclaw --thinking.',
      choices: [
        { value: 'default', label: 'Default' },
        { value: 'off', label: 'Off' },
        { value: 'minimal', label: 'Minimal' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' },
      ],
    },
    {
      kind: 'select',
      key: 'timeout',
      label: 'Turn timeout',
      description: 'Override agent command timeout (--timeout).',
      choices: [
        { value: 'default', label: 'Default (600s)' },
        { value: '120', label: '2 minutes' },
        { value: '300', label: '5 minutes' },
        { value: '600', label: '10 minutes' },
        { value: '1800', label: '30 minutes' },
      ],
    },
  ],
  qwen: [
    {
      kind: 'select',
      key: 'permissionMode',
      label: 'Permission mode',
      description: 'ACP session/set_mode modeId for this turn.',
      caveat: 'Overrides conversation interaction mode for one message only.',
      choices: [
        { value: 'default', label: 'Use conversation setting' },
        { value: 'default-strict', label: 'Default (prompt for tools)' },
        { value: 'yolo', label: 'Yolo (auto-approve)' },
      ],
    },
    {
      kind: 'toggle',
      key: 'sandbox',
      label: 'Container sandbox',
      description: 'Re-exec the qwen agent inside a container (qwen --acp -s).',
      caveat:
        'Requires Docker or Podman. First use pulls a multi-GB image (ghcr.io/qwenlm/qwen-code:<version>) and the turn will appear to stall. Inside the container the agent cannot reach Tierwyn on 127.0.0.1 — delegation, schedule and plugin calls from the agent will fail.',
    },
  ],
  codex: [
    {
      kind: 'select',
      key: 'sandbox',
      label: 'Sandbox policy',
      description: 'thread/start and thread/resume sandbox parameter.',
      caveat: 'sandbox binds at thread creation; changing it starts a new Codex thread for this turn.',
      choices: [
        { value: 'default', label: 'Workspace write (default)' },
        { value: 'read-only', label: 'Read-only' },
        { value: 'danger-full-access', label: 'Full access' },
      ],
    },
  ],
  pi: [
    {
      kind: 'select',
      key: 'thinking',
      label: 'Thinking level',
      description: 'Maps to --thinking on respawn.',
      choices: [
        { value: 'default', label: 'Default' },
        { value: 'off', label: 'Off' },
        { value: 'minimal', label: 'Minimal' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra high' },
        { value: 'max', label: 'Max' },
      ],
    },
    {
      kind: 'select',
      key: 'toolsProfile',
      label: 'Tools',
      description: 'Tool allowlist for this turn.',
      choices: [
        { value: 'default', label: 'Full toolkit' },
        { value: 'readOnly', label: 'Read-only (read,grep,find,ls)' },
        { value: 'none', label: 'No tools (--no-tools)' },
      ],
    },
  ],
  deepseek: [
    {
      kind: 'select',
      key: 'reasoningEffort',
      label: 'Reasoning effort',
      description: 'dsh initialize reasoningEffort — requires re-initialize or respawn.',
      choices: [
        { value: 'default', label: 'Profile default' },
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' },
      ],
    },
  ],
  kimi: [
    {
      kind: 'select',
      key: 'permissionMode',
      label: 'Permission mode',
      description: 'ACP session/set_mode modeId for this turn.',
      caveat: 'Overrides conversation interaction mode for one message only.',
      choices: [
        { value: 'default', label: 'Use conversation setting' },
        { value: 'default-strict', label: 'Default (may ask)' },
        { value: 'yolo', label: 'Yolo' },
        { value: 'auto', label: 'Auto (fully autonomous)' },
      ],
    },
  ],
  kiro: [
    {
      kind: 'select',
      key: 'effort',
      label: 'Reasoning effort',
      description: 'Maps to kiro-cli acp --effort. Changing it respawns the ACP child.',
      choices: [
        { value: 'default', label: 'Profile default' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra high' },
        { value: 'max', label: 'Max' },
      ],
    },
    {
      kind: 'toggle',
      key: 'trustAllTools',
      label: 'Trust all tools',
      description: 'Auto-approve every tool permission request (kiro-cli acp --trust-all-tools).',
      caveat: 'Changing it restarts the Kiro ACP process; the session resumes via native session id.',
    },
  ],
  hermes: [
    {
      kind: 'toggle',
      key: 'yolo',
      label: 'Yolo mode',
      description: 'Auto-approve tool calls (hermes --yolo acp). Requires respawn.',
      caveat: '--yolo is a top-level Hermes flag (hermes --yolo acp), not an acp subcommand flag.',
    },
  ],
  'grok-build': [
    {
      kind: 'select',
      key: 'sandbox',
      label: 'Sandbox',
      description: 'Sandbox profile for filesystem and network access (grok --sandbox).',
      caveat:
        'Kernel-enforced for the whole process lifetime — changing it restarts the grok subprocess (context resumes via session/load). `read-only` and `strict` block child-process network on Linux, which breaks web_search, MCP servers, and Tierwyn delegation/schedule curls from inside the agent.',
      choices: [
        { value: 'default', label: 'Off (no sandbox)' },
        { value: 'workspace', label: 'Workspace (write CWD + temp)' },
        { value: 'read-only', label: 'Read-only (no project writes)' },
        { value: 'strict', label: 'Strict (untrusted code)' },
      ],
    },
    {
      kind: 'select',
      key: 'reasoningEffort',
      label: 'Reasoning effort',
      description: 'ACP _meta.reasoningEffort for this turn.',
      choices: [
        { value: 'default', label: 'Profile default' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra high' },
      ],
    },
    {
      kind: 'select',
      key: 'yoloMode',
      label: 'Yolo mode',
      description: 'ACP _meta.yoloMode for this turn.',
      caveat: 'Overrides conversation interaction mode for one turn.',
      choices: [
        { value: 'default', label: 'Use conversation setting' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
  ],
};

/** Modal footnote explaining how staged options bind for this adapter. */
export function promptOptionsFootnote(agentType: string | undefined | null): string {
  if (agentType === 'antigravity') {
    return 'Changing options starts a new agy process; conversation context is preserved.';
  }
  if (agentType === 'cursor') {
    return 'Cursor spawns a fresh process per message; options apply to this turn only.';
  }
  if (agentType === 'copilot') {
    return 'Copilot spawns a fresh process per message; options apply to this turn only.';
  }
  if (agentType === 'opencode' || agentType === 'kilocode') {
    return 'OpenCode and KiloCode spawn a fresh process per message; options apply to this turn only.';
  }
  if (agentType === 'openclaw') {
    return 'OpenClaw spawns a fresh process per message; options apply to this turn only.';
  }
  if (agentType === 'qwen' || agentType === 'kimi') {
    return 'Options apply to the next prompt; ACP session persists.';
  }
  if (agentType === 'kiro') {
    return 'Changing effort or trust-all-tools restarts the Kiro ACP process; session resumes via native session id.';
  }
  if (agentType === 'hermes') {
    return 'Changing yolo restarts the Hermes ACP process; session resumes via native session id.';
  }
  if (agentType === 'grok-build') {
    return 'Sandbox binds at process spawn; effort/yolo apply via session/set_model. Changing sandbox restarts the grok subprocess.';
  }
  if (agentType === 'codex') {
    return 'sandbox binds at thread creation; changing it starts a new Codex thread for this turn.';
  }
  if (agentType === 'pi') {
    return 'Changing options restarts the Pi process; session resumes via native session path.';
  }
  if (agentType === 'claude-code') {
    return 'SDK applies options on this query (--restricted / --safe-mode go through the SDK extraArgs). The CLI fallback only runs in bypass interaction mode when the SDK cannot start.';
  }
  if (agentType === 'deepseek') {
    return 'reasoningEffort binds at dsh initialize; changing it restarts the process.';
  }
  return 'Options apply strictly to the next submission, then reset automatically.';
}

export function promptOptionsFor(agentType: string | undefined | null): readonly PromptOptionDescriptor[] {
  return (agentType && PROMPT_OPTIONS_BY_ADAPTER[agentType]) || [];
}

/** Structural equality for two sanitised option bags. undefined === {} === "no options". */
export function promptOptionsEqual(
  a: PromptOptions | undefined | null,
  b: PromptOptions | undefined | null,
): boolean {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length === 0 && rightKeys.length === 0) return true;
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    if (leftKeys[i] !== rightKeys[i]) return false;
    if (left[leftKeys[i]!] !== right[rightKeys[i]!]) return false;
  }
  return true;
}

export class PromptOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptOptionError';
  }
}

/**
 * Strip a raw options bag down to what `agentType` actually supports.
 *  - unknown key                   → dropped silently (never fatal)
 *  - wrong value type              → dropped silently
 *  - select value not in `choices` → dropped silently
 *  - select value === choices[0].value (the neutral default) → dropped
 *  - toggle value === false        → dropped (default)
 *  - empty / whitespace-only text  → dropped
 *  - text longer than maxLength   → THROWS PromptOptionError
 *  - validate:'json' value not valid JSON object → THROWS PromptOptionError
 *  - any string value starting with '-' → THROWS PromptOptionError (CLI flag injection protection)
 * Returns `undefined` when nothing survives, so callers can spread conditionally.
 */
export function sanitisePromptOptions(
  agentType: string | undefined | null,
  raw: PromptOptions | undefined | null,
): PromptOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const descriptors = promptOptionsFor(agentType);
  if (descriptors.length === 0) return undefined;

  const result: PromptOptions = {};

  for (const desc of descriptors) {
    if (!(desc.key in raw)) continue;
    const val = raw[desc.key];
    if (val === undefined || val === null) continue;

    if (typeof val === 'string' && val.trim().startsWith('-')) {
      throw new PromptOptionError(`Option "${desc.key}" value cannot start with "-"`);
    }

    if (desc.kind === 'toggle') {
      if (typeof val !== 'boolean') continue;
      if (val === true) {
        result[desc.key] = true;
      }
      // val === false is the neutral default, drop it
    } else if (desc.kind === 'select') {
      if (typeof val !== 'string') continue;
      const matchingChoice = desc.choices.find((c) => c.value === val);
      if (!matchingChoice) continue;
      // First choice is neutral default -> omit flag
      if (val === desc.choices[0].value) continue;
      result[desc.key] = val;
    } else if (desc.kind === 'text') {
      if (typeof val !== 'string') continue;
      const trimmed = val.trim();
      if (!trimmed) continue;

      if (desc.maxLength && val.length > desc.maxLength) {
        throw new PromptOptionError(`Option "${desc.key}" exceeds maximum length of ${desc.maxLength}`);
      }

      if (desc.validate === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(val);
        } catch {
          throw new PromptOptionError(`Option "${desc.key}" must be a valid JSON object`);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new PromptOptionError(`Option "${desc.key}" must be a valid JSON object`);
        }
      }

      result[desc.key] = val;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Options that must never be honoured on a slash-command turn. */
export function stripCommandIncompatibleOptions(opts: PromptOptions | undefined | null): PromptOptions | undefined {
  if (!opts) return undefined;
  const { disableSlashCommands: _, ...rest } = opts;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
