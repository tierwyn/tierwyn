import { describe, it, expect } from 'vitest';
import type { CommandRecord } from '@tierwyn/shared';
import { mergeRemoteCommands } from './remoteCommands.js';

const row = (name: string, o: Partial<CommandRecord> = {}): CommandRecord => ({
  id: name, agentId: 'a', name, label: name, description: 'db', source: 'discovered',
  sourceDetail: 'skill', enabled: true, ...o,
});

describe('mergeRemoteCommands', () => {
  const db = [
    row('local-skill'),
    row('shared-skill'),
    row('off-skill', { enabled: false }),
    row('compact', { source: 'seed', sourceDetail: 'builtin' }),
    row('mine', { source: 'user', sourceDetail: null }),
  ];
  it('drops local skills the host did not report, keeps builtin/user', () => {
    const r = mergeRemoteCommands(db, [{ name: 'shared-skill', label: 'shared-skill', description: 'remote' }], 'a');
    expect(r.map((c) => c.name)).toEqual(['compact', 'mine', 'shared-skill']);
    expect(r.find((c) => c.name === 'shared-skill')!.description).toBe('remote');
  });
  it('honours disabled flag and adds host-only skills', () => {
    const r = mergeRemoteCommands(db, [
      { name: 'off-skill', label: 'off-skill' }, { name: 'host-only', label: 'host-only', sourceDetail: 'skill' },
    ], 'a');
    expect(r.map((c) => c.name)).toEqual(['compact', 'host-only', 'mine']);
  });
  it('host offline (empty remote) leaves only non-file-backed rows', () => {
    expect(mergeRemoteCommands(db, [], 'a').map((c) => c.name)).toEqual(['compact', 'mine']);
  });
  it('duplicate remote names yield one row', () => {
    const r = mergeRemoteCommands([], [{ name: 'x', label: 'x' }, { name: 'x', label: 'x' }], 'a');
    expect(r).toHaveLength(1);
  });
});
