import { MinuteBucket } from '../plugins/host.js';

const perEdge = new Map<string, MinuteBucket>();
const fleet = new Map<string, MinuteBucket>();
const perCaller = new Map<string, MinuteBucket>();
const peerList = new Map<string, MinuteBucket>();

/** Generous enough that a legitimate sender never hits it; tight enough to
 *  cap a denial-flood into `mesh_messages`. Not a Settings key. */
export const MESH_CALLER_PER_MINUTE = 60;

/** GET /agent/mesh/peers — hardcoded, not a Settings key. Keyed by caller
 *  conversation id, or `'operator'` for cookie callers. */
export const MESH_PEERS_PER_MINUTE = 12;

/** In-memory circuit-breakers. Restart clearing a window is not a security event.
 *  Limits are passed into try() so a Settings change applies on the next send. */
export function tryMeshRate(opts: {
  edgeId: string;
  perEdgeLimit: number;
  fleetLimit: number;
  now?: () => number;
}): { ok: true } | { ok: false; retryAfter: number } {
  const now = opts.now ?? (() => Date.now());
  let edge = perEdge.get(opts.edgeId);
  if (!edge) {
    edge = new MinuteBucket(opts.perEdgeLimit, now);
    perEdge.set(opts.edgeId, edge);
  }
  const edgeHit = edge.try(opts.perEdgeLimit);
  if (!edgeHit.ok) return edgeHit;
  let global = fleet.get('global');
  if (!global) {
    global = new MinuteBucket(opts.fleetLimit, now);
    fleet.set('global', global);
  }
  return global.try(opts.fleetLimit);
}

/** Per-caller-conversation flood cap, checked before canMessage() so denials
 *  themselves are throttled. Does not spend a per-edge token. */
export function tryMeshCallerRate(opts: {
  callerId: string;
  limit?: number;
  now?: () => number;
}): { ok: true } | { ok: false; retryAfter: number } {
  const now = opts.now ?? (() => Date.now());
  const limit = opts.limit ?? MESH_CALLER_PER_MINUTE;
  let bucket = perCaller.get(opts.callerId);
  if (!bucket) {
    bucket = new MinuteBucket(limit, now);
    perCaller.set(opts.callerId, bucket);
  }
  return bucket.try(limit);
}

/** Peer-list GET throttle. Same try-time limit semantics as tryMeshCallerRate. */
export function tryMeshPeerListRate(opts: {
  callerId: string;
  limit?: number;
  now?: () => number;
}): { ok: true } | { ok: false; retryAfter: number } {
  const now = opts.now ?? (() => Date.now());
  const limit = opts.limit ?? MESH_PEERS_PER_MINUTE;
  let bucket = peerList.get(opts.callerId);
  if (!bucket) {
    bucket = new MinuteBucket(limit, now);
    peerList.set(opts.callerId, bucket);
  }
  return bucket.try(limit);
}

export function evictMeshRate(edgeId: string): void {
  perEdge.delete(edgeId);
}

export function evictMeshRates(edgeIds: string[]): void {
  for (const id of edgeIds) perEdge.delete(id);
}

/** Drop per-caller flood + peer-list buckets for one conversation (or `'operator'`). */
export function evictMeshCallerRate(callerId: string): void {
  perCaller.delete(callerId);
  peerList.delete(callerId);
}

export function evictMeshCallerRates(callerIds: string[]): void {
  for (const id of callerIds) evictMeshCallerRate(id);
}

/** Test helper: drop in-memory buckets. */
export function resetMeshRateForTests(): void {
  perEdge.clear();
  fleet.clear();
  perCaller.clear();
  peerList.clear();
}
