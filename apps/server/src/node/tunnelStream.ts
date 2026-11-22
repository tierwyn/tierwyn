import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { PassThrough, pipeline } from 'stream';
import {
  isTunnelPathAllowed,
  TUNNEL_STREAM_CHUNK_BYTES,
  TUNNEL_STREAM_IDLE_MS,
  TUNNEL_STREAM_MAX_PER_HOST,
  TUNNEL_STREAM_MAX_REQ_BYTES,
  TUNNEL_STREAM_WINDOW_BYTES,
  type NodeFrame,
} from '@tierwyn/shared';
import { buildReplayHeaders, filterResponseHeaders, flattenIncomingHeaders } from './tunnelHeaders.js';
import { RpcPeer } from './rpc.js';

/**
 * Streaming tunnel. Both HTTP directions flow as `http.head` / `http.chunk` /
 * `http.end` frames keyed by a per-connection `rid`. The receiver of every byte
 * stream grants `http.credit` back once its sink accepted the bytes, and the
 * sender parks once its unacked window reaches TUNNEL_STREAM_WINDOW_BYTES.
 *
 * Node side (`streamNodeRequest`): request head + body out, response in.
 * Hub side (`HubStreamRouter`): request in, response head + body out.
 */

export type Respond = {
  head: (status: number, headers: Record<string, string>) => void;
  chunk: (b: Buffer) => Promise<void>;
  end: (error?: string) => void;
  /** Tear down the upstream request/response even after the body ended cleanly. */
  destroy?: () => void;
};

export type HubStreamReplay = (
  hostId: string,
  head: { method: string; path: string; headers: Record<string, string> },
  body: PassThrough,
  respond: Respond,
) => void;

export type StreamReplayOptions = {
  port: number;
  nodeSecret: string;
  /** Injectable for tests; defaults to node http.request. */
  requestFn?: typeof httpRequest;
};

/**
 * Hub-side loopback replay for the streaming tunnel: turns a node's request
 * head + body stream into a loopback HTTP request against the hub app and
 * streams the response back over `respond`. Mirrors the buffered replay's
 * invariants (allow-list, node identity headers, GET/HEAD body reject,
 * agent:false) while keeping both directions incremental.
 */
export function makeLoopbackStreamReplay(opts: StreamReplayOptions): HubStreamReplay {
  const request = opts.requestFn ?? httpRequest;
  return (hostId, head, body, respond) => {
    if (!isTunnelPathAllowed(head.method, head.path)) {
      respond.head(404, { 'content-type': 'application/json' });
      respond.end();
      return;
    }
    const headers = buildReplayHeaders(hostId, head.headers, opts.nodeSecret, { stream: true });
    if (head.method === 'GET' || head.method === 'HEAD') headers['content-length'] = '0';
    const upstream = request(
      { hostname: '127.0.0.1', port: opts.port, method: head.method, path: head.path, headers, agent: false },
      (res) => {
        respond.head(res.statusCode ?? 502, filterResponseHeaders(res.headers, true));
        // Pull-based pump: each chunk is read only after the previous one was
        // accepted by the credit window, so hub-side memory stays bounded.
        // (pause() in the response callback never re-flows via a later
        // 'data' attach — pull with read() instead of pausing the stream.)
        let pumping = false;
        const pump = (): void => {
          if (pumping) return;
          pumping = true;
          const next = (): void => {
            const c = res.read() as Buffer | null;
            if (c === null || c.length === 0) {
              pumping = false;
              return;
            }
            void respond.chunk(c).then(
              () => next(),
              () => res.destroy(),
            );
          };
          next();
        };
        res.on('readable', pump);
        res.on('end', () => respond.end());
        res.on('error', () => respond.end('upstream read failed'));
      },
    );
    upstream.on('error', (err: Error) => respond.end(err.message));
    // HubStreamRouter tears the loopback exchange down on client disconnect /
    // peer close — required once the request body already ended cleanly.
    respond.destroy = (): void => { upstream.destroy(); };
    // Request-body plumbing only: resolves when the body stream ends, long
    // before the response has finished. Response completion is driven by the
    // res handlers above.
    pipeline(body, upstream, (err) => {
      if (err) respond.end(err.message);
    });
  };
}

/** Credit-window sender: writes park when unacked bytes reach the window. */
export class CreditSender {
  private window: number;
  private pending: Array<{ buf: Buffer; resolve: () => void; reject: (e: Error) => void }> = [];
  private ended = false;
  private abortErr: Error | undefined;

  constructor(
    private readonly send: (f: NodeFrame) => boolean,
    private readonly rid: number,
    window: number = TUNNEL_STREAM_WINDOW_BYTES,
  ) {
    this.window = window;
  }

  /** Receiver granted `bytes` back to the window. */
  credit(bytes: number): void {
    this.window += bytes;
    this.pump();
  }

  /** Queue bytes; resolves once every chunk has been handed to send(). */
  async write(buf: Buffer): Promise<void> {
    for (let off = 0; off < buf.length; off += TUNNEL_STREAM_CHUNK_BYTES) {
      const piece = buf.subarray(off, Math.min(off + TUNNEL_STREAM_CHUNK_BYTES, buf.length));
      await new Promise<void>((resolve, reject) => {
        this.pending.push({ buf: piece, resolve, reject });
        this.pump();
      });
    }
  }

