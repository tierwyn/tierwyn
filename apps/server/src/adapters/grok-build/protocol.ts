/**
 * protocol.ts — JSON-RPC 2.0 client over JSONL stdio for `grok agent stdio`.
 *
 * Drives the Agent Client Protocol (ACP) — same wire shape Hermes uses. One
 * JSON message per line on the child's stdin/stdout.
 *
 * Three routing cases (mirrors codex/protocol.ts `CodexRpc`):
 *  (a) inbound {id, result/error}  → resolve/reject a pending send() promise
 *  (b) inbound {id, method}        → server→client request (permission); routed
 *                                      to the single onServerRequest handler
 *  (c) inbound {method}, no id     → notification; dispatched to on() handlers
 *
 * CONFIRMED (Phase 0) ACP method/notification table for `grok agent stdio` v0.2.101
 * (methods below still accurate; `_meta.reasoningEffort` / `_meta.yoloMode` on
 * session/new, session/load and session/set_model re-confirmed on grok 1.0.5):
 *   Requests (client→agent, expect a result):
 *     initialize              → { protocolVersion, agentCapabilities:{loadSession,...} }
 *     session/new             → { sessionId, models:{currentModelId,...}, _meta }
 *     session/load            → { models, _meta }   (gated on loadSession capability)
 *     session/set_model       → { _meta:{ model:{Ok|Err} } }
 *     session/prompt          → { stopReason, _meta:{ usage:{inputTokens,...} } }
 *     session/cancel          → {} (notification-shaped but we send as request for an ack)
 *     _x.ai/billing           → { config:{ creditUsagePercent, currentPeriod, … }, subscription_tier }
 *                               (no session required; unprefixed `x.ai/billing` is -32601 on 1.0.5 stdio)
 *   Notifications (agent→client, no id):
 *     session/update          → params.update.sessionUpdate ∈
 *         { agent_message_chunk, agent_thought_chunk, user_message_chunk,
 *           tool_call, tool_call_update, available_commands_update, model_changed,
 *           pending_interaction, interaction_resolved }
 *     _x.ai/session/notification   → update.sessionUpdate = turn_completed (carries usage)
 *     _x.ai/session/prompt_complete → { stopReason }
 *     _x.ai/mcp/*, _x.ai/sessions/changed, _x.ai/queue/changed, _x.ai/models/update,
 *       _x.ai/settings/update, _x.ai/announcements/update  → ignored out-of-band
 *   Server→client request (agent→client, has id + method):
 *     session/request_permission → params.options:[{optionId,name,kind}]; reply
 *                                    { outcome:{ outcome:'selected', optionId } }
 *
 * Gotcha (Phase 0): the ACP `initialized` notification (MCP-style post-handshake)
 * triggers a stderr "Method not found" decode error in grok 0.2.101. We DO NOT
 * send it — initialize alone completes the handshake. (Hermes sends it; Grok
 * differs.) See acp-init.jsonl line 6.
 *
 * Auth: grok reads a cached token from ~/.grok/auth.json when XAI_API_KEY is
 * unset (the Phase 0 captures used this path). No credentials cross stdio.
 */

import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';

export type RequestId = number | string;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** Friendly copy when xAI returns HTTP 402 / weekly Grok Build credit exhaustion. */
export const GROK_CREDITS_EXHAUSTED_MESSAGE =
  'Grok Build credits exhausted (HTTP 402). Weekly xAI usage balance is spent — '
  + 'wait for the weekly reset, enable on-demand billing in the Grok account, or switch agent profile.';

/**
 * Flatten one JSON-RPC error field (message or data) to a readable string.
 * Object `data` used to become `[object Object]` via template coercion — that
 * is exactly how operators saw `Internal error: [object Object]` on 402s.
 */
