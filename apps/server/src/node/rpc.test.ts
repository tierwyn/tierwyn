import { EventEmitter } from 'events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { decodeFrame, memoryPair, RpcError, RpcPeer, wsTransport } from './rpc.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RpcPeer', () => {
  it('request/response round-trip both directions over memoryPair', async () => {
    const [a, b] = memoryPair();
    const peerA = new RpcPeer(a, { ping: async () => 'pong-a' });
    const peerB = new RpcPeer(b, { ping: async () => 'pong-b' });
    expect(await peerA.request('ping')).toBe('pong-b');
    expect(await peerB.request('ping')).toBe('pong-a');
    peerA.close();
    peerB.close();
  });

  it("unknown method → RpcError code 'no_method'", async () => {
    const [a, b] = memoryPair();
    const peerA = new RpcPeer(a, {});
    const peerB = new RpcPeer(b, {});
    await expect(peerA.request('nope')).rejects.toMatchObject({ code: 'no_method' });
    peerA.close();
    peerB.close();
  });

  it('handler throw → ok:false with message, no stack', async () => {
    const [a, b] = memoryPair();
    const peerA = new RpcPeer(a, {});
    const peerB = new RpcPeer(b, {
      boom: async () => {
        throw new Error('fail');
      },
    });
    try {
      await peerA.request('boom');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      const err = e as RpcError;
      expect(err.message).toBe('fail');
      expect(err.message.includes('at ')).toBe(false);
    }
    peerA.close();
    peerB.close();
  });

  it("request times out with code 'timeout'", async () => {
    const [a, b] = memoryPair();
    const peerA = new RpcPeer(a, {}, { timeoutMs: 30 });
    const peerB = new RpcPeer(b, { slow: () => new Promise(() => {}) });
    await expect(peerA.request('slow')).rejects.toMatchObject({ code: 'timeout' });
    peerA.close();
    peerB.close();
  });

  it('timeoutMs 0 parks until the handler resolves (no timer)', async () => {
    vi.useFakeTimers();
    const [a, b] = memoryPair();
    let resolveSlow!: (v: string) => void;
    const peerA = new RpcPeer(a, {});
    const peerB = new RpcPeer(b, {
      slow: () => new Promise<string>((r) => { resolveSlow = r; }),
    });
    const pending = peerA.request<string>('slow', undefined, 0);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    resolveSlow('ok');
    await expect(pending).resolves.toBe('ok');
    peerA.close();
    peerB.close();
  });

  it("close rejects all pending with code 'disconnected'", async () => {
    const [a, b] = memoryPair();
    const peerA = new RpcPeer(a, {});
    new RpcPeer(b, { slow: () => new Promise(() => {}) });
    const pending = peerA.request('slow');
    peerA.close();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });

  it("decodeFrame returns null for {t:'bogus'} and for a 17 MiB string", () => {
    expect(decodeFrame(JSON.stringify({ t: 'bogus' }))).toBeNull();
    expect(decodeFrame('x'.repeat(17 * 1024 * 1024))).toBeNull();
  });

  it("decodeFrame returns null for {t:'res',id:1,ok:false} without e", () => {
    expect(decodeFrame(JSON.stringify({ t: 'res', id: 1, ok: false }))).toBeNull();
  });

  it("req with m:'constructor' gets no_method", async () => {
    const [a, b] = memoryPair();
    const peerA = new RpcPeer(a, {});
    const peerB = new RpcPeer(b, {});
    await expect(peerA.request('constructor')).rejects.toMatchObject({ code: 'no_method' });
    peerA.close();
    peerB.close();
  });

  it('wsTransport swallows WebSocket error events and fires onClose once instead of crashing', () => {
    const fakeWs = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    }) as unknown as import('ws').WebSocket;
    const t = wsTransport(fakeWs);
    const closes: Array<{ code?: number; reason?: string }> = [];
    t.onClose((code, reason) => closes.push({ code, reason }));

    // Should not throwUnhandledError when ws emits 'error' (e.g. HTTP 504 on handshake)
    expect(() => fakeWs.emit('error', new Error('Unexpected server response: 504'))).not.toThrow();
    fakeWs.emit('close', 1006, Buffer.from(''));
    expect(closes).toHaveLength(1);
    expect(closes[0]?.code).toBe(1006);
  });
});
