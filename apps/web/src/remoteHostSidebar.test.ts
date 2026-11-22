import { describe, expect, it } from 'vitest';
import type { RemoteHostView } from '@tierwyn/shared';
import {
  remoteHostAddedAs,
  remoteHostDetectedName,
  remoteHostMatchesSearch,
  remoteHostSidebarLabel,
  remoteHostSidebarTooltip,
} from './remoteHostSidebar.js';

const base: RemoteHostView = {
  id: 'h1',
  name: '192.168.1.116',
  state: 'connected',
  hello: { hostname: 'tierwyn-node-deb12', os: 'linux', arch: 'x64', homedir: '/home/tierhost', roots: [], listenPort: 0, agents: {}, models: {} },
  allowMcpSecrets: false,
  allowAgentEnvSecrets: false,
  createdAt: 1,
  description: ' Debian test VM ',
};

describe('remoteHostSidebar', () => {
  it('prefers detected hostname for label', () => {
    expect(remoteHostSidebarLabel(base)).toBe('tierwyn-node-deb12');
    expect(remoteHostSidebarLabel({ ...base, hello: {} })).toBe('192.168.1.116');
  });

  it('shows the added-as name in meta and tooltip', () => {
    expect(remoteHostAddedAs(base)).toBe('192.168.1.116');
    expect(remoteHostAddedAs({ ...base, hello: {} })).toBeUndefined();
    expect(remoteHostSidebarTooltip(base)).toBe('Added as: 192.168.1.116\nDescription: Debian test VM');
  });

  it('matches search on hostname, description and added-as name', () => {
    expect(remoteHostMatchesSearch(base, 'deb12')).toBe(true);
    expect(remoteHostMatchesSearch(base, '192.168.1.116')).toBe(true);
    expect(remoteHostMatchesSearch(base, 'debian test')).toBe(true);
    expect(remoteHostMatchesSearch(base, 'nomatch')).toBe(false);
    expect(remoteHostDetectedName(base)).toBe('tierwyn-node-deb12');
  });
});
