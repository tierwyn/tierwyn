import { describe, it, expect } from 'vitest';
import type { Conversation } from '@tierwyn/shared';
import {
  PINNED_PROJECT_ID,
  pinnedPseudoProject,
  collectPinnedConversations,
  groupPinnedItems,
} from './pinned.js';

function conv(over: Partial<Conversation> & { id: string; projectId: string }): Conversation {
  return {
    title: over.id,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Conversation;
}

describe('pinnedPseudoProject', () => {
  it('is a system project with a non-UUID id that cannot collide with a real project', () => {
    const p = pinnedPseudoProject();
    expect(p.id).toBe(PINNED_PROJECT_ID);
    expect(p.system).toBe(true);
    expect(p.name).toBe('Pinned');
    expect(p.id).not.toMatch(/^[0-9a-f]{8}-/i);
  });
});

describe('collectPinnedConversations', () => {
  it('returns nothing for empty input', () => {
    expect(collectPinnedConversations({})).toEqual([]);
    expect(collectPinnedConversations({ a: [] })).toEqual([]);
  });

  it('returns a pinned root with its full transitive subtree', () => {
    const root = conv({ id: 'r', projectId: 'a', pinned: true });
    const kid = conv({ id: 'k', projectId: 'a', parentConversationId: 'r' });
    const grand = conv({ id: 'g', projectId: 'a', parentConversationId: 'k' });
    const other = conv({ id: 'o', projectId: 'a' });
    const out = collectPinnedConversations({ a: [root, kid, grand, other] });
    expect(out.map((c) => c.id).sort()).toEqual(['g', 'k', 'r']);
  });

  it('ignores a pinned child whose root is not pinned', () => {
    const root = conv({ id: 'r', projectId: 'a' });
    const kid = conv({ id: 'k', projectId: 'a', parentConversationId: 'r', pinned: true });
    expect(collectPinnedConversations({ a: [root, kid] })).toEqual([]);
  });

  it('spans multiple projects', () => {
    const ra = conv({ id: 'ra', projectId: 'a', pinned: true });
    const rb = conv({ id: 'rb', projectId: 'b', pinned: true });
    const kb = conv({ id: 'kb', projectId: 'b', parentConversationId: 'rb' });
    const out = collectPinnedConversations({ a: [ra], b: [rb, kb] });
    expect(out.map((c) => c.id).sort()).toEqual(['kb', 'ra', 'rb']);
  });

  it('returns archived pinned roots (downstream filters decide visibility)', () => {
    const root = conv({ id: 'r', projectId: 'a', pinned: true, archived: true });
    expect(collectPinnedConversations({ a: [root] }).map((c) => c.id)).toEqual(['r']);
  });

  it('terminates on a parent cycle reachable from a pinned root and emits each id at most once', () => {
    // Unique-id single-parent graphs cannot cycle from a root (each node has
    // one parentConversationId). This duplicate-id child closes a → b → a in
    // the children map — the malformed case `seen` exists to stop. Deleting
    // `seen` makes this recurse forever / blow the stack.
    const root = conv({ id: 'root', projectId: 'p', pinned: true });
    const a = conv({ id: 'a', projectId: 'p', parentConversationId: 'root' });
    const b = conv({ id: 'b', projectId: 'p', parentConversationId: 'a' });
    const aAgain = conv({ id: 'a', projectId: 'p', parentConversationId: 'b' });
    const out = collectPinnedConversations({ p: [root, a, b, aAgain] });
    expect(out.map((c) => c.id)).toEqual(['root', 'a', 'b']);
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
  });
});

describe('groupPinnedItems', () => {
  const names = { a: 'Alpha', b: 'Beta' };

  it('returns nothing for empty input', () => {
    expect(groupPinnedItems([], names, {})).toEqual([]);
  });

  it('leaves single-pin projects flat and labels them with a chip', () => {
    const rows = [
      { c: conv({ id: 'ra', projectId: 'a', pinned: true }), depth: 0 },
      { c: conv({ id: 'rb', projectId: 'b', pinned: true }), depth: 0 },
    ];
    expect(groupPinnedItems(rows, names, {})).toEqual([
      { kind: 'row', c: rows[0].c, depth: 0, projectLabel: 'Alpha' },
      { kind: 'row', c: rows[1].c, depth: 0, projectLabel: 'Beta' },
    ]);
  });

  it('groups a project with two pinned roots, indenting the whole subtree', () => {
    const r1 = conv({ id: 'r1', projectId: 'a', pinned: true });
    const k1 = conv({ id: 'k1', projectId: 'a', parentConversationId: 'r1' });
    const r2 = conv({ id: 'r2', projectId: 'a', pinned: true });
    const rows = [
      { c: r1, depth: 0 },
      { c: k1, depth: 1 },
      { c: r2, depth: 0 },
    ];
    expect(groupPinnedItems(rows, names, {})).toEqual([
      { kind: 'group', projectId: 'a', projectName: 'Alpha', count: 2, collapsed: false },
      { kind: 'row', c: r1, depth: 1 },
      { kind: 'row', c: k1, depth: 2 },
      { kind: 'row', c: r2, depth: 1 },
    ]);
  });

  it('emits only the header for a collapsed group', () => {
    const r1 = conv({ id: 'r1', projectId: 'a', pinned: true });
    const r2 = conv({ id: 'r2', projectId: 'a', pinned: true });
    const rows = [{ c: r1, depth: 0 }, { c: r2, depth: 0 }];
    expect(groupPinnedItems(rows, names, { a: true })).toEqual([
      { kind: 'group', projectId: 'a', projectName: 'Alpha', count: 2, collapsed: true },
    ]);
  });

  it('orders projects by first appearance and makes each project contiguous', () => {
    const ra1 = conv({ id: 'ra1', projectId: 'a', pinned: true });
    const rb = conv({ id: 'rb', projectId: 'b', pinned: true });
    const ra2 = conv({ id: 'ra2', projectId: 'a', pinned: true });
    const rows = [{ c: ra1, depth: 0 }, { c: rb, depth: 0 }, { c: ra2, depth: 0 }];
    expect(groupPinnedItems(rows, names, {})).toEqual([
      { kind: 'group', projectId: 'a', projectName: 'Alpha', count: 2, collapsed: false },
      { kind: 'row', c: ra1, depth: 1 },
      { kind: 'row', c: ra2, depth: 1 },
      { kind: 'row', c: rb, depth: 0, projectLabel: 'Beta' },
    ]);
  });

  it('falls back to the project id when the name is unknown', () => {
    const r = conv({ id: 'r', projectId: 'zz', pinned: true });
    expect(groupPinnedItems([{ c: r, depth: 0 }], names, {})).toEqual([
      { kind: 'row', c: r, depth: 0, projectLabel: 'zz' },
    ]);
  });

  it('keeps an orphan child (depth > 0 before any root) rather than dropping it', () => {
    const orphan = conv({ id: 'k', projectId: 'a', parentConversationId: 'missing' });
    expect(groupPinnedItems([{ c: orphan, depth: 0 }], names, {})).toEqual([
      { kind: 'row', c: orphan, depth: 0, projectLabel: 'Alpha' },
    ]);
  });
});
