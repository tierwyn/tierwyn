import { EventEmitter } from 'events';
import { existsSync, readdirSync, mkdirSync, chmodSync, promises as fsp } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { runDir } from '../../config/brand.js';
import { toClaudeSdkMcp, type ClaudeMcpConfig } from '../../mcp/inject.js';
import { escalateKill } from '../escalateKill.js';
import { termChildProcess } from '../../sandbox/bwrap.js';
import { createInterface } from 'readline';
import type { AgentAdapter, SessionConfig, Attachment, NormalisedEvent, HelperEvent, ModelDescriptor, CommandDescriptor, EffortLevel, OneShotOpts, OneShotResult, OneShotMode, PromptOptions, McpLiveStatus, McpControlAction, ResolvedMcpServer } from '@tierwyn/shared';
import { clampEffort, contextWindowOccupancy, computeContextWindowPct, QUOTA_SHAPE } from '@tierwyn/shared';
import { readProfiles } from '../../profiles.js';
import { adapterContextWindow } from '../../contextWindow.js';
import { scanSkillDir, walkPluginSkillCache } from '../skillScan.js';
import { attachmentToContentBlocks, type AnthropicContentBlock } from '../anthropicAttachment.js';
import { silentSuccessAckFor } from '../silentSuccessCommands.js';
import { forkClaudeJsonl, locateJsonlFile, exciseTurnFromJsonl } from '../nativeJsonlFork.js';
import { applyModelSettings, readClaudeModelCatalog, readClaudeModelSettings } from './modelCatalog.js';
import { claudeExecutableOpt } from './executable.js';
import { safeNativeSessionId } from '../sessionId.js';