  /** Flush an `http.end` (idempotent). */
  end(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.send({ t: 'http.end', rid: this.rid, ...(error !== undefined ? { error } : {}) });
  }

  /** Drop queued writes (connection died); nothing further is sent. */
  abort(): void {
    this.abortErr = this.abortErr ?? new Error('stream aborted');
    this.pump();
  }

  private pump(): void {
    while (!this.abortErr && this.pending.length > 0) {
      const next = this.pending[0];
      if (this.window < next.buf.length) return;
      this.pending.shift();
      this.window -= next.buf.length;
      this.send({ t: 'http.chunk', rid: this.rid, b64: next.buf.toString('base64') });
      next.resolve();
    }
    if (this.abortErr) {
      for (const p of this.pending.splice(0)) p.reject(this.abortErr);
    }
  }
}

/**
 * Node side of the streaming tunnel: forward one agent request over the RPC
 * peer as http.* frames and stream the hub's response back. Fire-and-forget;
 * the caller keeps serving other requests on the same listener.
 */
export function streamNodeRequest(peer: RpcPeer, req: IncomingMessage, res: ServerResponse, rid: number): void {
  const sender = new CreditSender((f) => peer.send(f), rid);
  let headSent = false;
  let finished = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const touch = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, TUNNEL_STREAM_IDLE_MS);
    idleTimer.unref?.();
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    sender.abort();
    req.pause();
    peer.removeListener('frame', onFrame);
    peer.removeListener('close', onPeerClose);
  };

  function onIdle(): void {
    if (finished) return;
    sender.end('idle timeout');
    if (!headSent) {
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'gateway timeout' }));
    } else {
      res.destroy();
    }
    finish();
  }

  function onPeerClose(): void {
    if (finished) return;
    sender.abort();
    if (!headSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'hub unreachable' }));
    } else {
      res.destroy();
    }
    finish();
  }

  function onFrame(f: NodeFrame): void {
    if (f.t !== 'http.head' && f.t !== 'http.chunk' && f.t !== 'http.end' && f.t !== 'http.credit') return;
    if (f.rid !== rid) return;
    touch();
    switch (f.t) {
      case 'http.head': {
        if (f.status === undefined || headSent || finished) return;
        headSent = true;
        res.writeHead(f.status, filterResponseHeaders(f.headers, true));
        break;
      }
      case 'http.chunk': {
        if (!headSent || finished || res.writableEnded) return;
        const buf = Buffer.from(f.b64, 'base64');
        touch();
        const grant = (): void => {
          if (!finished) peer.send({ t: 'http.credit', rid, bytes: buf.length });
        };
        if (res.write(buf)) grant();
        else res.once('drain', grant);
        break;
      }
      case 'http.end': {
        if (finished) return;
        if (f.error !== undefined) {
          if (!headSent) {
            headSent = true;
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: f.error }));
          } else {
            res.destroy();
          }
        } else if (headSent && !res.writableEnded) {
          res.end();
        }
        finish();
        break;
      }
      case 'http.credit':
        sender.credit(f.bytes);
        break;
    }
  }

  touch();
  peer.on('frame', onFrame);
  peer.on('close', onPeerClose);

  peer.send({
    t: 'http.head',
    rid,
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    headers: flattenIncomingHeaders(req.headers),
  });

  req.on('data', (c: Buffer) => {
    touch();
    req.pause();
    void sender.write(c).then(
      () => { if (!finished) req.resume(); },
      () => undefined,
    );
  });
  req.on('end', () => { if (!finished) sender.end(); });
  // Client-side teardown. CreditSender.end is idempotent, so once the request
  // body ended cleanly a later error end would be swallowed — send the
  // teardown frame directly so the hub can kill the loopback exchange.
  let teardownSent = false;
  const teardown = (error: string): void => {
    if (finished || teardownSent) return;
    teardownSent = true;
    sender.abort();
    peer.send({ t: 'http.end', rid, error });
  };
  req.on('aborted', () => teardown('request aborted'));
  req.on('error', () => {
    if (!req.complete) teardown('request aborted');
  });
  res.on('close', () => {
    if (!finished) {
      teardown('client disconnected');
      finish();
    }
  });
  res.on('error', () => undefined);
}

interface HubStream {
  rid: number;
  method: string;
  body: PassThrough;
  sender: CreditSender;
  respond: Respond;
  received: number;
  declared: number | undefined;
  started: boolean;
  finished: boolean;
  idle: NodeJS.Timeout | undefined;
}

/** Hub side: turns a node's http.* frames into loopback requests and streams the responses back. */
export class HubStreamRouter {
  private readonly streams = new Map<number, HubStream>();

  constructor(
    private readonly hostId: string,
    private readonly peer: RpcPeer,
    private readonly replay: HubStreamReplay,
  ) {}

  get size(): number {
    return this.streams.size;
  }

