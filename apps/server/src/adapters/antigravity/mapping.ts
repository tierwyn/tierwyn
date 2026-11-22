/**
 * Antigravity (agy) mapping layer.
 *
 * agy 1.1.8+ `--print --output-format stream-json` emits NDJSON events
 * (`init` / `step_update` / `result`). `mapAgyFrame` translates those into
 * NormalisedEvent partials. `mapAgyChunk` remains the plain-text fallback
 * (unit tests, and any agy that still prints prose).
 */

import type { ChangeKind, NormalisedEvent, StatusEvent } from '@tierwyn/shared';

export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

const FILE_WRITE_TOOLS: Record<string, ChangeKind> = {
  write_to_file: 'created',
  replace_file_content: 'modified',
  multi_replace_file_content: 'modified',
  sed_file: 'modified',
  notebook_edit: 'modified',
  delete_file: 'deleted',
  // agy 1.5 toolset (model-dependent; coexists with the names above).
  write_file: 'created',
  edit_file: 'modified',
};

function toolUseId(conversationId: string, stepIndex: number): string {
  return `agy:${conversationId}:${stepIndex}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function filePathFromParams(params: Record<string, unknown>): string | undefined {
  for (const key of ['TargetFile', 'Path', 'FilePath', 'AbsolutePath']) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function usageFrom(raw: unknown): Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number }> {
  const u = asRecord(raw);
  const out: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number }> = {};
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens;
  if (typeof u.cache_read_tokens === 'number') out.cacheReadTokens = u.cache_read_tokens;
  return out;
}

type StatusCause = NonNullable<StatusEvent['payload']['cause']>;

const AGY_STOP_REASON_CAUSE: Record<string, StatusCause> = {
  USER_CANCELLED: 'operator_interrupt',
  TURN_LIMIT: 'turn_limit',
  BUDGET_EXCEEDED: 'budget_exceeded',
};

/** Map agy `result.stop_reason` onto StatusEvent.payload.cause. Unknown / missing → omit. */
function causeFromStopReason(result: Record<string, unknown>): StatusCause | undefined {
  const raw = result.stop_reason;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return AGY_STOP_REASON_CAUSE[raw];
}

function formatDeniedAction(action: unknown): string {
  if (typeof action === 'string') return action;
  if (action && typeof action === 'object' && !Array.isArray(action)) {
    const rec = action as Record<string, unknown>;
    const name = [rec.tool, rec.name, rec.action].find((v): v is string => typeof v === 'string' && v.length > 0);
    const extra = [rec.command, rec.path, rec.CommandLine, rec.TargetFile].find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (name) return extra ? `${name}: ${extra}` : name;
    try { return JSON.stringify(action); } catch { return String(action); }
  }
  return String(action);
}

function deniedActionLabels(result: Record<string, unknown>): string[] {
  const raw = result.denied_actions;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map(formatDeniedAction).filter((s) => s.length > 0);
}

function denialErrorMessage(actions: string[]): string {
  return `Tool execution denied by safety policy: ${actions.join('; ')}`;
}

function mapToolStep(step: Record<string, unknown>): PartialEvent[] {
  const conversationId = String(step.conversation_id ?? '');
  const stepIndex = Number(step.step_index ?? 0);
  const id = toolUseId(conversationId, stepIndex);
  const info = asRecord(step.tool_info);
  const name = String(info.name ?? step.tool_name ?? 'tool');
  const input = asRecord(info.parameters);
  const state = String(step.state ?? '');
  const fileKind = FILE_WRITE_TOOLS[name];

  const events: PartialEvent[] = [];
  // File-mutating tools: defer tool_call until DONE. stream-json parameters are
  // often path-only on ACTIVE; enrichAgyMappedFileTools fills bodies from the
  // native DB on DONE so we emit one card with diffable input (not a thin ACTIVE
  // call plus a second enriched duplicate).
  if (!fileKind || state === 'DONE') {
    events.push({ type: 'tool_call', payload: { toolUseId: id, name, input } });
  }

  if (state === 'DONE') {
    const err = asRecord(info.error);
    const isError = Object.keys(err).length > 0;
    let content = isError
      ? humanizeAgyToolError(String(err.message ?? JSON.stringify(err)))
      : typeof info.output === 'string' ? info.output : info.output != null ? JSON.stringify(info.output) : '';
    if (!isError) {
      const path = fileKind ? filePathFromParams(input) : undefined;
      if (fileKind && path) {
        events.push({ type: 'file_change', payload: { path, kind: fileKind, toolUseId: id } });
        // agy leaves `output` empty on successful edits; say what happened.
        if (!content.trim()) content = `${fileKind[0].toUpperCase()}${fileKind.slice(1)} ${path}`;
      }
    }
    events.push({ type: 'tool_result', payload: { toolUseId: id, content, isError } });
  }
  return events;
}

/** Strip agy's internal cortex/permission-conversion prefix from tool errors. */
export function humanizeAgyToolError(message: string): string {
  const stripped = message.replace(
    /^declaring permissions:.*?invalid tool call error\s*\([^)]*\)\s*/i,
    '',
  ).trim();
  return stripped || message;
}

export type AgySubagentLaunch = {
  type_name: string;
  role: string;
  initial_prompt: string;
  conversation_id: string;
  logPath: string;
};

export type AgySubagentStep = {
  state: string;
  parentConversationId: string;
  stepIndex: number;
  parentToolUseId: string;
  subagents: AgySubagentLaunch[];
};

/** Strip `file://` from agy's log_uri. Never assumes $HOME. */
export function filePathFromLogUri(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

function launchFromRecord(s: Record<string, unknown>): AgySubagentLaunch {
  const conversation_id = String(s.conversation_id ?? '');
  const logUri = typeof s.log_uri === 'string' ? s.log_uri : '';
  return {
    type_name: String(s.type_name ?? s.subagent_type ?? ''),
    role: String(s.role ?? ''),
    initial_prompt: String(s.initial_prompt ?? s.prompt ?? ''),
    conversation_id,
    logPath: logUri
      ? filePathFromLogUri(logUri)
      : typeof s.logPath === 'string' ? s.logPath : '',
  };
}

function parseSubagentList(step: Record<string, unknown>): AgySubagentLaunch[] {
  const info = asRecord(step.subagent_info);
  const raw = Array.isArray(info.subagents) ? info.subagents : [];
  return raw.map((item) => launchFromRecord(asRecord(item)));
}

function invokeSubagentInput(launch: AgySubagentLaunch): Record<string, unknown> {
  return {
    role: launch.role,
    type_name: launch.type_name,
    initial_prompt: launch.initial_prompt,
    conversation_id: launch.conversation_id,
    // web collectSubagents() groups on Task | input.subagent_type — keep that key
    // so native agy subagents render in the same grouped card without a web change.
    subagent_type: launch.type_name || launch.role || 'subagent',
    prompt: launch.initial_prompt,
  };
}

/** Launch metadata from a subagent step_update frame, or null if not that frame. */
export function agySubagentLaunches(frame: Record<string, unknown>): AgySubagentStep | null {
  if (frame.event !== 'step_update') return null;
  const step = asRecord(frame.step_update);
  if (String(step.step_type ?? '') !== 'subagent') return null;
  const parentConversationId = String(step.conversation_id ?? '');
  const stepIndex = Number(step.step_index ?? 0);
  return {
    state: String(step.state ?? ''),
    parentConversationId,
    stepIndex,
    parentToolUseId: toolUseId(parentConversationId, stepIndex),
    subagents: parseSubagentList(step),
  };
}

function mapSubagentStep(step: Record<string, unknown>): PartialEvent[] {
  const conversationId = String(step.conversation_id ?? '');
  const stepIndex = Number(step.step_index ?? 0);
  const id = toolUseId(conversationId, stepIndex);
  const subagents = parseSubagentList(step);
  const first = subagents[0] ?? {
    type_name: '', role: '', initial_prompt: '', conversation_id: '', logPath: '',
  };
  const input: Record<string, unknown> = invokeSubagentInput(first);
  if (subagents.length > 1) {
    input.subagents = subagents.map((s) => ({
      role: s.role,
      type_name: s.type_name,
      initial_prompt: s.initial_prompt,
      conversation_id: s.conversation_id,
    }));
  }

  // agy marks the subagent step DONE at LAUNCH (duration_seconds is the spawn
  // handshake, typically <0.1s) — the subagent keeps running and reports back
  // asynchronously via send_message. Emitting a tool_result here would close
  // the card while the subagent is still working. The closing tool_result is
  // emitted by SubagentTailerSet.stopAll() when the parent turn ends.
  return [
    { type: 'tool_call', payload: { toolUseId: id, name: 'invoke_subagent', input } },
  ];
}

function mapStepUpdate(step: Record<string, unknown>): PartialEvent[] {
  const stepType = String(step.step_type ?? '');
  if (stepType === 'agent_response') {
    const delta = step.text_delta;
    if (typeof delta !== 'string' || delta.length === 0) return [];
    return [{ type: 'message', payload: { chunk: delta, final: false } }];
  }
  if (stepType === 'tool') return mapToolStep(step);
  if (stepType === 'subagent') return mapSubagentStep(step);
  return [];
}

function mapResult(result: Record<string, unknown>): PartialEvent[] {
  const status = String(result.status ?? '');
  const usage = usageFrom(result.usage);
  const cause = causeFromStopReason(result) ??
    (status === 'CANCELED' || status === 'INTERRUPTED' ? 'operator_interrupt' : undefined);
  const denials = deniedActionLabels(result);
  const denialMessage = denials.length > 0 ? denialErrorMessage(denials) : '';
  if (status === 'SUCCESS') {
    const out: PartialEvent[] = [
      { type: 'message', payload: { chunk: '', final: true } },
    ];
    // agy still completed the turn; surface denials as an error event without
    // flipping the terminal status (spawn watcher settles on done).
    if (denialMessage) out.push({ type: 'error', payload: { message: denialMessage } });
    out.push({ type: 'status', payload: { status: 'done', ...usage, ...(cause ? { cause } : {}) } });
    return out;
  }
  const base = typeof result.error === 'string' && result.error
    ? result.error
    : `agy result status ${status || 'ERROR'}`;
  const message = denialMessage ? `${base}\n${denialMessage}` : base;
  return [
    { type: 'error', payload: { message } },
    { type: 'status', payload: { status: 'error', ...usage, ...(cause ? { cause } : {}) } },
  ];
}

/** Conversation id from an init/result/step_update frame, if present. */
export function agyConversationId(frame: Record<string, unknown>): string | undefined {
  if (typeof frame.conversation_id === 'string' && frame.conversation_id) return frame.conversation_id;
  const step = asRecord(frame.step_update);
  if (typeof step.conversation_id === 'string' && step.conversation_id) return step.conversation_id;
  const result = asRecord(frame.result);
  if (typeof result.conversation_id === 'string' && result.conversation_id) return result.conversation_id;
  return undefined;
}

/**
 * Map one stream-json NDJSON object from `agy --print --output-format stream-json`.
 * Stateless: a DONE tool step includes both tool_call and tool_result. Use
 * `AgyStreamMapper` to drop the duplicate tool_call after an ACTIVE for the same step.
 */
export function mapAgyFrame(frame: Record<string, unknown>): PartialEvent[] {
  const event = frame.event;
  if (event === 'step_update') return mapStepUpdate(asRecord(frame.step_update));
  if (event === 'result') return mapResult(asRecord(frame.result));
  return [];
}

/** Per-turn mapper: dedups ACTIVE→DONE tool_call pairs and recovers ERROR results that still produced a response. */
export class AgyStreamMapper {
  private readonly seenToolCalls = new Set<string>();
  private readonly seenFileChanges = new Set<string>();
  private readonly openToolIds: string[] = [];
  private readonly resolvedToolIds = new Set<string>();
  /** File tools deferred on ACTIVE — name/input for recoverResult tool_call. */
  private readonly deferredFileTools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private hasEmittedMessage = false;
  /** Snapshot context occupancy (input + cache_read) from the last agent_response step. */
  private lastStepOccupancy = 0;

  getLastTurnOccupancy(): number {
    return this.lastStepOccupancy;
  }

  map(frame: Record<string, unknown>): PartialEvent[] {
    if (frame.event === 'result') {
      const recovered = this.recoverResult(asRecord(frame.result));
      if (recovered) return recovered;
    }

    // File-mutating ACTIVE steps no longer emit tool_call (deferred to DONE),
    // but recoverResult still needs an open id when the turn ends ERROR mid-tool.
    if (frame.event === 'step_update') {
      const step = asRecord(frame.step_update);
      const stepType = String(step.step_type ?? '');
      if (stepType === 'agent_response' && step.usage) {
        const u = usageFrom(step.usage);
        const occ = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
        if (occ > 0) this.lastStepOccupancy = occ;
      }
      if (stepType === 'tool' && String(step.state ?? '') === 'ACTIVE') {
        const info = asRecord(step.tool_info);
        const name = String(info.name ?? step.tool_name ?? '');
        if (FILE_WRITE_TOOLS[name]) {
          const id = toolUseId(String(step.conversation_id ?? ''), Number(step.step_index ?? 0));
          if (!this.openToolIds.includes(id) && !this.resolvedToolIds.has(id)) {
            this.openToolIds.push(id);
            this.deferredFileTools.set(id, { name, input: asRecord(info.parameters) });
          }
        }
      }
    }

    const out: PartialEvent[] = [];
    for (const ev of mapAgyFrame(frame)) {
      if (ev.type === 'message') {
        const chunk = (ev.payload as { chunk?: string }).chunk;
        if (chunk && chunk.length > 0) this.hasEmittedMessage = true;
      } else if (ev.type === 'tool_call') {
        const id = (ev.payload as { toolUseId: string }).toolUseId;
        if (this.seenToolCalls.has(id)) continue;
        this.seenToolCalls.add(id);
        this.deferredFileTools.delete(id);
        if (!this.openToolIds.includes(id)) this.openToolIds.push(id);
      } else if (ev.type === 'file_change') {
        const p = ev.payload as { toolUseId?: string; path: string };
        const key = `${p.toolUseId ?? ''}:${p.path}`;
        if (this.seenFileChanges.has(key)) continue;
        this.seenFileChanges.add(key);
      } else if (ev.type === 'tool_result') {
        const id = (ev.payload as { toolUseId: string }).toolUseId;
        if (this.resolvedToolIds.has(id)) continue;
        this.resolvedToolIds.add(id);
        this.deferredFileTools.delete(id);
      }
      out.push(ev);
    }
    return out;
  }

  /**
   * agy 1.1.x can set result.status=ERROR when a tool failed permission
   * conversion (e.g. write_to_file used as a project-file write) even after
   * later tools succeeded and a final response was produced. Attach the
   * error to the unmatched tool_call and complete the turn.
   *
   * Similarly, agy printmode scans the full conversation trajectory on turn
   * completion. A transient retried API error (attempt 1) or an error step
   * from an earlier turn in the SQLite DB can cause agy to stamp status=ERROR
   * with that replayed error onto subsequent turns even when a complete response
   * was produced.
   */
  private recoverResult(result: Record<string, unknown>): PartialEvent[] | null {
    const status = String(result.status ?? '');
    if (status === 'SUCCESS' || status === 'CANCELED' || status === 'INTERRUPTED') return null;
    const response = typeof result.response === 'string' ? result.response.trim() : '';
    const err = typeof result.error === 'string' ? result.error.trim() : '';
    const hasResponse = Boolean(response || this.hasEmittedMessage);
    if (!hasResponse || !err) return null;

    // Transient retried API errors (e.g. attempt 1 that was retried and succeeded,
    // or replayed from historical trajectory steps in the conversation SQLite DB)
    // are not fatal when a response was produced. Complete the turn cleanly
    // without emitting false error cards or marking the turn failed.
    const isTransientApiError = (
      /^(?:Error:\s*)?API error \(attempt \d+\)/i.test(err)
      || /INTERNAL \(code 500\)|UNAVAILABLE \(code 503\)/i.test(err)
    ) && !/RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(err);
    if (isTransientApiError) {
      const usage = usageFrom(result.usage);
      const cause = causeFromStopReason(result);
      const denials = deniedActionLabels(result);
      const out: PartialEvent[] = [
        { type: 'message', payload: { chunk: '', final: true } },
      ];
      if (denials.length > 0) {
        out.push({ type: 'error', payload: { message: denialErrorMessage(denials) } });
      }
      out.push({ type: 'status', payload: { status: 'done', ...usage, ...(cause ? { cause } : {}) } });
      return out;
    }

    if (!response) return null;
    // API errors (quota, rate limits, cancellation) are not tool errors;
    // attaching them as a tool result produces false tool failure cards.
    if (/RESOURCE_EXHAUSTED|API error|rate.?limit|quota|context canceled/i.test(err)) return null;

    const usage = usageFrom(result.usage);
    const cause = causeFromStopReason(result);
    const denials = deniedActionLabels(result);
    const out: PartialEvent[] = [];
    const openId = [...this.openToolIds].reverse().find((id) => !this.resolvedToolIds.has(id));
    if (openId) {
      this.resolvedToolIds.add(openId);
      const deferred = this.deferredFileTools.get(openId);
      if (deferred && !this.seenToolCalls.has(openId)) {
        this.seenToolCalls.add(openId);
        out.push({
          type: 'tool_call',
          payload: { toolUseId: openId, name: deferred.name, input: deferred.input },
        });
      }
      this.deferredFileTools.delete(openId);
      out.push({
        type: 'tool_result',
        payload: { toolUseId: openId, content: humanizeAgyToolError(err), isError: true },
      });
    }
    out.push({ type: 'message', payload: { chunk: '', final: true } });
    // recoverResult short-circuits mapResult, so denials on this payload must
    // be emitted here or they are silently dropped.
    if (denials.length > 0) {
      out.push({ type: 'error', payload: { message: denialErrorMessage(denials) } });
    }
    out.push({ type: 'status', payload: { status: 'done', ...usage, ...(cause ? { cause } : {}) } });
    return out;
  }
}

/**
 * Map a single plain-text stdout line from agy into normalised partial events.
 *
 * For the plain-text binary: a non-empty line becomes a non-final message chunk
 * (with a trailing newline restored so the UI renders line breaks correctly).
 * An empty line is swallowed — agy can emit blank lines between paragraphs and
 * they carry no semantic meaning in the plain-text protocol.
 *
 * Banner / arg-echo lines are also dropped: agy v1.0.8 prints a security banner
 * to stdout when invoked with --dangerously-skip-permissions (and other CLI
 * flags), echoing the literal flag name. Without this filter those lines would
 * surface as assistant message content.
 *
 * stream-json frames are handled by `mapAgyFrame`, not this function.
 */
export function mapAgyChunk(line: string): PartialEvent[] {
  if (line.length === 0) return [];
  if (isAgyBannerLine(line)) return [];
  return [{ type: 'message', payload: { chunk: line + '\n', final: false } }];
}

/**
 * Detect agy startup / arg-echo banner lines that should not become message
 * content. Deliberately narrow: only drop lines that START with a known banner
 * shape, never lines that merely mention the flag in passing (which could be
 * legitimate model output, code samples, or explanations).
 *
 * Matched shapes:
 *   - Lines beginning with a warning/note/info prefix:
 *       "Warning: ..."
 *       "warn: ..."
 *       "[warning] ..."
 *       "NOTE: ..."
 *       "info: ..."
 *   - Lines that are just the flag itself (with optional surrounding arg list):
 *       "--dangerously-skip-permissions"
 *       "  --dangerously-skip-permissions  "
 */
function isAgyBannerLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // Banner-prefixed lines.
  if (/^(warning|warn|note|info)\b\s*[:\-)]/i.test(trimmed)) return true;
  if (/^\[(warning|warn|note|info)\]/i.test(trimmed)) return true;

  // Line IS the flag (with optional arg list), nothing else of substance.
  // e.g. "--dangerously-skip-permissions" or "  --foo --dangerously-skip-permissions  ".
  // Require the line to be short and dominated by CLI flags (every token
  // starts with '-'), so prose mention of the flag is never dropped.
  if (trimmed.length <= 100 && trimmed.includes('--dangerously-skip-permissions')) {
    const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
    const allFlags = tokens.every((t) => t.startsWith('-'));
    if (allFlags) return true;
  }

  return false;
}