// Tool names used by Claude Code for file operations
const FILE_TOOLS = new Set(['str_replace_editor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const CLAUDE_MAX_TURNS = new Set(['1', '3', '5', '10']);
const CLAUDE_CODE_PERMISSION_MODES = new Set(['manual', 'acceptEdits', 'plan', 'dontAsk']);

/** Append per-session prompt-option flags after --effort and before --resume. */
function appendClaudePromptOptionArgs(args: string[], options?: PromptOptions | null): void {
  if (!options) return;
  const schema = options['jsonSchema'];
  if (typeof schema === 'string' && schema) args.push('--json-schema', schema);
  if (options['disableSlashCommands'] === true) args.push('--disable-slash-commands');
  const maxTurns = options['maxTurns'];
  if (typeof maxTurns === 'string' && CLAUDE_MAX_TURNS.has(maxTurns)) {
    args.push('--max-turns', maxTurns);
  }
  const pm = options['permissionMode'];
  if (typeof pm === 'string' && CLAUDE_CODE_PERMISSION_MODES.has(pm)) {
    args.push('--permission-mode', pm);
  }
}

// Claude Code writes ~/.claude/cache/model-catalog/*-cc.json; listModels() reads
// it (no spawn). Seed rows in agent-profiles.json stay the curated cold-start set.

const READONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const READONLY_DENY = [
  'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Task', 'Skill',
] as const;

const CLAUDE_CODE_MAX_TURNS = new Set(['1', '3', '5', '10']);

/** Error text that means the turn was cut short on purpose — operator Stop /
 *  Interrupt & Send, session teardown, SDK abort — not a real failure. These
 *  used to surface as red false errors whenever a stop raced the turn end. */
const INTERRUPT_SHAPE = /interrupt|abort|cancel|SIGTERM|exited with code (130|143)\b/i;

/** Quota / allowance text is never treated as a benign interrupt — a genuine
 *  usage-limit, rate-limit or billing failure must still surface as an error.
 *  QUOTA_SHAPE is shared with the usage-watcher (cursor keeps its own narrow
 *  fatal-stderr regex — see detectCursorFatalStderr). */
const isBenignInterruptMessage = (msg: string): boolean =>
  INTERRUPT_SHAPE.test(msg) && !QUOTA_SHAPE.test(msg);

const CLAUDE_SDK_PERMISSION_MODES = new Set(['manual', 'acceptEdits', 'plan', 'dontAsk']);

/** Map per-message prompt options onto Claude Agent SDK query() fields. */
export function buildClaudeCodeSdkOptionOverrides(options?: PromptOptions | null): {
  maxTurns?: number;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  skills?: [];
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk';
} {
  if (!options) return {};
  const out: {
    maxTurns?: number;
    outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
    skills?: [];
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk';
  } = {};
  const maxTurns = options['maxTurns'];
  if (typeof maxTurns === 'string' && CLAUDE_CODE_MAX_TURNS.has(maxTurns)) {
    out.maxTurns = Number(maxTurns);
  }
  if (options['disableSlashCommands'] === true) {
    out.skills = [];
  }
  const schema = options['jsonSchema'];
  if (typeof schema === 'string' && schema) {
    try {
      const parsed = JSON.parse(schema) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.outputFormat = { type: 'json_schema', schema: parsed as Record<string, unknown> };
      }
    } catch { /* sanitise already validated JSON; ignore parse failure */ }
  }
  const pm = options['permissionMode'];
  if (typeof pm === 'string' && CLAUDE_SDK_PERMISSION_MODES.has(pm)) {
    // CLI `manual` maps to the SDK's strict/default mode (prompt for tools).
    out.permissionMode = pm === 'manual' ? 'default' : (pm as 'acceptEdits' | 'plan' | 'dontAsk');
  }
  return out;
}

type InteractionMode = 'bypass' | 'questions' | 'prompt';

/** The per-turn permission-mode override (CLI `manual` / `acceptEdits` / `plan` / `dontAsk`), if valid. */
export function claudeCodePermissionOverride(options?: PromptOptions | null): 'manual' | 'acceptEdits' | 'plan' | 'dontAsk' | undefined {
  const pm = options?.['permissionMode'];
  return typeof pm === 'string' && CLAUDE_SDK_PERMISSION_MODES.has(pm)
    ? (pm as 'manual' | 'acceptEdits' | 'plan' | 'dontAsk')
    : undefined;
}

/**
 * SDK permission wiring for one turn (pure).
 *  - Baseline: `bypass` -> bypassPermissions, otherwise `default` + canUseTool.
 *  - A valid permissionMode override replaces the baseline.
 *  - `restricted` never runs under bypassPermissions (the CLI refuses it): when nothing else
 *    chose a mode it falls back to `acceptEdits` (command tools are removed, edits stay in the
 *    working dirs).
 *  - `canUseTool` is attached whenever the conversation is not bypass, or when a manual/plan/
 *    acceptEdits override or restricted is active while bypass — otherwise those modes would
 *    silently deny every gated tool because nobody answers the prompt.
 *    `dontAsk` never prompts, so it does not need a handler.
 *  - `restricted` / `safeMode` map to the CLI flags through the SDK's `extraArgs`.
 */
export function buildClaudeCodeSdkPermissionOptions(
  interactionMode: InteractionMode,
  options?: PromptOptions | null,
): {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
  attachCanUseTool: boolean;
  /** Treat gated-tool prompts as operator permission cards even though the conversation is bypass. */
  promptForPermissions: boolean;
  extraArgs?: Record<string, string | null>;
} {
  const override = claudeCodePermissionOverride(options);
  const restricted = options?.['restricted'] === true;
  const safeMode = options?.['safeMode'] === true;
  let permissionMode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
  if (override) {
    permissionMode = override === 'manual' ? 'default' : override;
  } else if (interactionMode === 'bypass') {
    permissionMode = restricted ? 'acceptEdits' : 'bypassPermissions';
  } else {
    permissionMode = 'default';
  }
  const bypassConversation = interactionMode === 'bypass';
  const promptForPermissions = bypassConversation
    && permissionMode !== 'bypassPermissions'
    && permissionMode !== 'dontAsk';
  const attachCanUseTool = !bypassConversation || promptForPermissions;
  const extraArgs: Record<string, string | null> = {};
  if (restricted) extraArgs['restricted'] = null;
  if (safeMode) extraArgs['safe-mode'] = null;
  return {
    permissionMode,
    attachCanUseTool,
    promptForPermissions,
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
  };
}

/** Last non-empty line of a stderr buffer, trimmed for an error message. */
export function lastStderrLine(buf: string): string {
  const lines = buf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 300 ? `${last.slice(0, 297)}...` : last;
}

/**
 * Argv for the `claude --print` CLI fallback (pure; no I/O).
 * `--dangerously-skip-permissions` is added ONLY when the conversation is bypass, there is no
 * permission-mode override and restricted is off. The flag overrides `--permission-mode`
 * (verified on CLI 2.1.286) and `--restricted` refuses bypassPermissions (exit 1), so in every
 * other case we pass `--permission-mode` alone. The caller must not use the fallback for
 * non-bypass conversations (it cannot gate tool permissions); `manual` is emitted there only
 * so the builder stays total.
 */
export function buildClaudeCliArgs(input: {
  interactionMode: InteractionMode;
  textOnly?: boolean;
  model?: string;
  effort?: string;
  options?: PromptOptions | null;
  resumeSessionId?: string;
  trustRepoConfig?: boolean;
}): string[] {
  const { options } = input;
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
  const override = claudeCodePermissionOverride(options);
  const restricted = options?.['restricted'] === true;
  const bypass = input.interactionMode === 'bypass' && !override && !restricted;
  if (bypass) args.push('--dangerously-skip-permissions');
  if (input.textOnly) {
    // --max-turns is not in `claude --help` (2.1.286) but the CLI still accepts it
    // and appendClaudePromptOptionArgs already uses it for this adapter.
    args.push('--tools', '', '--setting-sources', '', '--strict-mcp-config', '--max-turns', '1');
  } else if (!input.trustRepoConfig) {
    args.push('--setting-sources', 'user');
  }
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  // Pushes --permission-mode <override> when an override is set (and json-schema, max-turns, ...).
  appendClaudePromptOptionArgs(args, options);
  if (!bypass && !override) {
    // restricted (bypass conversation) -> acceptEdits; non-bypass conversation -> manual.
    args.push('--permission-mode', input.interactionMode === 'bypass' ? 'acceptEdits' : 'manual');
  }
  if (restricted) args.push('--restricted');
  if (options?.['safeMode'] === true) args.push('--safe-mode');
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  return args;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly oneShotModes: readonly OneShotMode[] = ['none', 'read_only'];

  private _claudeHome: string;
  private _managedSettingsDir: string;
  private _interactionMode: InteractionMode;
  /** Last SDK start failure message for the current turn (used to explain a refused CLI fallback). */
  private _sdkInitError = '';
  private _pendingInteractions = new Map<
    string,
    (r: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }) => void
  >();
  private _pendingInputs = new Map<string, Record<string, unknown>>();
  private _pendingAskUserQuestions = new Map<string, (result: { behavior: 'allow'; updatedInput: Record<string, unknown> }) => void>();
  private _queryFn: typeof query;
  readonly _spawn: typeof spawn;
  private _sandboxed = false;

  constructor(opts: {
    claudeHome?: string;
    managedSettingsDir?: string;
    interactionMode?: 'bypass' | 'questions' | 'prompt';
    queryFn?: typeof query;
    spawn?: typeof spawn;
    spawnFn?: typeof spawn;
    sandboxed?: boolean;
  } = {}) {
    this._claudeHome = opts.claudeHome ?? join(homedir(), '.claude');
    this._managedSettingsDir = opts.managedSettingsDir ?? '/etc/claude-code';
    this._interactionMode = opts.interactionMode ?? 'bypass';
    this._queryFn = opts.queryFn ?? query;
    this._spawn = opts.spawn ?? opts.spawnFn ?? spawn;
    this._sandboxed = opts.sandboxed === true;
  }

  private _sdkSpawnProcessOpt(): Record<string, unknown> {
    if (!this._sandboxed) return {};
    return {
      spawnClaudeCodeProcess: ({
        command,
        args,
        cwd,
        env,
        signal,
      }: {
        command: string;
        args: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
      }) => this._spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] }),
    };
  }

  private _emitter = new EventEmitter();
  private _abortController: AbortController | null = null;
  private _subprocess: ReturnType<typeof spawn> | null = null;
  private _sessionId = '';
  private _conversationId = '';
  private _nativeSessionId = '';
  private _resumeNativeSessionId = '';
  private _cwd = '';
  private _seq = 0;
  private _streamingContent = false;
  // True once the current turn has emitted any assistant text or tool_use.
  // Reset on each prompt/steer. Used by the result handler to detect turns
  // that completed with zero assistant output (unknown skill, silent CLI
  // quirk) so we surface a visible error instead of a silent status:done.
  private _turnProducedContent = false;
  /** Set when the current turn is a slash command that may legitimately return no output. */
  private _silentSuccessAck: string | null = null;
  private _fiveHourPct: number | undefined = undefined;
  private _fiveHourResetsAt: number | undefined = undefined;
  private _sevenDayPct: number | undefined = undefined;
  private _sevenDayResetsAt: number | undefined = undefined;
  private _query: ReturnType<typeof query> | undefined = undefined;

  private _model = '';
  private _effort: EffortLevel | undefined = undefined;
  private _contextWindowSize: number | undefined = undefined;
  private _lastTurnOccupancy = 0;

  private _getNextSteer?: () => Promise<{ text: string; attachments?: Attachment[] } | null>;
  private _textOnly = false;
  private _trustRepoConfig = false;
  /** Registry MCP servers for the main session (never textOnly). Built once per start. */
  private _mcp: ReturnType<typeof toClaudeSdkMcp> | undefined;
  /** Spawn-time MCP server configs. Spawn-time servers are unremovable via SDK setMcpServers. */
  private _mcpSpawn: Record<string, ClaudeMcpConfig> = {};
  private _disableNativeMcp = false;
  private _disabledNativeMcp: string[] = [];

  // Live input queue for mid-turn steering. _pushInput resolves the generator's
  // pending pull; _CLOSE makes the generator return so the SDK for-await exits.
  private readonly _CLOSE = Symbol('close-input');
  private _inputBuffer: unknown[] = [];
  private _inputResolvers: ((msg: unknown) => void)[] = [];
  private _turnClosing = false;

  private _helpers = new Map<string, HelperEvent['payload']>();
  private _helperEmitAt = new Map<string, number>();
  private _bgLevel = new Set<string>();

  streamEvents(): EventEmitter {
    return this._emitter;
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._conversationId = config.conversationId;
    this._cwd = config.cwd ?? '';
    this._resumeNativeSessionId = safeNativeSessionId(config.nativeSessionId) ?? '';
    this._seq = 0;
    this._fiveHourPct = undefined;
    this._fiveHourResetsAt = undefined;
    this._sevenDayPct = undefined;
    this._sevenDayResetsAt = undefined;
    this._model = '';
    this._effort = config.effort;
    this._contextWindowSize = undefined;
    this._lastTurnOccupancy = 0;
    this._abortController = new AbortController();
    this._getNextSteer = config.getNextSteer;
    this._textOnly = config.textOnly === true;
    this._trustRepoConfig = config.trustRepoConfig === true;
    this._disableNativeMcp = config.disableNativeMcp === true;
    this._disabledNativeMcp = config.disabledNativeMcp ?? [];
    this._mcp = !this._textOnly && config.mcpServers?.length ? toClaudeSdkMcp(config.mcpServers) : undefined;
    this._mcpSpawn = this._mcp?.mcpServers ? { ...this._mcp.mcpServers } : {};
    this._helpers.clear();
    this._helperEmitAt.clear();
    this._bgLevel.clear();
  }

  async sendPrompt(text: string, attachments: Attachment[] = [], model?: string, effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    this._model = model ?? this._model;
    this._effort = effort ?? this._effort;
    this._lastTurnOccupancy = 0;
    this._turnProducedContent = false;
    this._silentSuccessAck = silentSuccessAckFor(text);
    await this._resolveContextWindowSize(this._model);
    // restricted / safeMode are passed to the SDK through `extraArgs` (--restricted / --safe-mode),
    // so they no longer force the CLI fallback.
    this._sdkInitError = '';
    const useSdk = await this._trySdk(text, attachments, model, options);
    if (!useSdk) {
      // The CLI fallback cannot gate tool permissions (no canUseTool / AskUserQuestion card), so it is
      // only safe for bypass conversations and tool-less (textOnly) sessions.
      if (this._interactionMode !== 'bypass' && !this._textOnly) {
        const cause = this._sdkInitError ? ` (SDK error: ${this._sdkInitError})` : '';
        this._emit({
          type: 'error',
          payload: {
            message: `Claude SDK could not start and the CLI fallback is disabled while interaction mode is "${this._interactionMode}"${cause}.`,
            detail: 'The CLI fallback cannot ask for tool permissions, so it only runs in bypass mode. Fix the Claude Code install, or switch the conversation to bypass interaction mode.',
          },
        });
        this._emit({ type: 'status', payload: { status: 'error' } });
        this._emitter.emit('end');
        return;
      }
      await this._subprocessFallback(text, model, options);
    }
  }

  /** Resolve the active model's context-window size from listModels() once per
   *  turn, so the result handler can convert raw token usage into a percentage.
   *  Best-effort: leaves _contextWindowSize undefined on any failure. */
  private async _resolveContextWindowSize(model: string): Promise<void> {
    try {
      const models = await this.listModels();
      this._contextWindowSize = adapterContextWindow('claude-code', models.length ? models : this._seedModels(), model);
    } catch {
      this._contextWindowSize = adapterContextWindow('claude-code', [], model);
    }
  }

  private _seedModels(): ModelDescriptor[] {
    return readProfiles()
      .filter((p) => p.agentType === 'claude-code')
      .map((p) => ({
        name: p.model,
        label: p.label,
        provider: p.provider,
        vision: p.vision,
        steer: p.steer,
        contextWindow: p.contextWindow,
      }));
  }

  private async _pullInput(): Promise<unknown> {
    if (this._getNextSteer) {
      const nextSteer = await this._getNextSteer();
      if (nextSteer === null) {
        return this._CLOSE;
      }
      const content: AnthropicContentBlock[] = [{ type: 'text', text: nextSteer.text }];
      for (const att of nextSteer.attachments ?? []) {
        content.push(...attachmentToContentBlocks(att));
      }
      // New user turn inbound — reset empty-output tracking so the next
      // result handler judges THIS turn on its own merits.
      this._turnProducedContent = false;
      this._silentSuccessAck = silentSuccessAckFor(nextSteer.text);
      return {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
      };
    }

    if (this._inputBuffer.length > 0) return this._inputBuffer.shift();
    return new Promise((resolve) => this._inputResolvers.push(resolve));
  }

  private _pushInput(msg: unknown): void {
    const resolve = this._inputResolvers.shift();
    if (resolve) {
      // Buffered message resolved into a new SDK turn — reset empty-output
      // tracking so the next result judges this turn on its own merits.
      this._turnProducedContent = false;
      resolve(msg);
    } else {
      this._inputBuffer.push(msg);
    }
  }

  async steer(text: string, attachments: Attachment[] = []): Promise<void> {
    if (this._turnClosing) throw new Error('turn is ending; cannot steer');
    this._silentSuccessAck = silentSuccessAckFor(text);
    const content: AnthropicContentBlock[] = [{ type: 'text', text }];
    for (const att of attachments) {
      content.push(...attachmentToContentBlocks(att));
    }
    this._pushInput({
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
    });
  }

  private _emit(event: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    const full: NormalisedEvent = {
      ...event,
      sessionId: this._sessionId,
      seq: ++this._seq,
      ts: Date.now(),
    } as NormalisedEvent;
    this._emitter.emit('event', full);
  }

  private async _trySdk(text: string, attachments: Attachment[], model?: string, options?: PromptOptions): Promise<boolean> {
    if (!this._abortController) return false;

    try {
      // Build user message content
      const content: AnthropicContentBlock[] = [{ type: 'text', text }];

      for (const att of attachments) {
        content.push(...attachmentToContentBlocks(att));
      }

      const userMessage = {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content,
        },
        parent_tool_use_id: null,
      };

      // Long-lived input stream: yields the opening message, then any messages
      // pushed via steer(), until _pushInput(_CLOSE) signals end-of-turn.
      this._inputBuffer = [];
      this._inputResolvers = [];
      this._turnClosing = false;
      const pull = () => this._pullInput();
      const CLOSE = this._CLOSE;
      async function* promptStream() {
        yield userMessage;
        while (true) {
          const next = await pull();
          if (next === CLOSE) return;
          yield next as typeof userMessage;
        }
      }

      const rlDir = join(runDir(), 'rl');
      try {
        mkdirSync(rlDir, { recursive: true, mode: 0o700 });
        chmodSync(rlDir, 0o700);
      } catch {
        // best-effort directory setup
      }
      const slFile = join(rlDir, `${this._conversationId}.json`);
      const escapedSlFile = slFile.replace(/'/g, `'\\''`);
      const managedSettings: Settings = {
        statusLine: {
          type: 'command',
          command: `cat > '${escapedSlFile}' 2>/dev/null || true`,
          refreshInterval: 30,
        },
      };
      const activeEffort = clampEffort('claude-code', this._effort);
      const perm = buildClaudeCodeSdkPermissionOptions(this._interactionMode, options);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = this._queryFn({
        prompt: promptStream() as any,
        options: {
          model,
          cwd: this._cwd || undefined,
          // 'bypass': skip all permission gates; otherwise use 'default' with canUseTool
          // so we can auto-allow tools in 'questions' mode and show cards in 'prompt' mode,
          // while routing AskUserQuestion through our own question card in both.
          // A per-turn permissionMode override / restricted turn in a bypass conversation also
          // attaches canUseTool (prompt behaviour) so gated tools show cards, not silent denials.
          // permissionMode is set after the prompt-option overrides spread below (restricted never runs as bypass).
          ...(perm.attachCanUseTool
            ? { canUseTool: (n: string, i: Record<string, unknown>, o: { suggestions?: unknown }) => this._canUseTool(n, i, o) }
            : {}),
          includePartialMessages: true,
          ...(this._textOnly ? {} : { perTaskStopAffordance: true, agentProgressSummaries: true }),
          // Registry MCP: additive (no strictMcpConfig). The SDK puts mcpServers on argv as
          // --mcp-config, so secrets travel as ${TIERWYN_MCPV_n} placeholders expanded by the
          // CLI from this child env (V1).
          env: buildChildEnv(this._mcp?.env, undefined, 'claude-code'),
          ...(this._mcp ? { mcpServers: this._mcp.mcpServers } : {}),
          abortController: this._abortController ?? undefined,
          ...(this._resumeNativeSessionId ? { resume: this._resumeNativeSessionId } : {}),
          managedSettings,
          ...(activeEffort ? { effort: activeEffort } : {}),
          ...buildClaudeCodeSdkOptionOverrides(options),
          permissionMode: perm.permissionMode,
          ...(perm.extraArgs ? { extraArgs: perm.extraArgs } : {}),
          ...(this._disableNativeMcp ? { strictMcpConfig: true } : {}),
          ...this._sdkSpawnProcessOpt(),
          ...claudeExecutableOpt(),
          settingSources: this._textOnly ? [] : (this._trustRepoConfig ? undefined : ['user']),
          ...(this._textOnly
            ? {
                allowedTools: [],
                tools: [],
                maxTurns: 1,
                strictMcpConfig: true,
                mcpServers: {},
                systemPrompt:
                  'You are a conversation summarizer. Output only the summary text. Never use tools or read files.',
              }
            : {}),
        },
      });

      this._query = result;
      if (!this._disableNativeMcp && this._disabledNativeMcp?.length) {
        for (const name of this._disabledNativeMcp) {
          try {
            await result.toggleMcpServer(name, false);
          } catch {
            // Native server might not be present in CLI config; ignore
          }
        }
      }
      for await (const msg of result) {
        // At turn end, pull live plan rate-limit utilisation before the result
        // status (which reads _fiveHourPct/_sevenDayPct) is emitted.
        if ((msg as { type?: string }).type === 'result') await this._refreshRateLimitsFromSdk();
        this._handleSdkMessage(msg as unknown as Record<string, unknown>);
      }
      this._query = undefined;

      // The SDK for-await loop exits when promptStream() returns (queue closed).
      this._closeHelpers();
      this._emitter.emit('end');
      return true;
    } catch (err) {
      // SDK init failure — return false to trigger subprocess fallback
      const isInitFailure =
        err instanceof Error &&
        (err.message.includes('not found') ||
          err.message.includes('ENOENT') ||
          err.message.includes('Cannot find') ||
          err.message.includes('spawn'));
      if (isInitFailure) {
        this._sdkInitError = err instanceof Error ? err.message : String(err);
        return false;
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Intentional stop (operator Stop / session teardown) or an abort-shaped
      // error: the turn was cut short on purpose — close quietly instead of
      // raising a false red error. Quota-shaped failures still surface.
      if (this._abortController?.signal.aborted || isBenignInterruptMessage(msg)) {
        if (!this._abortController?.signal.aborted) {
          this._emit({ type: 'status', payload: { status: 'done' } });
        }
        this._closeHelpers();
        this._emitter.emit('end');
        return true;
      }
      // Other errors: surface as error event
      this._emit({ type: 'error', payload: { message: msg } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._closeHelpers();
      this._emitter.emit('end');
      return true;
    }
  }

  /** Pull current plan rate-limit utilisation straight from the SDK's /usage
   *  control request — the same data the TUI statusline shows, but with zero
   *  statusline config and no extra model tokens. This is the only reliable
   *  per-turn allowance source: rate_limit_event fires only when limits change,
   *  so it stays null on most turns.
   *  ponytail: experimental SDK API (usage_EXPERIMENTAL...); on failure the
   *  rate_limit_event handler and ~/.claude/rate-limits.json fallback still apply. */
  private async _refreshRateLimitsFromSdk(): Promise<void> {
    const q = this._query;
    if (!q) return;
    try {
      const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      if (!u?.rate_limits_available || !u.rate_limits) return;
      const fh = u.rate_limits.five_hour;
      const sd = u.rate_limits.seven_day;
      // utilization is already a 0-100 percentage (unlike rate_limit_event's 0-1).
      if (fh?.utilization != null) this._fiveHourPct = fh.utilization;
      if (fh?.resets_at) this._fiveHourResetsAt = Date.parse(fh.resets_at);
      if (sd?.utilization != null) this._sevenDayPct = sd.utilization;
      if (sd?.resets_at) this._sevenDayResetsAt = Date.parse(sd.resets_at);
    } catch { /* keep last-known values; rate_limit_event + file fallback remain */ }
  }

  private _handleSdkMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    // Non-null on every message a native subagent (Task tool) produces; equals
    // the Task tool_call's id. Stamped onto subagent output so the UI can group
    // it, and used below to keep subagent usage out of the main context %.
    const parentToolUseId = (msg.parent_tool_use_id as string) || undefined;

    if (type === 'system') {
      const subtype = msg.subtype as string;

      if (subtype === 'init') {
        this._nativeSessionId = safeNativeSessionId(msg.session_id) ?? '';
        this._streamingContent = false;
        this._emit({ type: 'status', payload: { status: 'running' } });
        return;
      }

      if (subtype === 'files_persisted') {
        const files = (msg.files as { filename: string }[]) ?? [];
        for (const f of files) {
          this._emit({
            type: 'file_change',
            payload: { path: f.filename, kind: 'modified' },
          });
        }
        return;
      }
      if (this._handleTaskMessage(subtype, msg)) return;
      return;
    }

    if (type === 'assistant') {
      const message = msg.message as { content: unknown[]; usage?: Record<string, unknown> };
      if (!Array.isArray(message?.content)) return;

      // Per-turn occupancy = input + cache_read + cache_creation on the most
      // recent assistant message. modelUsage on `result` aggregates across the
      // whole session; this per-message usage is what's actually loaded into
      // the next request's context window.
      // ponytail: skip subagent messages — their context is separate and would
      // otherwise clobber the main agent's context-window % for the turn.
      if (message.usage && !parentToolUseId) {
        const u = message.usage;
        this._lastTurnOccupancy = contextWindowOccupancy({
          inputTokens: (u.input_tokens ?? u.inputTokens) as number | undefined,
          cacheReadTokens: (u.cache_read_input_tokens ?? u.cacheReadInputTokens) as number | undefined,
          cacheCreationTokens: (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens) as number | undefined,
        });
      }

      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text') {
          this._turnProducedContent = true;
          if (this._streamingContent) {
            // Streaming chunks already delivered this text — emit a terminal marker to
            // close the stream in the UI merger without repeating the content.
            this._emit({ type: 'message', payload: { chunk: '', final: true } });
            this._streamingContent = false;
          } else {
            // No streaming occurred for this turn — emit the full text now.
            this._emit({
              type: 'message',
              payload: { chunk: b.text as string, final: true, ...(parentToolUseId ? { parentToolUseId } : {}) },
            });
          }
        } else if (b.type === 'tool_use') {
          const toolName = b.name as string;
          const toolInput = (b.input as Record<string, unknown>) ?? {};

          if (toolName === 'AskUserQuestion') {
            // Question card rendered by canUseTool before this point; suppress tool_call event.
            // Still counts as the turn producing content — the question IS the agent's reply.
            this._turnProducedContent = true;
            continue;
          }

          this._turnProducedContent = true;
          this._emit({
            type: 'tool_call',
            payload: {
              toolUseId: b.id as string,
              name: toolName,
              input: toolInput,
              ...(parentToolUseId ? { parentToolUseId } : {}),
            },
          });

          // Detect file changes from tool call input
          if (FILE_TOOLS.has(toolName)) {
            const filePath = (toolInput.path ?? toolInput.file_path ?? toolInput.target_file) as string | undefined;
            if (filePath) {
              const command = toolInput.command as string | undefined;
              const kind = command === 'create' ? 'created' : 'modified';
              this._emit({
                type: 'file_change',
                payload: {
                  path: filePath,
                  kind,
                  toolUseId: b.id as string | undefined,
                },
              });
            }
          }
        }
      }
      return;
    }

    if (type === 'stream_event') {
      // Partial streaming — extract text delta if present
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return;
      const eventType = event.type as string;
      if (eventType === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          this._streamingContent = true;
          this._turnProducedContent = true;
          this._emit({
            type: 'message',
            payload: { chunk: delta.text as string, final: false, ...(parentToolUseId ? { parentToolUseId } : {}) },
          });
        }
      }
      return;
    }

    if (type === 'user') {
      // Tool results arrive as user messages with tool_result content
      const message = msg.message as { content: unknown[] };
      if (!Array.isArray(message?.content)) return;

      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result') {
          const content = Array.isArray(b.content)
            ? (b.content as { text?: string }[]).map(c => c.text ?? '').join('')
            : String(b.content ?? '');
          this._emit({
            type: 'tool_result',
            payload: {
              toolUseId: b.tool_use_id as string,
              content,
              isError: (b.is_error as boolean) ?? false,
              ...(parentToolUseId ? { parentToolUseId } : {}),
            },
          });
        }
      }
      return;
    }

    if (type === 'rate_limit_event') {
      const info = msg.rate_limit_info as Record<string, unknown> | undefined;
      const limitType = info?.rateLimitType as string | undefined;
      const utilization = info?.utilization as number | undefined;
      const resetsAt = info?.resetsAt as number | undefined;
      if (limitType === 'five_hour') {
        this._fiveHourPct = utilization !== undefined ? utilization * 100 : 0;
        if (resetsAt !== undefined) this._fiveHourResetsAt = resetsAt * 1000; // to ms
      } else if (limitType === 'seven_day') {
        this._sevenDayPct = utilization !== undefined ? utilization * 100 : 0;
        if (resetsAt !== undefined) this._sevenDayResetsAt = resetsAt * 1000;
      }
      return;
    }

    if (type === 'result') {
      const isError = msg.is_error as boolean;
      const usage = msg.usage as Record<string, unknown> | undefined;
      const inputTokens = (usage?.inputTokens ?? usage?.input_tokens) as number | undefined;
      const outputTokens = (usage?.outputTokens ?? usage?.output_tokens) as number | undefined;
      const cacheReadTokens = (usage?.cacheReadInputTokens ?? usage?.cache_read_input_tokens) as number | undefined;
      const cacheCreationTokens = (usage?.cacheCreationInputTokens ?? usage?.cache_creation_input_tokens) as number | undefined;
      const costUsd = (msg.total_cost_usd ?? msg.totalCostUsd) as number | undefined;
      // Context-window % from per-turn occupancy (input + cache_read +
      // cache_creation) divided by the active model's window size. Both inputs
      // come from THIS turn's assistant message; we no longer rely on the
      // statusLine file (which the headless SDK never writes) or on the
      // `result` usage object (which aggregates across the whole session and
      // produces unbounded percentages). Undefined when the window size is
      // unknown or occupancy is zero — never fabricate a number.
      const contextWindowPct = computeContextWindowPct(this._lastTurnOccupancy, this._contextWindowSize);
      const fiveHourPct = this._fiveHourPct;
      const fiveHourResetsAt = this._fiveHourResetsAt;
      const sevenDayPct = this._sevenDayPct;
      const sevenDayResetsAt = this._sevenDayResetsAt;
      if (isError) {
        const errors = (msg.errors as string[]) ?? [];
        // "Turn interrupted" style results from an intentional stop are not
        // failures — close the turn quietly as done (usage fields intact so
        // terminal usage still persists). Quota-shaped errors still surface.
        if (errors.length > 0 && errors.every(isBenignInterruptMessage)) {
          this._emit({ type: 'status', payload: { status: 'done', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt } });
          return;
        }
        this._emit({
          type: 'error',
          payload: { message: errors.join('; ') || 'Unknown error' },
        });
        this._emit({ type: 'status', payload: { status: 'error', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt } });
      } else if (!this._turnProducedContent && !(outputTokens && outputTokens > 0)) {
        if (this._silentSuccessAck) {
          // Builtin commands like /compact succeed without assistant output.
          this._emit({ type: 'message', payload: { chunk: this._silentSuccessAck, final: true } });
          this._emit({ type: 'status', payload: { status: 'done', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt } });
        } else {
          // Empty reply: the SDK returned a result with no assistant text and no
          // tool calls. Most common with unknown slash commands — the CLI emits a
          // local-command-caveat + "Unknown skill: X" then ends the turn with
          // zero tokens. Without this branch the UI showed status:done with no
          // message, which reads as a silent send failure. Surface a clear error.
          this._emit({
            type: 'error',
            payload: {
              message: 'Agent produced no reply for this turn.',
              detail: 'The agent returned no tokens and no tool calls. If you typed a slash command, the skill may not be installed in this agent home.',
            },
          });
          this._emit({ type: 'status', payload: { status: 'error', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt } });
        }
      } else {
        this._emit({ type: 'status', payload: { status: 'done', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt } });
      }
      // Close the generator only if no steer message is already buffered.
      // If a message is buffered, the SDK will pull it next and we'll get
      // another result — at which point the buffer will be empty and we close.
      if (this._inputBuffer.length === 0) {
        this._turnClosing = true;
        this._pushInput(this._CLOSE);
      }
    }
  }

  private _isHelperTask(msg: Record<string, unknown>): boolean {
    if (msg.ambient === true || msg.skip_transcript === true) return false;
    const sub = msg.subagent_type;
    if (sub === 'main-session') return false;
    return msg.task_type === 'local_agent' || typeof sub === 'string';
  }

  private _mapHelperUsage(raw: unknown): HelperEvent['payload']['usage'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const u = raw as Record<string, unknown>;
    return {
      totalTokens: Number(u.total_tokens ?? 0),
      toolUses: Number(u.tool_uses ?? 0),
      durationMs: Number(u.duration_ms ?? 0),
    };
  }

  private _emitHelper(id: string): void {
    const payload = this._helpers.get(id);
    if (!payload) return;
    this._emit({ type: 'helper', payload: { ...payload } });
  }

  private _closeHelpers(): void {
    for (const [id, payload] of this._helpers) {
      if (payload.status !== 'running') continue;
      payload.status = 'stopped';
      this._emitHelper(id);
    }
  }

  private _handleTaskMessage(subtype: string, msg: Record<string, unknown>): boolean {
    if (subtype === 'task_started') {
      if (!this._isHelperTask(msg)) return true;
      const id = typeof msg.task_id === 'string' ? msg.task_id : '';
      if (!id) return true;
      const sub = typeof msg.subagent_type === 'string' ? msg.subagent_type : '';
      this._helpers.set(id, {
        taskId: id,
        ...(typeof msg.tool_use_id === 'string' ? { toolUseId: msg.tool_use_id } : {}),
        ...(typeof msg.parent_task_id === 'string' ? { parentTaskId: msg.parent_task_id } : {}),
        label: sub || 'helper',
        description: typeof msg.description === 'string' ? msg.description : '',
        status: 'running',
        startedAt: Date.now(),
        ...(msg.is_backgrounded === true ? { background: true } : {}),
      });
      this._emitHelper(id);
      return true;
    }
    if (subtype === 'task_progress') {
      const id = typeof msg.task_id === 'string' ? msg.task_id : '';
      const cur = this._helpers.get(id);
      if (!cur) return true;
      const usage = this._mapHelperUsage(msg.usage);
      if (usage) cur.usage = usage;
      if (typeof msg.last_tool_name === 'string') cur.lastToolName = msg.last_tool_name;
      if (typeof msg.summary === 'string') cur.summary = msg.summary;
      const now = Date.now();
      const last = this._helperEmitAt.get(id);
      if (last === undefined || now - last >= 15_000) {
        this._helperEmitAt.set(id, now);
        this._emitHelper(id);
      }
      return true;
    }
    if (subtype === 'task_updated') {
      const id = typeof msg.task_id === 'string' ? msg.task_id : '';
      const cur = this._helpers.get(id);
      if (!cur) return true;
      const patch = (msg.patch && typeof msg.patch === 'object') ? msg.patch as Record<string, unknown> : {};
      let changed = false;
      const st = patch.status;
      if (st === 'completed' || st === 'failed' || st === 'killed') {
        const mapped = st === 'killed' ? 'stopped' as const : st;
        if (cur.status !== mapped) {
          cur.status = mapped;
          changed = true;
        }
      }
      if (patch.is_backgrounded === true && cur.background !== true) {
        cur.background = true;
        changed = true;
      }
      if (changed) this._emitHelper(id);
      return true;
    }
    if (subtype === 'task_notification') {
      const id = typeof msg.task_id === 'string' ? msg.task_id : '';
      const cur = this._helpers.get(id);
      if (!cur) return true;
      const st = msg.status;
      if (st === 'completed' || st === 'failed' || st === 'stopped') cur.status = st;
      if (typeof msg.summary === 'string') cur.summary = msg.summary;
      const usage = this._mapHelperUsage(msg.usage);
      if (usage) cur.usage = usage;
      this._emitHelper(id);
      return true;
    }
    if (subtype === 'background_tasks_changed') {
      const tasks = Array.isArray(msg.tasks) ? msg.tasks as Record<string, unknown>[] : [];
      const next = new Set<string>();
      for (const t of tasks) {
        if (!this._isHelperTask(t)) continue;
        const id = typeof t.task_id === 'string' ? t.task_id : '';
        if (!id) continue;
        next.add(id);
        if (!this._helpers.has(id)) {
          const sub = typeof t.subagent_type === 'string' ? t.subagent_type : '';
          this._helpers.set(id, {
            taskId: id,
            ...(typeof t.parent_task_id === 'string' ? { parentTaskId: t.parent_task_id } : {}),
            label: sub || 'helper',
            description: typeof t.description === 'string' ? t.description : '',
            status: 'running',
            startedAt: Date.now(),
          });
          this._emitHelper(id);
        }
      }
      for (const id of this._bgLevel) {
        if (next.has(id)) continue;
        const cur = this._helpers.get(id);
        if (cur?.status === 'running') {
          cur.status = 'completed';
          this._emitHelper(id);
        }
      }
      this._bgLevel = next;
      return true;
    }
    return false;
  }

  async stopHelper(taskId: string): Promise<void> {
    if (!this._query || this._textOnly) throw new Error('no_live_query');
    await this._query.stopTask(taskId);
  }

  private async _subprocessFallback(text: string, model?: string, options?: PromptOptions): Promise<void> {
    this._emit({ type: 'status', payload: { status: 'running' } });

    const activeEffort = clampEffort('claude-code', this._effort);
    const args = buildClaudeCliArgs({
      interactionMode: this._interactionMode,
      textOnly: this._textOnly,
      ...(model ? { model } : {}),
      ...(activeEffort ? { effort: activeEffort } : {}),
      options,
      ...(this._resumeNativeSessionId ? { resumeSessionId: this._resumeNativeSessionId } : {}),
      trustRepoConfig: this._trustRepoConfig,
    });

    // detached:true → own process group so tool-spawned binaries that killpg
    // (e.g. grok) cannot SIGKILL the Tierwyn parent. Mirror opencode.
    // Scrub PORT/HOST/secrets/plugin keys so MCP children cannot steal the listen
    // port or inherit server-held credentials.
    if (this._disableNativeMcp) args.push('--strict-mcp-config');
    if (this._mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: this._mcp.mcpServers }));
    const child = this._spawn('claude', args, {
      cwd: this._cwd || undefined,
      env: buildChildEnv(this._mcp?.env, undefined, 'claude-code'),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    this._subprocess = child;

    if (!child.stdin) {
      this._emit({ type: 'error', payload: { message: 'claude subprocess has no stdin' } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      return;
    }

    child.stdin.on('error', () => {}); // async EPIPE must not crash the server
    child.stdin.write(text);
    child.stdin.end();

    // Drain stderr (an unread pipe can fill and stall the child) and keep the tail so a non-zero
    // exit reports the real reason instead of just "exited with code N".
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
    child.stderr?.on('error', () => {});

    const rl = createInterface({ input: child.stdout! });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this._handleSdkMessage(msg);
      } catch { /* ignore non-JSON lines */ }
    });

    return new Promise((resolve) => {
      // SIGTERM/SIGKILL from stopSession aborts the controller — child errors
      // after that are stop consequences, not failures (exit codes 130/143).
      const stopped = (): boolean => this._abortController?.signal.aborted === true;
      child.on('error', (err) => {
        if (stopped() || isBenignInterruptMessage(err.message)) return resolve();
        this._emit({ type: 'error', payload: { message: err.message } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        this._emitter.emit('end');
        resolve();
      });

      child.on('close', (code) => {
        const msg = code !== null ? `claude exited with code ${code}` : 'claude subprocess closed';
        if (code !== 0 && code !== null && !stopped() && !isBenignInterruptMessage(msg)) {
          const tail = lastStderrLine(stderrTail);
          this._emit({
            type: 'error',
            payload: { message: tail ? `${msg}: ${tail}` : msg },
          });
          this._emit({ type: 'status', payload: { status: 'error' } });
        }
        this._emitter.emit('end');
        resolve();
      });
    });
  }

  private _canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    _opts: { suggestions?: unknown },
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    // AskUserQuestion: show a question card and block until the operator answers.
    // The answer is delivered back to the CLI via updatedInput.answers so it builds
    // the correct tool_result ("Your questions have been answered: ...").
    if (toolName === 'AskUserQuestion') {
      const requestId = randomUUID();
      const rawQuestions = (input.questions as Record<string, unknown>[]) ?? [];
      const mapped = rawQuestions.map((q) => {
        const qText = String(q.question ?? '');
        const qOptions = (q.options as { label: string; description?: string }[]) ?? [];
        return {
          id: qText,
          prompt: qText,
          header: q.header ? String(q.header) : undefined,
          choices: qOptions.map((o) => ({ id: o.label, label: o.label, description: o.description })),
          multiSelect: Boolean(q.multiSelect),
          allowFreeText: false,
        };
      });
      const firstQ = mapped[0];
      const hasMultiple = mapped.length > 1;
      this._pendingInputs.set(requestId, input);
      this._emit({
        type: 'interaction_request',
        payload: {
          requestId,
          kind: 'question',
          prompt: hasMultiple
            ? `The agent has ${mapped.length} questions`
            : String(firstQ?.prompt ?? 'The agent has a question'),
          multiSelect: firstQ ? Boolean(firstQ.multiSelect) : false,
          choices: firstQ ? firstQ.choices : [],
          questions: mapped,
          allowFreeText: true,
          toolName: 'AskUserQuestion',
        },
      });
      this._emit({ type: 'status', payload: { status: 'waiting' } });
      return new Promise((resolve) => this._pendingAskUserQuestions.set(requestId, resolve));
    }

    // In 'questions' mode auto-approve all other tool gates; only AskUserQuestion is surfaced above.
    if (this._interactionMode === 'questions') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    // In 'prompt' mode show a permission card for every other tool.
    const requestId = randomUUID();
    this._pendingInputs.set(requestId, input);
    const isPlan = toolName === 'ExitPlanMode';
    this._emit({
      type: 'interaction_request',
      payload: {
        requestId,
        kind: 'permission',
        prompt: isPlan ? 'Approve the proposed plan?' : `Allow ${toolName}?`,
        choices: [
          { id: 'allow', label: isPlan ? 'Approve' : 'Allow' },
          { id: 'deny', label: isPlan ? 'Keep planning' : 'Deny' },
        ],
        toolName,
        toolInput: input,
        allowFreeText: true,
      },
    });
    this._emit({ type: 'status', payload: { status: 'waiting' } });
    return new Promise((resolve) => this._pendingInteractions.set(requestId, resolve));
  }

  respondToInteraction(requestId: string, response: { selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[] }): void {
    // AskUserQuestion answer: resolve the canUseTool promise with answers in updatedInput
    const askResolve = this._pendingAskUserQuestions.get(requestId);
    if (askResolve) {
      this._pendingAskUserQuestions.delete(requestId);
      const input = this._pendingInputs.get(requestId) ?? {};
      this._pendingInputs.delete(requestId);
      const rawQuestions = (input.questions as Record<string, unknown>[]) ?? [];
      const answersMap: Record<string, string> = {};

      if (response.answers && response.answers.length > 0) {
        // Multi-question path — answers[] aligns positionally with rawQuestions[].
        rawQuestions.forEach((q, i) => {
          const qText = String(q.question ?? '');
          const ans = response.answers![i];
          if (!ans) return;
          const joined = ans.text ?? (ans.selection.length > 1 ? ans.selection.join('; ') : ans.selection[0] ?? '');
          if (qText && joined !== undefined) answersMap[qText] = joined;
        });
      } else {
        // Single-question back-compat path.
        const firstQ = (rawQuestions[0] ?? {}) as Record<string, unknown>;
        const questionText = String(firstQ.question ?? '');
        const answer = response.text?.trim() ? response.text : (response.selection[0] ?? '');
        if (questionText) answersMap[questionText] = answer;
      }

      this._emit({
        type: 'interaction_resolved',
        payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
      });
      this._emit({ type: 'status', payload: { status: 'running' } });
      askResolve({
        behavior: 'allow',
        updatedInput: { questions: rawQuestions, answers: answersMap, annotations: {} },
      });
      return;
    }
    const resolve = this._pendingInteractions.get(requestId);
    if (!resolve) return;
    this._pendingInteractions.delete(requestId);
    const input = this._pendingInputs.get(requestId) ?? {};
    this._pendingInputs.delete(requestId);
    const allowed = response.selection.includes('allow') || response.selection.includes('allow_always');
    this._emit({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
    });
    this._emit({ type: 'status', payload: { status: 'running' } });
    if (allowed) resolve({ behavior: 'allow', updatedInput: input });
    else resolve({ behavior: 'deny', message: response.text ?? 'Denied by operator' });
  }

  private _resolvePendingInteractions(resolution: 'auto' | 'expired'): void {
    for (const [requestId, resolve] of this._pendingInteractions) {
      this._emit({
        type: 'interaction_resolved',
        payload: { requestId, selection: ['deny'], resolution },
      });
      resolve({ behavior: 'deny', message: 'Session ended before the operator answered' });
    }
    this._pendingInteractions.clear();
    for (const [requestId, resolve] of this._pendingAskUserQuestions) {
      this._emit({ type: 'interaction_resolved', payload: { requestId, selection: [], resolution } });
      resolve({ behavior: 'allow', updatedInput: { questions: [], answers: {}, annotations: {} } });
    }
    this._pendingAskUserQuestions.clear();
    this._pendingInputs.clear();
  }

  /** Live MCP status from the SDK query. `source: 'tierwyn'` iff Tierwyn injected it. */
  async mcpStatus(): Promise<McpLiveStatus[]> {
    const q = this._query;
    if (!q) throw new Error('no_live_query');
    const injected = new Set(Object.keys(this._mcp?.mcpServers ?? {}));
    // Only name/status/count leave the adapter — `config` can carry URLs/headers.
    return (await q.mcpServerStatus()).map((st) => ({
      name: st.name,
      status: st.status,
      source: injected.has(st.name) ? 'tierwyn' as const : 'native' as const,
      ...(st.tools ? { toolCount: st.tools.length } : {}),
    }));
  }

  /** Session-scoped toggle / reconnect (not persisted). */
  async mcpControl(name: string, action: McpControlAction): Promise<void> {
    const q = this._query;
    if (!q) throw new Error('no_live_query');
    if (action === 'reconnect') await q.reconnectMcpServer(name);
    else await q.toggleMcpServer(name, action === 'enable');
  }

  async setPermissionMode(mode: InteractionMode): Promise<void> {
    this._interactionMode = mode;
    // Live query switch (SDK 0.3.280 Query.setPermissionMode). Baseline mapping
    // mirrors buildClaudeCodeSdkPermissionOptions: bypass → bypassPermissions,
    // non-bypass → 'default' (canUseTool stays attached from the start options).
    if (this._query && !this._textOnly) {
      await this._query.setPermissionMode(mode === 'bypass' ? 'bypassPermissions' : 'default');
    }
  }

  /** WP-2.4: live model switch (SDK Query.setModel) — avoids stop+respawn. */
  async setModelLive(model: string): Promise<void> {
    if (!this._query || this._textOnly) throw new Error('no_live_query');
    this._model = model;
    await this._query.setModel(model);
    try {
      await this._resolveContextWindowSize(this._model);
    } catch (err) {
      console.warn(`[claude-code] failed to resolve context window for live model ${model}:`, err);
    }
  }

  /** WP-2.4 / B1: live MCP set replacement (SDK Query.setMcpServers).
   *  Verified SDK 0.3.301 / CLI 2.1.301 semantics:
   *  1. Placeholders (${TIERWYN_MCPV_n}) do NOT expand over the control channel;
   *     re-sending any secret-bearing server corrupts it with literal placeholders.
   *  2. Spawn-time servers (--mcp-config) are outside the SDK dynamic scope and
   *     cannot be removed or altered via setMcpServers.
   *  Therefore, live applies only to pure additions of secret-free servers (and
   *  removals of previously live-added servers) with all spawn-time servers intact;
   *  everything else falls back to next-turn reap. */
  async setMcpServersLive(servers: ResolvedMcpServer[]): Promise<boolean> {
    if (!this._query || this._textOnly) return false;
    const next = toClaudeSdkMcp(servers);
    // B1: No secrets anywhere in the new set
    if (Object.keys(next.env).length > 0) return false;

    // B1: No spawn-time server removed or altered
    for (const [id, cfg] of Object.entries(this._mcpSpawn)) {
      const nextCfg = next.mcpServers[id];
      if (!nextCfg || JSON.stringify(nextCfg) !== JSON.stringify(cfg)) {
        return false;
      }
    }

    // I3: Race SDK call with a 5s timeout to avoid 30s hangs on connection stalls.
    // When the result settles, surface any errors via console.warn and an event.
    let timer: NodeJS.Timeout | undefined;
    const applyPromise = Promise.resolve(this._query.setMcpServers(next.mcpServers as Record<string, any>));

    applyPromise.then((result: any) => {
      if (timer) clearTimeout(timer);
      if (result?.errors && Object.keys(result.errors).length > 0) {
        const names = Object.keys(result.errors).join(', ');
        console.warn(`[claude-code] live MCP update errors for servers [${names}]:`, result.errors);
        this._emit({
          type: 'message',
          payload: { chunk: `\n[mcp] live MCP update: ${names} failed to connect\n` },
        });
      }
    }).catch((err) => {
      if (timer) clearTimeout(timer);
      console.warn('[claude-code] live MCP update rejected in background:', err);
    });

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 5000);
    });

    try {
      const winner = await Promise.race([applyPromise, timeoutPromise]);
      if (winner === 'timeout') {
        console.warn('[claude-code] setMcpServers timed out after 5s; returning true while CLI continues connecting');
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      console.warn('[claude-code] setMcpServers failed:', err);
      return false;
    }

    this._mcp = next;
    return true;
  }

  async stop(): Promise<void> {
    try {
      this._abortController?.abort();
      // Unblock the promptStream generator so the SDK for-await loop can exit.
      this._turnClosing = true;
      this._pushInput(this._CLOSE);
      const child = this._subprocess;
      termChildProcess(child, { group: true });
      escalateKill(child, { group: true });
      this._resolvePendingInteractions('auto');
      this._closeHelpers();
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._emit({ type: 'error', payload: { message: `stop() error: ${msg}` } });
    } finally {
      this._abortController = null;
      this._subprocess = null;
    }
    // Defensive: emit 'end' so sessionManager's once('end') cleanup fires
    // immediately. The subprocess close handler may emit again later — the
    // once listener makes the duplicate a no-op.
    this._emitter.emit('end');
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    throw new Error('listSessions not supported in Phase 1');
  }

  async loadSession(_id: string): Promise<void> {
    throw new Error('loadSession not supported in Phase 1');
  }

  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    const projectsDir = join(this._claudeHome, 'projects');
    for (let attempt = 0; attempt < 5; attempt++) {
      if (existsSync(projectsDir)) {
        for (const project of readdirSync(projectsDir)) {
          const file = join(projectsDir, project, `${nativeSessionId}.jsonl`);
          if (existsSync(file)) return true;
        }
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return false;
  }

  async rewindNativeSession(nativeSessionId: string, toTurn: number): Promise<string> {
    return forkClaudeJsonl(this._claudeHome, nativeSessionId, toTurn);
  }

  async exciseNativeTurn(nativeSessionId: string, turnToRemove: number): Promise<string> {
    // turnToRemove is 1-indexed over user turns (prompts + steers), matching
    // isRealUserPrompt counting. Throws on file-not-found, out-of-range, or a
    // single-turn file (the route maps the last case to a 400/409). The
    // original .jsonl is left on disk — this is a fork, not a mutation.
    return exciseTurnFromJsonl(this._claudeHome, nativeSessionId, turnToRemove);
  }

  async deleteNativeSession(nativeSessionId: string): Promise<void> {
    const located = locateJsonlFile(this._claudeHome, nativeSessionId);
    if (!located) return; // already gone / never persisted
    try {
      await fsp.unlink(located.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const seed = readProfiles().filter((p) => p.agentType === 'claude-code');
    let catalog = readClaudeModelCatalog(this._claudeHome);
    if (catalog.length === 0 && existsSync(join(this._claudeHome, '.credentials.json'))) {
      catalog = await this._probeSupportedModels();
    }
    if (catalog.length === 0) return []; // unknown → scheduler skips; seedCatalogue already applied the seed at boot
    const rows = applyModelSettings(catalog, readClaudeModelSettings(this._claudeHome, this._managedSettingsDir));
    const windows = new Map(seed.map((p) => [p.model, p.contextWindow]));
    return rows.map((m) => (windows.get(m.name) ? { ...m, contextWindow: windows.get(m.name) } : m));
  }

  /**
   * Cold-start fallback when the user just signed in via `claude auth login`
   * and `~/.claude/cache/model-catalog/` has not been written yet: init the
   * SDK without sending any prompt, call `supportedModels()`, and tear down.
   */
  private async _probeSupportedModels(): Promise<ModelDescriptor[]> {
    const ac = new AbortController();
    let q: ReturnType<typeof this._queryFn> | undefined;
    try {
      q = this._queryFn({
        prompt: (async function* () {
          await new Promise<void>(() => {});
        })(),
        options: {
          ...claudeExecutableOpt(),
          abortController: ac,
          cwd: '/tmp',
          maxTurns: 1,
          env: buildChildEnv(undefined, undefined, 'claude-code'),
        },
      });
      const sdkModels = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      // Prefer the disk cache if the SDK init populated it.
      const disk = readClaudeModelCatalog(this._claudeHome);
      if (disk.length > 0) return disk;
      if (!Array.isArray(sdkModels) || sdkModels.length === 0) return [];
      return sdkModels
        .filter((m) => m && typeof m.value === 'string' && m.value !== 'default')
        .map((m) => ({
          id: m.value,
          name: m.value,
          label: m.displayName || m.value,
          provider: 'anthropic',
        }));
    } catch {
      return [];
    } finally {
      ac.abort();
      try { q?.close(); } catch { /* ignore */ }
    }
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    const homeSkills = scanSkillDir(join(this._claudeHome, 'skills'));
    const pluginSkills = walkPluginSkillCache(join(this._claudeHome, 'plugins', 'cache'));
    const seen = new Set<string>();
    const out: CommandDescriptor[] = [];
    for (const cmd of [...homeSkills, ...pluginSkills]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push(cmd);
    }
    return out;
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/${name}`;
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix, [], undefined, undefined, options);
  }

  get nativeSessionId(): string {
    return this._nativeSessionId || this._resumeNativeSessionId;
  }

  /** Mid-turn context % from the latest assistant message usage this turn. */
  getLiveContextWindowUsage(): { contextWindowPct?: number; contextWindowSize?: number } {
    if (!this._contextWindowSize || this._lastTurnOccupancy <= 0) return {};
    const contextWindowPct = computeContextWindowPct(this._lastTurnOccupancy, this._contextWindowSize);
    return { contextWindowPct, contextWindowSize: this._contextWindowSize };
  }

  async oneShot(prompt: string, opts: OneShotOpts = {}): Promise<OneShotResult> {
    const mode: OneShotMode = opts.mode ?? 'none';
    if (opts.allowTools === true) {
      throw new Error('claude-code oneShot refuses allowTools=true');
    }
    if (!(this.oneShotModes ?? ['none']).includes(mode)) {
      throw new Error(`claude-code oneShot does not support mode ${mode}`);
    }
    const cwd = opts.cwd?.trim();
    if (mode === 'read_only' && (!cwd || !isAbsolute(cwd))) {
      throw new Error('claude-code oneShot read_only requires an absolute cwd');
    }
    const secs = opts.timeoutSecs ?? (mode === 'read_only' ? 120 : 60);
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, secs * 1000);

    const toolOpts = mode === 'read_only'
      ? {
          tools: [...READONLY_TOOLS],
          allowedTools: [
            `Read(${cwd}/**)`,
            `Glob(${cwd}/**)`,
            `Grep(${cwd}/**)`,
          ],
          disallowedTools: [...READONLY_DENY],
          permissionMode: 'default' as const,
          maxTurns: 8,
        }
      : { tools: [] as string[], allowedTools: [] as string[], maxTurns: 1 };

    try {
      const stream = this._queryFn({
        prompt,
        options: {
          ...(opts.model ? { model: opts.model } : {}),
          ...(cwd ? { cwd } : {}),
          abortController: ac,
          env: buildChildEnv(opts.env as NodeJS.ProcessEnv | undefined, undefined, 'claude-code'),
          ...toolOpts,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
          ...this._sdkSpawnProcessOpt(),
          ...claudeExecutableOpt(),
        },
      });
      let last: Record<string, unknown> | undefined;
      for await (const msg of stream) {
        const rec = msg as unknown as Record<string, unknown>;
        if (rec.type === 'result') last = rec;
      }
      if (!last) throw new Error('claude-code oneShot returned empty text');
      if (last.is_error) {
        const errors = last.errors as string[] | undefined;
        throw new Error(errors?.join('; ') || 'claude-code oneShot error');
      }
      const text = String(last.result ?? '').trim();
      if (!text) throw new Error('claude-code oneShot returned empty text');
      return { text, raw: last };
    } catch (err) {
      if (timedOut || ac.signal.aborted) {
        throw new Error(`claude-code oneShot timed out after ${secs}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
