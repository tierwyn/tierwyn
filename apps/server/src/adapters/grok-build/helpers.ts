/**
 * Grok Build native subagent (helper) tracking.
 *
 * Path A: emit `helper` snapshots so sessionManager keeps runningHelpers
 * (header chip, parked-session adoption). Grok's spawn_subagent ack is an
 * instant "started in background" tool_result — path B would mark it done.
 *
 * Stateful: subagent_id lives in launch-result prose, later
 * get_command_or_subagent_output / kill_command_or_subagent refer to it.
 * Keep the map on the adapter instance, not in pure mapAcpUpdate.
 *
 * stopHelper is unimplemented: Grok has no out-of-band ACP cancel per
 * subagent. The UI Stop button stays hidden for these rows.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HelperEvent, HelperStatus } from '@tierwyn/shared';
import type { PartialEvent } from './mapping.js';
import { flattenContent } from './mapping.js';

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SUBAGENT_ID_RE = new RegExp(`subagent_id:\\s*(${UUID_RE})`, 'i');
const TYPE_RE = /(?:^|\n)\s*type:\s*(\S+)/i;
const SUMMARY_CAP = 4000;

export interface ParsedSpawnSubagent {
  subagentId: string;
  type?: string;
}

export interface ParsedSubagentOutput {
  taskId?: string;
  status: Exclude<HelperStatus, 'running'>;
  durationMs?: number;
  summary?: string;
}

export function parseSpawnSubagentResult(text: string): ParsedSpawnSubagent | null {
  const id = text.match(SUBAGENT_ID_RE)?.[1];
  if (!id) return null;
  const type = text.match(TYPE_RE)?.[1];
  return type ? { subagentId: id, type } : { subagentId: id };
}

function truncateSummary(text: string): string {
  return text.length > SUMMARY_CAP ? text.slice(0, SUMMARY_CAP) : text;
}

function resultFromRecord(result: Record<string, unknown>): ParsedSubagentOutput {
  const taskId = typeof result.task_id === 'string' ? result.task_id : undefined;
  const exit = typeof result.exit_code === 'number' ? result.exit_code : 0;
  const rawStatus = typeof result.status === 'string' ? result.status : '';
  let status: ParsedSubagentOutput['status'] = 'completed';
  if (rawStatus === 'stopped' || rawStatus === 'killed') status = 'stopped';
  else if (rawStatus === 'failed' || rawStatus === 'error' || exit !== 0) status = 'failed';
  const durationSecs = typeof result.duration_secs === 'number' ? result.duration_secs : undefined;
  const output = typeof result.output === 'string' ? result.output : undefined;
  return {
    ...(taskId ? { taskId } : {}),
    status,
    ...(durationSecs !== undefined ? { durationMs: Math.round(durationSecs * 1000) } : {}),
    ...(output ? { summary: truncateSummary(output) } : {}),
  };
}

export function parseSubagentTaskOutput(rawOutput: unknown): ParsedSubagentOutput | null {
  if (!rawOutput || typeof rawOutput !== 'object') return null;
  const rec = rawOutput as Record<string, unknown>;
  if (rec.type === 'TaskNotFound') return { status: 'stopped' };
  if (rec.type === 'TaskOutput') {
    const result = (rec.Result ?? rec.result ?? {}) as Record<string, unknown>;
    return resultFromRecord(result);
  }
  // Disk output.json is a flat {status, exit_code, duration_secs, output}.
  if (typeof rec.status === 'string' || typeof rec.output === 'string') {
    return resultFromRecord(rec);
  }
  return null;
}

function idFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['task_id', 'subagent_id', 'id']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

type PendingCall = { name: string; input: Record<string, unknown> };

export class GrokHelperTracker {
  private readonly _calls = new Map<string, PendingCall>();
  private readonly _helpers = new Map<string, HelperEvent['payload']>();
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: {
    emit: (ev: PartialEvent) => void;
    now?: () => number;
    sessionDir?: () => string | null;
    pollMs?: number;
  }) {}

  observe(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate as string | undefined;
    if (kind === 'tool_call') {
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
      const name = String(update.title ?? rawInput.variant ?? update.toolCallId ?? 'tool');
      this._calls.set(id, { name, input: { ...rawInput } });
      return;
    }
    if (kind !== 'tool_call_update') return;
    const status = String(update.status ?? '');
    if (status !== 'completed' && status !== 'failed') return;
    const id = String(update.toolCallId ?? '');
    const call = this._calls.get(id);
    if (!call) return;
    if (call.name === 'spawn_subagent') this._onSpawnDone(id, call, update);
    else if (call.name === 'get_command_or_subagent_output') this._onOutput(call, update);
    else if (call.name === 'kill_command_or_subagent') this._onKill(call);
  }

  close(): void {
    this._stopPoll();
    for (const [taskId, payload] of this._helpers) {
      if (payload.status !== 'running') continue;
      payload.status = 'stopped';
      this._emitHelper(taskId);
    }
  }

  private _now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private _emitHelper(taskId: string): void {
    const payload = this._helpers.get(taskId);
    if (!payload) return;
    this.opts.emit({ type: 'helper', payload: { ...payload } });
  }

  private _onSpawnDone(toolUseId: string, call: PendingCall, update: Record<string, unknown>): void {
    const parsed = parseSpawnSubagentResult(flattenContent(update.content));
    if (!parsed) return;
    const fromInput = typeof call.input.subagent_type === 'string' ? call.input.subagent_type : '';
    const label = parsed.type || fromInput || 'general-purpose';
    const description = typeof call.input.description === 'string' ? call.input.description : '';
    this._helpers.set(parsed.subagentId, {
      taskId: parsed.subagentId,
      toolUseId,
      label,
      description,
      status: 'running',
      startedAt: this._now(),
      background: call.input.background !== false,
    });
    this._emitHelper(parsed.subagentId);
    this._ensurePoll();
  }

  private _finish(taskId: string, parsed: ParsedSubagentOutput, fallbackStatus: HelperStatus): void {
    const cur = this._helpers.get(taskId);
    if (!cur || cur.status !== 'running') return;
    cur.status = parsed.status ?? fallbackStatus;
    if (parsed.summary) cur.summary = parsed.summary;
    if (parsed.durationMs !== undefined) {
      cur.usage = { totalTokens: 0, toolUses: 0, durationMs: parsed.durationMs };
    }
    this._emitHelper(taskId);
    this._maybeStopPoll();
  }

  private _onOutput(call: PendingCall, update: Record<string, unknown>): void {
    const parsed = parseSubagentTaskOutput(update.rawOutput) ?? (
      /TaskNotFound/i.test(flattenContent(update.content)) ? { status: 'stopped' as const } : null
    );
    const taskId = parsed?.taskId ?? idFromInput(call.input);
    if (!taskId) return;
    if (parsed) {
      this._finish(taskId, parsed, 'completed');
      return;
    }
    const text = flattenContent(update.content);
    this._finish(taskId, {
      status: String(update.status) === 'failed' ? 'failed' : 'completed',
      ...(text ? { summary: truncateSummary(text) } : {}),
    }, 'completed');
  }

  private _onKill(call: PendingCall): void {
    const taskId = idFromInput(call.input);
    if (!taskId) return;
    this._finish(taskId, { status: 'stopped' }, 'stopped');
  }

  private _ensurePoll(): void {
    if (this._timer || !this.opts.sessionDir) return;
    if (![...this._helpers.values()].some((h) => h.status === 'running')) return;
    this._timer = setInterval(() => this._tick(), this.opts.pollMs ?? 1500);
  }

  private _maybeStopPoll(): void {
    if ([...this._helpers.values()].some((h) => h.status === 'running')) return;
    this._stopPoll();
  }

  private _stopPoll(): void {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  private _tick(): void {
    const dir = this.opts.sessionDir?.();
    if (!dir) return;
    for (const [taskId, payload] of this._helpers) {
      if (payload.status !== 'running') continue;
      const path = join(dir, 'subagents', taskId, 'output.json');
      if (!existsSync(path)) continue;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
      const parsed = parseSubagentTaskOutput(raw);
      if (!parsed) continue;
      this._finish(taskId, parsed, 'completed');
    }
  }
}