/** agy serialises tool args as JSON strings (`"\"/tmp/foo\""`). Unwrap one layer. */
function unwrapAgyArg(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']')))) {
    try { return JSON.parse(value); } catch { /* keep original */ }
  }
  return value;
}

function unwrapAgyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = unwrapAgyArg(v);
  return out;
}

function stripAgyGenericHeader(content: string): string {
  return content.replace(/^Created At: .+\nCompleted At: .+\n/, '');
}

function subagentToolUseId(subagentConvId: string, stepIndex: number): string {
  return `agy:sub:${subagentConvId}:${stepIndex}`;
}

/**
 * Nested invoke_subagent launches from a subagent transcript.jsonl step.
 * Prefers `subagent_info.subagents` (same shape as parent parseSubagentList);
 * falls back to `tool_calls[]` named `invoke_subagent`.
 */
export function agyTranscriptSubagentLaunches(step: Record<string, unknown>): AgySubagentLaunch[] {
  const fromInfo = parseSubagentList(step);
  if (fromInfo.length > 0) return fromInfo;
  const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  const out: AgySubagentLaunch[] = [];
  for (const item of toolCalls) {
    const tc = asRecord(item);
    if (String(tc.name ?? '') !== 'invoke_subagent') continue;
    out.push(launchFromRecord(unwrapAgyArgs(asRecord(tc.args))));
  }
  return out;
}

