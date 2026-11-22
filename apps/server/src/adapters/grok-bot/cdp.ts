/**
 * Minimal Chrome DevTools Protocol client over the repo's existing `ws`.
 * Loopback-only. No Target.attachToTarget — we connect straight to the
 * page target's webSocketDebuggerUrl from GET /json/list.
 */
import WebSocket from 'ws';

export interface CdpTarget {
  id?: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

export type CdpLike = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  on(method: string, cb: (params: unknown) => void): () => void;
  close(): Promise<void>;
};

const LOOPBACK_RE = /^ws:\/\/127\.0\.0\.1(?::\d+)?\//;

function assertLoopback(wsUrl: string): void {
  if (!LOOPBACK_RE.test(wsUrl)) {
    throw new Error(`CDP URL must be ws://127.0.0.1/…, got ${wsUrl}`);
  }
}

async function listTargets(port: number, fetchFn: typeof fetch): Promise<CdpTarget[]> {
  const base = `http://127.0.0.1:${port}`;
  await fetchFn(`${base}/json/version`).catch(() => {
    throw new Error(`Grok Bot CDP unreachable on 127.0.0.1:${port}`);
  });
  const res = await fetchFn(`${base}/json/list`);
  if (!res.ok) throw new Error(`Grok Bot /json/list failed: HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

export async function discoverPageTarget(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<CdpTarget> {
  const list = await listTargets(port, fetchFn);
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('Grok Bot page target not found on CDP /json/list');
  return page;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CdpClient implements CdpLike {
  /** Fired once the underlying socket closes or errors — lets owners forget a dead client. */
  onClosed?: () => void;
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  async connect(wsUrl: string): Promise<void> {
    assertLoopback(wsUrl);
    if (this.ws) await this.close();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const onErr = (err: Error) => reject(err);
      ws.once('error', onErr);
      ws.once('open', () => {
        ws.off('error', onErr);
        resolve();
      });
      ws.on('message', (raw) => this._onMessage(String(raw)));
      ws.on('close', () => {
        this._rejectAll(new Error('CDP socket closed'));
        this.onClosed?.();
      });
      ws.on('error', () => {
        this._rejectAll(new Error('CDP socket dropped'));
        this.onClosed?.();
      });
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket closed'));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      ws.send(JSON.stringify(params !== undefined ? { id, method, params } : { id, method }));
    });
  }

  on(method: string, cb: (params: unknown) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? 'Runtime.evaluate exception',
      );
    }
    return result.result?.value as T;
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    this._rejectAll(new Error('CDP socket closed'));
    if (!ws) return;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  private _onMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (set) for (const cb of set) cb(msg.params);
    }
  }

  private _rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
