import { describe, it, expect, afterEach } from 'vitest';
import type { AgentAdapter } from '@tierwyn/shared';
import { registry } from './registry.js';

const local = { tag: 'local' } as unknown as AgentAdapter;
const remote = { tag: 'remote' } as unknown as AgentAdapter;

afterEach(() => {
  registry.setRemoteFactory(undefined);
});

describe('AdapterRegistry remote branch', () => {
  it('create without remoteHostId uses local factory', () => {
    registry.register('t12-probe', () => local);
    expect(registry.create('t12-probe')).toBe(local);
    expect(registry.create('t12-probe', { interactionMode: 'bypass' })).toBe(local);
  });

  it('create with remoteHostId uses remote factory', () => {
    registry.register('t12-probe', () => local);
    const seen: { type: string; host: string }[] = [];
    registry.setRemoteFactory((type, opts) => {
      seen.push({ type, host: opts.remoteHostId });
      return remote;
    });
    expect(registry.create('t12-probe', { remoteHostId: 'host-1' })).toBe(remote);
    expect(seen).toEqual([{ type: 't12-probe', host: 'host-1' }]);
  });

  it('throws when remote factory is unset', () => {
    registry.register('t12-probe', () => local);
    expect(() => registry.create('t12-probe', { remoteHostId: 'host-1' }))
      .toThrow('remote hosts not initialised');
  });
});