export function stringifyGrokRpcPart(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // Prefer nested API message (grok wraps 402 details inside error.data).
    if (typeof o.message === 'string' && o.message.trim()) {
      const status = typeof o.status_code === 'number' ? o.status_code
        : typeof o.status === 'number' ? o.status
          : undefined;
      return status !== undefined ? `${o.message} (status ${status})` : o.message;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/** True when raw RPC / API text indicates Grok Build weekly credits are spent. */
export function isGrokCreditsExhausted(text: string): boolean {
  return /402\b|payment required|usage balance exhausted|credits? (exhausted|depleted|spent)|insufficient.?credits?|weekly.?credits?.*(exhaust|spent|empty)/i
    .test(text);
}

/**
 * Format a JSON-RPC `error` object from `grok agent stdio` into a single
 * human-readable string, rewriting credit-exhaustion into an actionable notice.
 */
export function formatGrokRpcError(error: unknown): string {
  const err = (error && typeof error === 'object') ? error as Record<string, unknown> : {};
  const message = stringifyGrokRpcPart(err.message) || 'JSON-RPC error';
  const dataStr = (err.data !== undefined && err.data !== null)
    ? stringifyGrokRpcPart(err.data)
    : '';
  const combined = dataStr ? `${message}: ${dataStr}` : message;
  if (isGrokCreditsExhausted(combined)) return GROK_CREDITS_EXHAUSTED_MESSAGE;
  return combined;
}

/** Rewrite any already-stringified adapter error that is credit exhaustion. */
export function humanizeGrokError(raw: string): string {
  if (isGrokCreditsExhausted(raw)) return GROK_CREDITS_EXHAUSTED_MESSAGE;
  return raw;
}

/** Grok's initialize result (hand-copied from acp-init.jsonl line 3). */
export interface GrokInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean };
    mcpCapabilities?: Record<string, unknown>;
    sessionCapabilities?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  authMethods?: Array<{ id: string; name: string; description: string }>;
  _meta?: Record<string, unknown>;
}

/** Grok's session/new result (acp-prompt.jsonl line 12). */
export interface GrokSessionNewResult {
  sessionId: string;
  models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string }> };
  _meta?: Record<string, unknown>;
}

/** Grok's session/prompt result (acp-prompt.jsonl last line). */
export interface GrokPromptResult {
  stopReason: string;
  _meta?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedReadTokens?: number;
      reasoningTokens?: number;
      modelCalls?: number;
    };
    [k: string]: unknown;
  };
}

export class GrokRpc {
  private readonly _pending = new Map<RequestId, PendingRequest>();
  private readonly _notifHandlers = new Map<string, Array<(params: unknown) => void>>();
  private _serverReqHandler?: (method: string, id: RequestId, params: unknown) => void;
  private readonly _stdin: Writable;
  private _idSeq = 0;

  constructor(stdin: Writable, stdout: Readable) {
    this._stdin = stdin;
    stdin.on('error', () => {}); // async EPIPE must not crash the server
    const rl = createInterface({ input: stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this._handleLine(JSON.parse(trimmed) as Record<string, unknown>);
      } catch { /* ignore non-JSON / partial lines (defence vs update chatter) */ }
    });
  }

  private _handleLine(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === 'string';
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;

    if (hasId && (hasResult || hasError)) {
      // (a) Response to a pending send()
      const id = msg.id as RequestId;
      const pending = this._pending.get(id);
      if (pending) {
        this._pending.delete(id);
        if (hasError) {
          pending.reject(new Error(formatGrokRpcError(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (hasId && hasMethod) {
      // (b) Server→client request (permission round-trip)
      this._serverReqHandler?.(msg.method as string, msg.id as RequestId, msg.params);
    } else if (hasMethod) {
      // (c) Notification
      const handlers = this._notifHandlers.get(msg.method as string);
      if (handlers) for (const h of handlers) h(msg.params);
    }
  }

  /** Send a JSON-RPC 2.0 request and return a Promise for the result. */
  send<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this._idSeq;
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this._write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    this._write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  /** Register a handler for a notification method (multiple handlers allowed). */
  on(method: string, handler: (params: unknown) => void): void {
    const list = this._notifHandlers.get(method) ?? [];
    list.push(handler);
    this._notifHandlers.set(method, list);
  }

  /** Register the single handler for server→client requests (permissions). */
  onServerRequest(handler: (method: string, id: RequestId, params: unknown) => void): void {
    this._serverReqHandler = handler;
  }

  /** Reply to a server→client request (send a JSON-RPC response). */
  respond(id: RequestId, result: unknown): void {
    this._write({ jsonrpc: '2.0', id, result });
  }

  /**
   * Run the ACP initialize handshake. Grok's expected clientCapabilities
   * (CONFIRMED acp-init.jsonl line 2 — same as Hermes): no fs, no terminal.
   * We DO NOT send the `initialized` notification — Phase 0 showed grok 0.2.101
   * logs "Method not found" to stderr when it receives one.
   */
  async initialize(): Promise<GrokInitializeResult> {
    return this.send<GrokInitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  }

  /** Reject all pending requests (call on subprocess exit/error). */
  drainPending(reason: string): void {
    for (const { reject } of this._pending.values()) {
      reject(new Error(reason));
    }
    this._pending.clear();
  }

  private _write(obj: unknown): void {
    try {
      this._stdin.write(JSON.stringify(obj) + '\n');
    } catch { /* stream may be closed */ }
  }
}
