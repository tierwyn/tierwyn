import { sign, type KeyObject } from 'crypto';
import WebSocket from 'ws';
import { authPayload, type NodeFrame, type NodeHello } from '@tierwyn/shared';
import type { NodeConfig } from './policy.js';
import { RpcPeer, wsTransport, type FrameTransport } from './rpc.js';
import type { NodeRuntime } from './runtime.js';

/** Hub close codes that mean "don't hammer" — retry at the 30s backoff cap. */
const CAP_CLOSE = new Set([4401, 4403, 4408, 4409, 4426]);

export interface NodeClientDeps {
  config: NodeConfig;
  privateKey: KeyObject;
  hubOrigin: string;
  buildHello: () => Promise<NodeHello>;
  runtime: NodeRuntime;
  connect?: (url: string) => FrameTransport;
  backoffMs?: (attempt: number) => number;
}

export function startNodeClient(deps: NodeClientDeps): {
  stop(): void;
  peer(): RpcPeer | undefined;
  /** Hub-advertised features (`tunnel.stream`, …); empty until probed or on old hubs. */
  features(): Set<string>;
} {
  const backoff = deps.backoffMs ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** attempt));
  const connect = deps.connect ?? ((url: string) => wsTransport(new WebSocket(url)));
  const url = nodeWsUrl(deps.config.hubUrl);

  let stopped = false;
  let attempt = 0;
  let peer: RpcPeer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let features = new Set<string>();

  function schedule(code?: number, reason?: string): void {
    if (stopped) return;
    // Awaiting operator Trust: poll faster so the click takes effect within ~10s.
    const delay = code === 4403 && reason === 'untrusted' ? 10_000
      : code !== undefined && CAP_CLOSE.has(code) ? 30_000 : backoff(attempt);
    attempt += 1;
    if (code === 4401 || code === 4403) {
      console.error('not trusted / bad key — waiting');
    }
    timer = setTimeout(() => { void dial(); }, delay);
  }

  const logConnected = () => console.log(`connected to hub ${deps.hubOrigin} as ${deps.config.hostId}`);

  async function dial(): Promise<void> {
    if (stopped) return;
    features = new Set();
    let closeCode: number | undefined;
    let closeReason: string | undefined;
    const helloPromise = deps.buildHello();
    const inner = connect(url);
    const transport: FrameTransport = {
      send: (text) => inner.send(text),
      onText: (cb) => inner.onText(cb),
      onClose: (cb) => inner.onClose((code, reason) => {
        closeCode = code;
        closeReason = String(reason ?? '');
        cb(code, reason);
      }),
      close: (code, reason) => inner.close(code, reason),
    };
    const p = new RpcPeer(transport, deps.runtime.handlers());
    peer = p;
    let handed = false;
    p.on('frame', (f: NodeFrame) => {
      if (f.t !== 'challenge' || handed) return;
      handed = true;
      void (async () => {
        try {
          const sig = sign(
            null,
            Buffer.from(authPayload(f.nonce, deps.config.hostId, deps.hubOrigin)),
            deps.privateKey,
          ).toString('base64url');
          p.send({ t: 'auth', hostId: deps.config.hostId, sig });
          const hello = await helloPromise;
          p.send({ t: 'hello', hello });
          deps.runtime.attach(p);
          deps.runtime.setLoginEmitter((ev) => {
            void p.request('agents.loginEvent', ev).catch(() => {});
          });
          attempt = 0;
          // Probe hub capabilities; old hubs answer no_method → empty set (buffered tunnel fallback).
          void p.request<{ features?: string[] }>('hub.features', undefined, 10_000)
            .then((r) => { features = new Set(r?.features ?? []); logConnected(); })
            .catch((err: { code?: string }) => {
              features = new Set();
              // Any answer (old hubs: no_method) proves the hub accepted auth; an untrusted
              // node is closed (4403) after auth, which rejects this as `disconnected`.
              if (err?.code !== 'disconnected' && err?.code !== 'timeout') logConnected();
            });
        } catch (err) {
          console.error('node handshake failed', err);
          p.close();
        }
      })();
    });
    p.on('close', () => {
      if (peer === p) peer = undefined;
      deps.runtime.detach();
      schedule(closeCode, closeReason);
    });
  }

  void dial();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      const cur = peer;
      peer = undefined;
      cur?.close();
      deps.runtime.detach();
    },
    peer: () => peer,
    features: () => features,
  };
}

function nodeWsUrl(hubUrl: string): string {
  const u = new URL(hubUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  u.pathname = '/ws/node';
  u.search = '';
  u.hash = '';
  return u.toString();
}