/**
 * Map one NDJSON line from a native subagent's transcript.jsonl into nested
 * events stamped with parentToolUseId (the parent's invoke_subagent tool_call).
 * GENERIC lines are treated as the result of the most recent unmatched tool_call.
 */
export class AgySubagentTranscriptMapper {
  private readonly pendingToolIds: string[] = [];
  private readonly seenSteps = new Set<number>();

  constructor(
    private readonly parentToolUseId: string,
    private readonly subagentConvId: string,
  ) {}

  map(step: Record<string, unknown>): PartialEvent[] {
    const stepIndex = Number(step.step_index ?? 0);
    if (this.seenSteps.has(stepIndex)) return [];
    this.seenSteps.add(stepIndex);

    const type = String(step.type ?? '');
    if (type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE' || type === 'CHECKPOINT') return [];

    const events: PartialEvent[] = [];

    if (type === 'GENERIC') {
      const id = this.pendingToolIds.shift();
      if (!id) return [];
      const raw = typeof step.content === 'string' ? step.content : '';
      events.push({
        type: 'tool_result',
        payload: {
          toolUseId: id,
          content: stripAgyGenericHeader(raw),
          isError: false,
          parentToolUseId: this.parentToolUseId,
        },
      });
      return events;
    }

    const launches = agyTranscriptSubagentLaunches(step);
    let launchIdx = 0;
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = asRecord(toolCalls[i]);
      const name = String(tc.name ?? 'tool');
      const input = unwrapAgyArgs(asRecord(tc.args));
      const id = toolCalls.length === 1
        ? subagentToolUseId(this.subagentConvId, stepIndex)
        : `${subagentToolUseId(this.subagentConvId, stepIndex)}:${i}`;
      if (name === 'invoke_subagent') {
        const launch = launches[launchIdx++] ?? launchFromRecord(input);
        events.push({
          type: 'tool_call',
          payload: {
            toolUseId: id,
            name: 'invoke_subagent',
            input: invokeSubagentInput(launch),
            parentToolUseId: this.parentToolUseId,
          },
        });
        continue;
      }
      this.pendingToolIds.push(id);
      events.push({
        type: 'tool_call',
        payload: { toolUseId: id, name, input, parentToolUseId: this.parentToolUseId },
      });
    }
    while (launchIdx < launches.length) {
      const launch = launches[launchIdx];
      const id = toolCalls.length === 0 && launches.length === 1
        ? subagentToolUseId(this.subagentConvId, stepIndex)
        : `${subagentToolUseId(this.subagentConvId, stepIndex)}:launch${launchIdx}`;
      launchIdx++;
      events.push({
        type: 'tool_call',
        payload: {
          toolUseId: id,
          name: 'invoke_subagent',
          input: invokeSubagentInput(launch),
          parentToolUseId: this.parentToolUseId,
        },
      });
    }

    const content = typeof step.content === 'string' ? step.content : '';
    if (content && (type === 'PLANNER_RESPONSE' || type === 'MODEL_RESPONSE')) {
      events.push({
        type: 'message',
        payload: { chunk: content, final: false, parentToolUseId: this.parentToolUseId },
      });
    }

    return events;
  }
}
