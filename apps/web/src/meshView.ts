export type EdgeRow = {
  id: string; treeRoot: string; fromConversation: string; toConversation: string;
  mintedBy: string; createdAt: number; revokedAt: number | null;
  fromTitle?: string; toTitle?: string; fromDetail?: string; toDetail?: string; fromDescription?: string; toDescription?: string; relation?: string;
};
export type MsgRow = {
  id: number; ts: number; callerKind: string; fromConversation: string; toConversation: string;
  decision: string; hop?: number; bytes?: number; durationMs: number; error: string | null;
  fromTitle?: string; toTitle?: string; fromDetail?: string; toDetail?: string; fromDescription?: string; toDescription?: string; relation?: string;
};

export type DecisionTone = 'ok' | 'wait' | 'deny' | 'info';
export type AttemptFilter = 'all' | 'delivered' | 'denied' | 'mint';

const DECISIONS: Record<string, { label: string; tone: DecisionTone }> = {
  mint: { label: 'Edge minted', tone: 'info' },
  allowed_steer: { label: 'Delivered (steered)', tone: 'ok' },
  allowed_interrupt: { label: 'Delivered (interrupt)', tone: 'ok' },
  delivered_new_turn: { label: 'Delivered (new turn)', tone: 'ok' },
  delivered_deferred: { label: 'Delivered (from queue)', tone: 'ok' },
  deferred_pending: { label: 'Queued (peer busy)', tone: 'wait' },
  dropped_no_session: { label: 'Dropped (no session)', tone: 'deny' },
  delivery_error: { label: 'Delivery error', tone: 'deny' },
  denied_too_large: { label: 'Denied: too large', tone: 'deny' },
  denied_no_edge: { label: 'Denied: no edge', tone: 'deny' },
  denied_wrong_tree: { label: 'Denied: different tree', tone: 'deny' },
  denied_hop_cap: { label: 'Denied: hop limit', tone: 'deny' },
  denied_rate: { label: 'Denied: rate limit', tone: 'deny' },
  denied_revoked: { label: 'Denied: edge revoked', tone: 'deny' },
  denied_scope: { label: 'Denied: token scope', tone: 'deny' },
};

export function decisionInfo(decision: string): { label: string; tone: DecisionTone } {
  return DECISIONS[decision] ?? { label: decision, tone: 'info' };
}

export function mintedByLabel(mintedBy: string): string {
  if (mintedBy.startsWith('auto:')) return 'auto (on spawn)';
  if (mintedBy.startsWith('agent:')) return 'agent';
  return mintedBy;
}

export function convLabel(title: string | undefined, id: string): string {
  const t = title?.trim();
  return t ? t : id.slice(0, 8);
}

function matches(haystack: Array<string | undefined>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack.filter(Boolean).join('\n').toLowerCase();
  return terms.every((t) => text.includes(t));
}

export const ACTIVE_WINDOW_MS = 24 * 3600 * 1000;

/** Edges (either direction) that carried a real message attempt recently. ponytail: only sees the loaded attempts, not full history. */
export function activeEdgeKeys(messages: MsgRow[], now = Date.now()): Set<string> {
  const keys = new Set<string>();
  for (const m of messages) {
    if (m.decision === 'mint' || m.ts < now - ACTIVE_WINDOW_MS) continue;
    keys.add(`${m.fromConversation}>${m.toConversation}`);
    keys.add(`${m.toConversation}>${m.fromConversation}`);
  }
  return keys;
}

export function filterEdges(edges: EdgeRow[], query: string, activeKeys: Set<string> | null): EdgeRow[] {
  return edges.filter((e) =>
    (!activeKeys || activeKeys.has(`${e.fromConversation}>${e.toConversation}`))
    && matches([e.fromTitle, e.toTitle, e.fromConversation, e.toConversation, e.id, mintedByLabel(e.mintedBy), e.fromDetail, e.toDetail, e.fromDescription, e.toDescription, e.relation], query));
}

export function filterMessages(messages: MsgRow[], query: string, filter: AttemptFilter): MsgRow[] {
  return messages.filter((m) => {
    const d = m.decision;
    if (filter === 'delivered' && !(decisionInfo(d).tone === 'ok' || d === 'deferred_pending')) return false;
    if (filter === 'denied' && decisionInfo(d).tone !== 'deny') return false;
    if (filter === 'mint' && d !== 'mint') return false;
    return matches([m.fromTitle, m.toTitle, m.fromConversation, m.toConversation, decisionInfo(d).label, d, m.error ?? undefined, m.callerKind, m.fromDetail, m.toDetail, m.fromDescription, m.toDescription, m.relation], query);
  });
}

/** One-line context: relation plus project/role of each side. */
export function pairDetail(r: { fromDetail?: string; toDetail?: string; fromDescription?: string; toDescription?: string; relation?: string }): string {
  const sides = [r.fromDetail, r.toDetail].filter(Boolean).join(' → ');
  return [r.relation, sides].filter(Boolean).join(' · ');
}

/** "From: …" / "To: …" description lines, clipped. */
export function descLines(r: { fromDescription?: string; toDescription?: string }): string[] {
  const clip = (t: string) => (t.length > 140 ? `${t.slice(0, 140)}…` : t);
  return [r.fromDescription && `From: ${clip(r.fromDescription)}`, r.toDescription && `To: ${clip(r.toDescription)}`].filter(Boolean) as string[];
}

export function formatBytes(n: number | undefined): string {
  if (n == null) return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
