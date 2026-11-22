import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryMeshRate, tryMeshCallerRate, tryMeshPeerListRate, resetMeshRateForTests,
  evictMeshRate, evictMeshCallerRate, evictMeshCallerRates, MESH_PEERS_PER_MINUTE,
} from './rate.js';

beforeEach(() => resetMeshRateForTests());

describe('tryMeshRate limit-at-try (M-5)', () => {
  it('picks up a lowered cap on the next try without reconstructing the bucket', () => {
    const edgeId = 'e1';
    for (let i = 0; i < 6; i++) {
      expect(tryMeshRate({ edgeId, perEdgeLimit: 6, fleetLimit: 100 }).ok).toBe(true);
    }
    expect(tryMeshRate({ edgeId, perEdgeLimit: 6, fleetLimit: 100 }).ok).toBe(false);
    // Settings lowered to 3: already 6 hits in the window, still denied.
    expect(tryMeshRate({ edgeId, perEdgeLimit: 3, fleetLimit: 100 }).ok).toBe(false);
  });

  it('picks up a raised cap without restart', () => {
    const edgeId = 'e2';
    expect(tryMeshRate({ edgeId, perEdgeLimit: 1, fleetLimit: 100 }).ok).toBe(true);
    expect(tryMeshRate({ edgeId, perEdgeLimit: 1, fleetLimit: 100 }).ok).toBe(false);
    expect(tryMeshRate({ edgeId, perEdgeLimit: 2, fleetLimit: 100 }).ok).toBe(true);
  });

  it('evicts a revoked edge so a reused id starts a fresh window', () => {
    const edgeId = 'e3';
    expect(tryMeshRate({ edgeId, perEdgeLimit: 1, fleetLimit: 100 }).ok).toBe(true);
    expect(tryMeshRate({ edgeId, perEdgeLimit: 1, fleetLimit: 100 }).ok).toBe(false);
    evictMeshRate(edgeId);
    expect(tryMeshRate({ edgeId, perEdgeLimit: 1, fleetLimit: 100 }).ok).toBe(true);
  });
});

describe('tryMeshCallerRate (M-3)', () => {
  it('denies the (limit+1)th call in a window', () => {
    const callerId = 'c1';
    expect(tryMeshCallerRate({ callerId, limit: 2 }).ok).toBe(true);
    expect(tryMeshCallerRate({ callerId, limit: 2 }).ok).toBe(true);
    const third = tryMeshCallerRate({ callerId, limit: 2 });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retryAfter).toBeGreaterThan(0);
  });
});

describe('evictMeshCallerRate (cascade)', () => {
  it('evicts a per-caller flood bucket so the next try starts a fresh window', () => {
    const callerId = 'c-evict';
    expect(tryMeshCallerRate({ callerId, limit: 1 }).ok).toBe(true);
    expect(tryMeshCallerRate({ callerId, limit: 1 }).ok).toBe(false);
    evictMeshCallerRate(callerId);
    expect(tryMeshCallerRate({ callerId, limit: 1 }).ok).toBe(true);
  });

  it('evicts the peer-list bucket for the same conversation id', () => {
    const callerId = 'c-peers';
    for (let i = 0; i < MESH_PEERS_PER_MINUTE; i++) {
      expect(tryMeshPeerListRate({ callerId }).ok).toBe(true);
    }
    expect(tryMeshPeerListRate({ callerId }).ok).toBe(false);
    evictMeshCallerRate(callerId);
    expect(tryMeshPeerListRate({ callerId }).ok).toBe(true);
  });

  it('bulk-evicts both maps for the conversation ids the cascade collapses', () => {
    expect(tryMeshCallerRate({ callerId: 'a', limit: 1 }).ok).toBe(true);
    expect(tryMeshCallerRate({ callerId: 'b', limit: 1 }).ok).toBe(true);
    expect(tryMeshPeerListRate({ callerId: 'a' }).ok).toBe(true);
    expect(tryMeshCallerRate({ callerId: 'a', limit: 1 }).ok).toBe(false);
    expect(tryMeshCallerRate({ callerId: 'b', limit: 1 }).ok).toBe(false);
    evictMeshCallerRates(['a', 'b']);
    expect(tryMeshCallerRate({ callerId: 'a', limit: 1 }).ok).toBe(true);
    expect(tryMeshCallerRate({ callerId: 'b', limit: 1 }).ok).toBe(true);
    expect(tryMeshPeerListRate({ callerId: 'a' }).ok).toBe(true);
  });
});
