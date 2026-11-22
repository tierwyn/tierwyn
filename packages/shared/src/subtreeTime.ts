export interface SubtreeTimeNode {
  conversationId: string;
  parentConversationId: string | null; // null only for the root
  title: string;
  depth: number; // 0 = root
  workedMs: number; // Σ per-turn elapsed, this node only
  turns: number;
  lastEventTs: number | null;
}

export interface SubtreeTimeSummary {
  rootConversationId: string;
  selfMs: number; // root's own workedMs (not window-limited)
  descendantsMs: number; // Σ workedMs of nodes with depth > 0
  totalMs: number; // selfMs + descendantsMs
  descendantCount: number; // nodes.length − 1 (kept, not omitted)
  truncated: boolean;
  omittedCount: number;
  nodes: SubtreeTimeNode[]; // root first, then breadth-first
  computedAt: number;
}
