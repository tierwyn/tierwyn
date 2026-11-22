/**
 * protocol.ts — JSON-RPC 2.0 client over JSONL stdio for `codex app-server`.
 *
 * Three routing cases (§2.1 of the implementation plan):
 *  (a) inbound {id, result/error}  → resolve/reject a pending send() promise
 *  (b) inbound {id, method}        → server→client request (approval); call onServerRequest handler
 *  (c) inbound {method}, no id     → notification; dispatch to registered on() handlers
 *
 * The codex app-server omits the `jsonrpc` field from responses — we do not require it.
 * Types below are hand-copied from /tmp/codex-ts/v2 — only the messages we consume.
 */

import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';

export type RequestId = number | string;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class CodexRpc {
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
      } catch { /* ignore non-JSON lines */ }
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
          const err = msg.error as { message?: string } | undefined;
          pending.reject(new Error(err?.message ?? 'JSON-RPC error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (hasId && hasMethod) {
      // (b) Server→client request (approval)
      this._serverReqHandler?.(
        msg.method as string,
        msg.id as RequestId,
        msg.params,
      );
    } else if (hasMethod) {
      // (c) Notification
      const handlers = this._notifHandlers.get(msg.method as string);
      if (handlers) {
        for (const h of handlers) h(msg.params);
      }
    }
  }

  /** Send a JSON-RPC 2.0 request and return a Promise for the result. */
  send(method: string, params?: unknown): Promise<unknown> {
    const id = ++this._idSeq;
    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    this._write({ jsonrpc: '2.0', method, params });
  }

  /** Register a handler for a notification method (multiple handlers allowed). */
  on(method: string, handler: (params: unknown) => void): void {
    const list = this._notifHandlers.get(method) ?? [];
    list.push(handler);
    this._notifHandlers.set(method, list);
  }

  /** Register the single handler for server→client requests (approvals). */
  onServerRequest(handler: (method: string, id: RequestId, params: unknown) => void): void {
    this._serverReqHandler = handler;
  }

  /** Reply to a server→client request (send a JSON-RPC response). */
  respond(id: RequestId, result: unknown): void {
    this._write({ jsonrpc: '2.0', id, result });
  }

  /** Run the codex app-server initialize handshake (§2.2). */
  async initialize(): Promise<InitializeResult> {
    const result = await this.send('initialize', {
      clientInfo: { name: 'tierwyn', title: 'Tierwyn', version: '0.1.0' },
      capabilities: null,
    }) as InitializeResult;
    // MCP-style "initialized" notification — send even though it's likely optional.
    this.notify('initialized', {});
    return result;
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

// ── Narrow protocol types (hand-copied from /tmp/codex-ts/v2) ────────────────

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadStartResult {
  thread: Thread;
}

export interface ThreadResumeResult {
  thread: Thread;
}

export interface Thread {
  id: string;
  preview: string;
  createdAt: number; // unix seconds
  path: string | null;
  status: { type: 'idle' | 'active' } & Record<string, unknown>;
}

export interface ThreadListResult {
  data: Thread[];
  nextCursor: string | null;
}

export interface TurnStartResult {
  turn: { id: string; status: string };
}

// Notification param shapes (what we pull from the raw .params)

export interface ThreadStatusChangedParams {
  threadId: string;
  status: { type: 'idle' | 'active' | string };
}

export interface TurnStartedParams {
  threadId: string;
  turn: { id: string };
}

export interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string };
}

export interface ItemStartedParams {
  threadId: string;
  turnId: string;
  item: ThreadItem;
  startedAtMs: number;
}

export interface ItemCompletedParams {
  threadId: string;
  turnId: string;
  item: ThreadItem;
  completedAtMs: number;
}

export interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    last: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    };
    modelContextWindow: number | null;
  };
}

export interface ErrorNotificationParams {
  /** String in older builds; object {message, codexErrorInfo, additionalDetails} in current app-server. */
  error: string | { message?: string; codexErrorInfo?: string; additionalDetails?: unknown };
  willRetry: boolean;
  threadId?: string;
  turnId?: string;
}

/** Agent state on a collabAgentToolCall. App-server v2 is `{status, message}`;
 *  some rollouts used a string or `{completed}/{errored}` object instead. */
export type CollabAgentState =
  | { status: string; message?: string | null }
  | { completed: string | null }
  | { errored: string }
  | string;

// ThreadItem subset (only types we map)
export type ThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; aggregatedOutput: string | null; exitCode: number | null }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; arguments: unknown; result: { content?: unknown } | null; error: { message?: string } | null }
  | { type: 'dynamicToolCall'; id: string; namespace: string | null; tool: string; arguments: unknown; contentItems: Array<{ type: string; text?: string }> | null; success: boolean | null }
  | { type: 'fileChange'; id: string; changes: Array<{ path: string; kind: string; diff: string }> }
  | { type: 'webSearch'; id: string; query: string }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: string;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model?: string | null;
      reasoningEffort?: unknown;
      agentsStates?: Record<string, CollabAgentState | undefined>;
      /** Present on some rollouts / builds; not in app-server v2 ThreadItem. */
      receiverAgents?: Array<{ threadId: string; agentNickname?: string | null }>;
    }
  | { type: string; id: string };

// ── Review types (hand-copied from /tmp/codex-ts/v2/ReviewStartParams.ts etc.) ──

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string };

export interface ReviewStartParams {
  threadId: string;
  target: ReviewTarget;
  delivery?: 'inline' | 'detached' | null;
}

export interface ReviewStartResult {
  turn: { id: string; status: string };
  reviewThreadId: string;
}

// Approval server-request param shapes
export interface CommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
}
