import { describe, it, expect } from 'vitest';
import {
  REMOTE_PATHS_DISABLED_NOTICE,
  REMOTE_PATHS_RO_NOTICE,
  REMOTE_PATHS_UPDATE_NOTICE,
  gateRemoteSandboxPaths,
} from './remotePaths.js';
import type { SandboxPath } from '@tierwyn/shared';

const paths: SandboxPath[] = [{ path: '/work/models', mode: 'ro' }];

describe('gateRemoteSandboxPaths', () => {
  it('passes paths through when the node advertises sandbox_paths', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'global',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'ro' } },
    });
    expect(out.sandboxPaths).toEqual(paths);
    expect(out.notice).toBeUndefined();
  });

  it('old node + inherited on → drop paths and notice', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'global',
      on: true,
      hello: { features: ['sandbox'] },
    });
    expect(out.sandboxPaths).toBeUndefined();
    expect(out.notice).toBe(REMOTE_PATHS_UPDATE_NOTICE);
  });

  it('old node + explicit conversation on → keep paths (proxy 501s)', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'conversation',
      on: true,
      hello: { features: ['sandbox'] },
    });
    expect(out.sandboxPaths).toEqual(paths);
    expect(out.notice).toBeUndefined();
  });

  it('old node + explicit project on → keep paths', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'project',
      on: true,
      hello: { features: ['sandbox'] },
    });
    expect(out.sandboxPaths).toEqual(paths);
  });

  it('allow none + inherited → drop paths and notice', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'agent',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'none' } },
    });
    expect(out.sandboxPaths).toBeUndefined();
    expect(out.notice).toBe(REMOTE_PATHS_DISABLED_NOTICE);
  });

  it('allow none + explicit → keep paths (node rejects)', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'conversation',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'none' } },
    });
    expect(out.sandboxPaths).toEqual(paths);
  });

  it('allow ro + inherited rw → drop rw paths and notice', () => {
    const mixed: SandboxPath[] = [
      { path: '/work/models', mode: 'ro' },
      { path: '/work/cache', mode: 'rw' },
    ];
    const out = gateRemoteSandboxPaths({
      paths: mixed,
      source: 'global',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'ro' } },
    });
    expect(out.sandboxPaths).toEqual([{ path: '/work/models', mode: 'ro' }]);
    expect(out.notice).toBe(REMOTE_PATHS_RO_NOTICE);
  });

  it('allow ro + inherited all-rw → drop all paths and notice', () => {
    const out = gateRemoteSandboxPaths({
      paths: [{ path: '/work/cache', mode: 'rw' }],
      source: 'agent',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'ro' } },
    });
    expect(out.sandboxPaths).toBeUndefined();
    expect(out.notice).toBe(REMOTE_PATHS_RO_NOTICE);
  });

  it('allow ro + explicit rw → keep paths (node rejects)', () => {
    const rw: SandboxPath[] = [{ path: '/work/cache', mode: 'rw' }];
    const out = gateRemoteSandboxPaths({
      paths: rw,
      source: 'conversation',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'ro' } },
    });
    expect(out.sandboxPaths).toEqual(rw);
    expect(out.notice).toBeUndefined();
  });

  it('allow ro + inherited ro-only → pass through with no notice', () => {
    const out = gateRemoteSandboxPaths({
      paths,
      source: 'global',
      on: true,
      hello: { features: ['sandbox', 'sandbox_paths'], sandboxPaths: { allow: 'ro' } },
    });
    expect(out.sandboxPaths).toEqual(paths);
    expect(out.notice).toBeUndefined();
  });

  it('sandbox off or empty paths → nothing', () => {
    expect(gateRemoteSandboxPaths({
      paths,
      source: 'conversation',
      on: false,
      hello: { features: ['sandbox_paths'] },
    })).toEqual({});
    expect(gateRemoteSandboxPaths({
      paths: [],
      source: 'conversation',
      on: true,
      hello: { features: ['sandbox_paths'] },
    })).toEqual({});
  });
});
