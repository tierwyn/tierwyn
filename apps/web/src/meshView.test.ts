import { describe, it, expect } from 'vitest';
import { activeEdgeKeys, decisionInfo, filterEdges, filterMessages, mintedByLabel, type EdgeRow, type MsgRow } from './meshView.js';

const edge = (o: Partial<EdgeRow>): EdgeRow => ({
  id: 'e1', treeRoot: 'r', fromConversation: 'aaaaaaaa-1', toConversation: 'bbbbbbbb-2',
  mintedBy: 'operator', createdAt: 1, revokedAt: null, ...o,
});
const msg = (o: Partial<MsgRow>): MsgRow => ({
  id: 1, ts: 1, callerKind: 'agent', fromConversation: 'a', toConversation: 'b',
  decision: 'allowed_steer', durationMs: 5, error: null, ...o,
});

describe('meshView', () => {
  it('labels decisions and falls back to the raw value', () => {
    expect(decisionInfo('denied_hop_cap').label).toBe('Denied: hop limit');
    expect(decisionInfo('something_new')).toEqual({ label: 'something_new', tone: 'info' });
  });
  it('labels auto-minted edges', () => {
    expect(mintedByLabel('auto:1234')).toBe('auto (on spawn)');
  });
  it('filters edges by recent activity and multi-term search', () => {
    const edges = [
      edge({ id: 'x', fromConversation: 'a', toConversation: 'b', fromTitle: 'Implement runbooks', toTitle: 'Planner' }),
      edge({ id: 'y', fromConversation: 'c', toConversation: 'd', fromTitle: 'Other', toTitle: 'Planner' }),
    ];
    const now = 10 * 24 * 3600 * 1000;
    const active = activeEdgeKeys([
      msg({ ts: now - 1000, fromConversation: 'b', toConversation: 'a' }),
      msg({ ts: now - 1000, fromConversation: 'c', toConversation: 'd', decision: 'mint' }),
      msg({ ts: 1, fromConversation: 'c', toConversation: 'd' }),
    ], now);
    expect(filterEdges(edges, '', active).map((e) => e.id)).toEqual(['x']);
    expect(filterEdges(edges, '', null)).toHaveLength(2);
    expect(filterEdges(edges, 'runbooks planner', null).map((e) => e.id)).toEqual(['x']);
  });
  it('filters attempts by outcome and text', () => {
    const msgs = [
      msg({ id: 1, decision: 'allowed_steer', fromTitle: 'Alpha' }),
      msg({ id: 2, decision: 'denied_rate', fromTitle: 'Beta' }),
      msg({ id: 3, decision: 'mint' }),
    ];
    expect(filterMessages(msgs, '', 'denied').map((m) => m.id)).toEqual([2]);
    expect(filterMessages(msgs, '', 'delivered').map((m) => m.id)).toEqual([1]);
    expect(filterMessages(msgs, '', 'mint').map((m) => m.id)).toEqual([3]);
    expect(filterMessages(msgs, 'alpha', 'all').map((m) => m.id)).toEqual([1]);
    expect(filterMessages(msgs, 'rate limit', 'all').map((m) => m.id)).toEqual([2]);
  });
});