  onFrame(f: NodeFrame): void {
    if (f.t === 'http.head' && f.method !== undefined) return this.onHead(f);
    if (f.t === 'http.chunk') return this.onChunk(f);
    if (f.t === 'http.end') return this.onEnd(f);
    if (f.t === 'http.credit') {
      const s = this.streams.get(f.rid);
      if (!s) return;
      this.touch(s);
      s.sender.credit(f.bytes);
    }
  }

  /** Peer connection dropped — tear down every live stream. */
  closeAll(): void {
    for (const s of [...this.streams.values()]) {
      s.finished = true;
      if (s.idle) clearTimeout(s.idle);
      s.body.destroy();
      s.respond.destroy?.();
      s.sender.abort();
      this.streams.delete(s.rid);
    }
  }

  private touch(s: HubStream): void {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => this.abort(s, 504, 'idle timeout'), TUNNEL_STREAM_IDLE_MS);
    s.idle.unref?.();
  }

  private sendEnd(rid: number, error?: string): void {
    this.peer.send({ t: 'http.end', rid, ...(error !== undefined ? { error } : {}) });
  }

  private rejectPlain(rid: number, status: number): void {
    this.peer.send({ t: 'http.head', rid, status, headers: { 'content-type': 'application/json' } });
    this.sendEnd(rid);
  }

  private onHead(f: Extract<NodeFrame, { t: 'http.head' }>): void {
    if (this.streams.has(f.rid)) return;
    const method = (f.method ?? 'GET').toUpperCase();
    const path = f.path ?? '/';
    if (!isTunnelPathAllowed(method, path)) return this.rejectPlain(f.rid, 404);
    if (this.streams.size >= TUNNEL_STREAM_MAX_PER_HOST) return this.rejectPlain(f.rid, 503);
    const declaredRaw = f.headers['content-length'];
    let declared: number | undefined;
    if (declaredRaw !== undefined && declaredRaw !== '') {
      const n = Number(declaredRaw);
      if (Number.isFinite(n) && n >= 0) declared = n;
    }
    if (declared !== undefined && declared > TUNNEL_STREAM_MAX_REQ_BYTES) {
      return this.rejectPlain(f.rid, 413);
    }
    const s: HubStream = {
      rid: f.rid,
      method,
      declared,
      received: 0,
      started: false,
      finished: false,
      body: new PassThrough({ highWaterMark: 64 * 1024 }),
      sender: new CreditSender((frame) => this.peer.send(frame), f.rid),
      idle: undefined,
      respond: undefined as unknown as Respond,
    };
    const respond: Respond = {
      head: (status, headers) => {
        if (s.finished || s.started) return;
        s.started = true;
        this.peer.send({ t: 'http.head', rid: s.rid, status, headers });
      },
      chunk: async (b) => {
        if (s.finished) return;
        this.touch(s);
        await s.sender.write(b);
      },
      end: (error) => {
        if (s.finished) return;
        s.finished = true;
        if (s.idle) clearTimeout(s.idle);
        this.streams.delete(s.rid);
        s.sender.end(error);
      },
    };
    s.respond = respond;
    this.streams.set(f.rid, s);
    this.touch(s);
    this.replay(this.hostId, { method, path, headers: f.headers }, s.body, respond);
  }

  private onChunk(f: Extract<NodeFrame, { t: 'http.chunk' }>): void {
    const s = this.streams.get(f.rid);
    if (!s || s.finished) return;
    this.touch(s);
    const buf = Buffer.from(f.b64, 'base64');
    if (s.method === 'GET' || s.method === 'HEAD') return this.abort(s, 400, 'request body not allowed');
    s.received += buf.length;
    if (s.declared !== undefined && s.received > s.declared) {
      return this.abort(s, 400, 'content-length mismatch');
    }
    if (s.received > TUNNEL_STREAM_MAX_REQ_BYTES) {
      return this.abort(s, 413, 'request body too large');
    }
    const grant = (): void => {
      if (!s.finished) this.peer.send({ t: 'http.credit', rid: s.rid, bytes: buf.length });
    };
    if (s.body.write(buf)) grant();
    else s.body.once('drain', grant);
  }

  private onEnd(f: Extract<NodeFrame, { t: 'http.end' }>): void {
    const s = this.streams.get(f.rid);
    if (!s || s.finished) return;
    if (s.declared !== undefined && s.received !== s.declared) {
      return this.abort(s, 400, 'content-length mismatch');
    }
    if (f.error !== undefined) {
      // Client went away mid-exchange (or the body aborted): kill the loopback
      // request/response — a plain body destroy is a no-op once the body ended.
      this.abort(s, 502, f.error);
      return;
    }
    s.body.end();
  }

  private abort(s: HubStream, status: number, message: string): void {
    if (s.finished) return;
    s.finished = true;
    if (s.idle) clearTimeout(s.idle);
    this.streams.delete(s.rid);
    s.body.destroy();
    s.respond.destroy?.();
    s.sender.abort();
    if (!s.started) {
      this.peer.send({ t: 'http.head', rid: s.rid, status, headers: { 'content-type': 'application/json' } });
      this.sendEnd(s.rid);
    } else {
      this.sendEnd(s.rid, message);
    }
  }
}
