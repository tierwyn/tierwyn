import { describe, it, expect, vi } from 'vitest';
import type { ResolvedMcpServer } from '@tierwyn/shared';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BRIDGE_HEADER, bridgeServers, lookupBridgeKey, revokeBridgeKeysForSession } from './bridge.js';
import { getOrCreateHubPipe, peekHubPipe } from './hubPipe.js';

const agentServer = (): ResolvedMcpServer => ({
  id: 'local',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'srv'],
  env: {},
  headers: {},
  secretEnvKeys: [],
  secretHeaderKeys: [],
});

const hubServer = (): ResolvedMcpServer => ({
  id: 'web',
  transport: 'http',
  url: 'https://hub.internal/mcp',
  args: [],
  env: {},
  headers: { Authorization: 'Bearer sk-1' },
  secretEnvKeys: [],
  secretHeaderKeys: ['Authorization'],
  placement: 'hub',
});

const ctx = { conversationId: 'c1', sessionId: 's1', hostId: 'rh-1', listenPort: 8788 };

describe('bridge', () => {
  it('rewrites hub servers to the tunnel url with a per-session key; agent servers untouched', () => {
    const out = bridgeServers([agentServer(), hubServer()], ctx)!;
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id === 'local')).toEqual(agentServer());
    const bridged = out.find((s) => s.id === 'web')!;
    expect(bridged.transport).toBe('http');
    expect(bridged.url).toBe('http://127.0.0.1:8788/agent/mcp/web');
    expect(bridged.placement).toBe('hub');
    expect(bridged.headers[BRIDGE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(bridged.secretHeaderKeys).toEqual([BRIDGE_HEADER]);
  });

  it('no hub servers → input returned unchanged', () => {
    const inServers = [agentServer()];
    expect(bridgeServers(inServers, ctx)).toBe(inServers);
    expect(bridgeServers(undefined, ctx)).toBeUndefined();
  });

  it('the rewritten server leaks neither the original url, the header secret, nor lookup metadata', () => {
    const out = bridgeServers([hubServer()], ctx)!;
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('hub.internal');
    expect(blob).not.toContain('Bearer sk-1');
    expect(blob).not.toContain('Authorization');
    const key = out[0]!.headers[BRIDGE_HEADER];
    expect(lookupBridgeKey(key)).toEqual({ conversationId: 'c1', sessionId: 's1', hostId: 'rh-1', serverIds: ['web'] });
  });

  it('revokeBridgeKeysForSession kills the key; a re-mint invalidates the old one', () => {
    const k1 = bridgeServers([hubServer()], ctx)![0]!.headers[BRIDGE_HEADER];
    expect(lookupBridgeKey(k1)).toBeDefined();
    revokeBridgeKeysForSession('s1');
    expect(lookupBridgeKey(k1)).toBeUndefined();
    const k2 = bridgeServers([hubServer()], ctx)![0]!.headers[BRIDGE_HEADER];
    expect(k2).not.toBe(k1);
    expect(lookupBridgeKey(k1)).toBeUndefined();
    expect(lookupBridgeKey(k2)).toMatchObject({ sessionId: 's1', serverIds: ['web'] });
  });

  it('revoke closes the session hub pipes (other sessions untouched)', async () => {
    const closed: string[] = [];
    const fakeTransport = (tag: string): Transport => ({
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => { closed.push(tag); }),
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
    });
    await getOrCreateHubPipe({ sessionId: 's1', serverId: 'web' }, () => fakeTransport('s1'));
    await getOrCreateHubPipe({ sessionId: 's2', serverId: 'web' }, () => fakeTransport('s2'));
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
    try {
      revokeBridgeKeysForSession('s1');
      await flush();
      expect(peekHubPipe({ sessionId: 's1', serverId: 'web' })).toBeUndefined();
      expect(peekHubPipe({ sessionId: 's2', serverId: 'web' })).toBeDefined();
      expect(closed).toEqual(['s1']);
    } finally {
      revokeBridgeKeysForSession('s1');
      revokeBridgeKeysForSession('s2');
      await flush();
    }
    expect(closed).toEqual(['s1', 's2']);
  });
});
