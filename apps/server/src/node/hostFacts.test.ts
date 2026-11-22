import { describe, it, expect } from 'vitest';
import { hostname as osHostname } from 'os';
import type { RemoteHostView } from '@tierwyn/shared';
import { hostFacts, remoteHostNote, type HostFacts } from './hostFacts.js';

describe('hostFacts', () => {
  it('local uses os.hostname and local port', () => {
    expect(hostFacts({}, 8787)).toEqual({ hostname: osHostname(), port: 8787 });
  });

  it('remote uses hello hostname and listenPort', () => {
    const view = (id: string): RemoteHostView | undefined => id === 'h1'
      ? {
          id: 'h1',
          name: 'box',
          state: 'disconnected',
          hello: { hostname: 'rh-t14-host', os: 'linux', listenPort: 9999 },
          allowMcpSecrets: true,
          createdAt: 0,
        }
      : undefined;
    expect(hostFacts({ remoteHostId: 'h1' }, 8787, view)).toEqual({
      hostname: 'rh-t14-host',
      port: 9999,
      remote: { hostId: 'h1', os: 'linux' },
    });
  });

  it('remote reads artifactsRoot from hello', () => {
    const view = (id: string): RemoteHostView | undefined => id === 'h1'
      ? {
          id: 'h1',
          name: 'box',
          state: 'disconnected',
          hello: { hostname: 'rh-t14-host', os: 'linux', listenPort: 9999, artifactsRoot: '/n/artifacts' },
          allowMcpSecrets: true,
          createdAt: 0,
        }
      : undefined;
    expect(hostFacts({ remoteHostId: 'h1' }, 8787, view).remote).toEqual({
      hostId: 'h1',
      os: 'linux',
      artifactsRoot: '/n/artifacts',
    });
  });
});

describe('remoteHostNote', () => {
  it('exact copy', () => {
    const note = remoteHostNote(
      { hostname: 'rh-t14-host', port: 9999, remote: { hostId: 'h1', os: 'linux' } },
      '/tmp/r',
    );
    expect(note).toBe(
      'You are running on host `rh-t14-host` (`linux`), working directory `/tmp/r`. All of your tools execute on this machine. The Tierwyn server is reachable at `http://127.0.0.1:9999` from here.',
    );
  });

  it('appends the artifacts clause when artifactsRoot and conversationId are set', () => {
    const f: HostFacts = {
      hostname: 'rh-t14-host', port: 9999,
      remote: { hostId: 'h1', os: 'linux', artifactsRoot: '/n/artifacts' },
    };
    const note = remoteHostNote(f, '/tmp/r', 'c1');
    expect(note.endsWith(
      ' Tierwyn artifacts for this conversation live in `/n/artifacts/c1/` on this host.',
    )).toBe(true);
    expect(note).toContain('`/n/artifacts/c1/`');
  });

  it('no artifacts clause without a conversation id', () => {
    const f: HostFacts = {
      hostname: 'rh-t14-host', port: 9999,
      remote: { hostId: 'h1', os: 'linux', artifactsRoot: '/n/artifacts' },
    };
    expect(remoteHostNote(f, '/tmp/r')).not.toContain('artifacts');
  });
});
