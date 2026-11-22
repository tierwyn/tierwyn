import { EventEmitter } from 'events';
import {
  NODE_MAX_FRAME_BYTES,
  isNodeFrame,
  type NodeFrame,
  type RpcErr,
} from '@tierwyn/shared';

export interface FrameTransport {
  send(text: string): void;
  onText(cb: (t: string) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
  close(code?: number, reason?: string): void;
}

export class RpcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export type RpcHandler = (p: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcPeer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private readonly timeoutMs: number;
  private readonly handlers: Map<string, RpcHandler>;
  /** Applied in send() so res/error frames are redacted too. */
  redact?: (f: NodeFrame) => NodeFrame;

  constructor(
    private readonly transport: FrameTransport,
    handlers: Record<string, RpcHandler>,
    opts?: { timeoutMs?: number },
  ) {
    super();
    this.handlers = new Map(Object.entries(handlers));
    this.timeoutMs = opts?.timeoutMs ?? 60_000;
    transport.onText((text) => {
      void this.onText(text).catch((err) => {
        console.warn('rpc onText', err);
      });
    });
    transport.onClose(() => this.onDisconnected());
  }

  setHandler(m: string, h: RpcHandler): void {
    this.handlers.set(m, h);
  }

  request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('disconnected', 'host disconnected'));
    const id = this.nextId++;
    const ms = timeoutMs ?? this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      // timeoutMs 0 (or negative) means park with no timer — required for steer.next.
      const timer = ms > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcError('timeout', `RPC ${m} timed out`));
          }, ms)
        : undefined;
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.send({ t: 'req', id, m, ...(p !== undefined ? { p } : {}) });
    });
  }

  send(f: NodeFrame): boolean {
    if (this.closed) return false;
    const out = this.redact ? this.redact(f) : f;
    this.transport.send(encodeFrame(out));
    return true;
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.rejectAll('disconnected', 'host disconnected');
    this.closed = true;
    this.transport.close(code, reason);
    this.emit('close');
  }

  private async onText(text: string): Promise<void> {
    const frame = decodeFrame(text);
    if (!frame) return;
    if (frame.t === 'req') {
      await this.handleReq(frame);
      return;
    }
    if (frame.t === 'res') {
      this.handleRes(frame);
      return;
    }
    this.emit('frame', frame);
  }

  private async handleReq(frame: Extract<NodeFrame, { t: 'req' }>): Promise<void> {
    const handler = this.handlers.get(frame.m);
    if (!handler) {
      this.send({
        t: 'res',
        id: frame.id,
        ok: false,
        e: { code: 'no_method', message: `unknown method ${frame.m}` },
      });
      return;
    }
    try {
      const r = await handler(frame.p);
      this.send({ t: 'res', id: frame.id, ok: true, r });
    } catch (err) {
      const e: RpcErr = err instanceof RpcError
        ? { code: err.code, message: err.message }
        : { code: 'error', message: err instanceof Error ? err.message : String(err) };
      this.send({ t: 'res', id: frame.id, ok: false, e });
    }
  }

  private handleRes(frame: Extract<NodeFrame, { t: 'res' }>): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.r);
    else pending.reject(new RpcError(frame.e.code, frame.e.message));
  }

  private onDisconnected(): void {
    if (this.closed) return;
    this.rejectAll('disconnected', 'host disconnected');
    this.closed = true;
    this.emit('close');
  }

  private rejectAll(code: string, message: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(code, message));
    }
    this.pending.clear();
  }
}

export function encodeFrame(f: NodeFrame): string {
  return JSON.stringify(f);
}

export function decodeFrame(text: string): NodeFrame | null {
  if (text.length > NODE_MAX_FRAME_BYTES) return null;
  if (Buffer.byteLength(text, 'utf8') > NODE_MAX_FRAME_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isNodeFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function memoryPair(): [FrameTransport, FrameTransport] {
  type Side = {
    texts: Array<(t: string) => void>;
    closes: Array<(code?: number, reason?: string) => void>;
    closed: boolean;
  };
  const left: Side = { texts: [], closes: [], closed: false };
  const right: Side = { texts: [], closes: [], closed: false };

  function make(self: Side, peer: Side): FrameTransport {
    return {
      send(text) {
        if (self.closed || peer.closed) return;
        queueMicrotask(() => {
          if (peer.closed) return;
          for (const cb of peer.texts) cb(text);
        });
      },
      onText(cb) { self.texts.push(cb); },
      onClose(cb) { self.closes.push(cb); },
      close(code, reason) {
        if (self.closed) return;
        self.closed = true;
        const already = peer.closed;
        peer.closed = true;
        queueMicrotask(() => {
          for (const cb of self.closes) cb(code, reason);
          if (!already) for (const cb of peer.closes) cb(code, reason);
        });
      },
    };
  }

  return [make(left, right), make(right, left)];
}

export function wsTransport(ws: import('ws').WebSocket): FrameTransport {
  let closed = false;
  let closeCb: ((code?: number, reason?: string) => void) | undefined;
  const fireClose = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    closeCb?.(code, reason);
  };
  // Attach an 'error' listener so transient handshake errors (e.g. HTTP 502/504
  // from a reverse proxy while the hub restarts, or ECONNREFUSED) do not crash
  // the node daemon with an unhandled EventEmitter 'error' exception.
  ws.on('error', (err) => {
    console.warn('ws transport error:', err instanceof Error ? err.message : String(err));
    fireClose(1006, err instanceof Error ? err.message : String(err));
  });
  return {
    send(text) {
      if (ws.readyState === undefined || ws.readyState === 1 /* OPEN */) ws.send(text);
    },
    onText(cb) {
      ws.on('message', (data) => {
        cb(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      });
    },
    onClose(cb) {
      closeCb = cb;
      ws.on('close', (code, reason) => {
        fireClose(code, typeof reason === 'string' ? reason : reason?.toString());
      });
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate?.();
      }
    },
  };
}
