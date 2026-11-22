/** Order-aware interaction-card resolve: a requestId is not permanently dead. */

export type InteractionEventLike = {
  type: string;
  payload?: unknown;
};

function payloadRequestId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { requestId?: unknown }).requestId;
  return typeof id === 'string' && id ? id : undefined;
}

export function lastResolveIndexByRequestId(
  events: readonly InteractionEventLike[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e?.type !== 'interaction_resolved') continue;
    const id = payloadRequestId(e.payload);
    if (id) map.set(id, i);
  }
  return map;
}

export function isInteractionRequestResolved(
  requestId: string,
  eventIndex: number,
  lastResolveById: Map<string, number>,
): boolean {
  const j = lastResolveById.get(requestId);
  return j !== undefined && j > eventIndex;
}

function payloadResolution(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const r = (payload as { resolution?: unknown }).resolution;
  return typeof r === 'string' ? r : undefined;
}

/** requestIds that already have an `answered` resolve in this transcript. */
export function answeredInteractionRequestIds(
  events: readonly InteractionEventLike[],
): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e?.type !== 'interaction_resolved') continue;
    if (payloadResolution(e.payload) !== 'answered') continue;
    const id = payloadRequestId(e.payload);
    if (id) ids.add(id);
  }
  return ids;
}

/** Hide a later auto/expired echo when the operator already answered this card. */
export function isRedundantAutoResolve(
  event: InteractionEventLike,
  answeredIds?: ReadonlySet<string>,
): boolean {
  if (event?.type !== 'interaction_resolved') return false;
  const resolution = payloadResolution(event.payload);
  if (resolution !== 'auto' && resolution !== 'expired') return false;
  const id = payloadRequestId(event.payload);
  return !!id && !!answeredIds?.has(id);
}
