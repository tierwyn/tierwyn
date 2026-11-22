import { describe, it, expect } from 'vitest';
import { resolveSpawnWorkdir } from '@tierwyn/shared';
import type { Workdir } from '@tierwyn/shared';
import type { WorkdirSource } from '@tierwyn/shared';

const cases: Array<{
  name: string;
  input: Parameters<typeof resolveSpawnWorkdir>[0];
  expectWorkdir: Workdir;
  expectSource: WorkdirSource;
  expectSuppressed?: { workdir: Workdir; source: WorkdirSource };
}> = [
  {
    name: 'empty → fallback',
    input: {},
    expectWorkdir: 'shared',
    expectSource: 'fallback',
  },
  {
    name: 'global only',
    input: { globalDefault: 'worktree' },
    expectWorkdir: 'worktree',
    expectSource: 'global-default',
  },
  {
    name: 'role beats global',
    input: { roleDefault: 'shared', globalDefault: 'worktree' },
    expectWorkdir: 'shared',
    expectSource: 'template-role',
  },
  {
    name: 'request beats role',
    input: { requestWorkdir: 'worktree', roleDefault: 'shared' },
    expectWorkdir: 'worktree',
    expectSource: 'request',
  },
  {
    name: 'pin beats request (loud)',
    input: { conversationPin: 'worktree', requestWorkdir: 'shared' },
    expectWorkdir: 'worktree',
    expectSource: 'conversation-pin',
    expectSuppressed: { workdir: 'shared', source: 'request' },
  },
  {
    name: 'pin beats role (no suppressed — same value)',
    input: { conversationPin: 'worktree', roleDefault: 'worktree' },
    expectWorkdir: 'worktree',
    expectSource: 'conversation-pin',
  },
  {
    name: 'pin, request agrees → no suppressed',
    input: { conversationPin: 'worktree', requestWorkdir: 'worktree' },
    expectWorkdir: 'worktree',
    expectSource: 'conversation-pin',
  },
  {
    name: 'manual beats pin (loud)',
    input: { manualChoice: 'shared', conversationPin: 'worktree' },
    expectWorkdir: 'shared',
    expectSource: 'manual-override',
    expectSuppressed: { workdir: 'worktree', source: 'conversation-pin' },
  },
  {
    name: 'manual agrees with pin → no suppressed',
    input: { manualChoice: 'worktree', conversationPin: 'worktree' },
    expectWorkdir: 'worktree',
    expectSource: 'manual-override',
  },
  {
    name: 'pin null is ignored',
    input: { conversationPin: null, requestWorkdir: 'shared' },
    expectWorkdir: 'shared',
    expectSource: 'request',
  },
];

describe('resolveSpawnWorkdir', () => {
  it.each(cases)('$name', ({ input, expectWorkdir, expectSource, expectSuppressed }) => {
    const result = resolveSpawnWorkdir(input);
    expect(result.workdir).toBe(expectWorkdir);
    expect(result.source).toBe(expectSource);
    if (expectSuppressed) {
      expect(result.suppressed).toEqual(expectSuppressed);
    } else {
      expect(result.suppressed).toBeUndefined();
    }
  });
});
