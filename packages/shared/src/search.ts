export type AgentSearchScopeSetting = 'off' | 'project' | 'all';

export interface ResolvedAgentSearchScope {
  effective: AgentSearchScopeSetting;
  source: 'project' | 'global';
  cappedBySandbox: boolean;
}

export function resolveAgentSearchScope(a: {
  projectScope?: AgentSearchScopeSetting | null;
  globalScope: AgentSearchScopeSetting;
  sandboxOn: boolean;
}): ResolvedAgentSearchScope {
  const source = a.projectScope ? 'project' : 'global';
  const base = a.projectScope ?? a.globalScope;
  const cappedBySandbox = a.sandboxOn && base === 'all';
  return { effective: cappedBySandbox ? 'project' : base, source, cappedBySandbox };
}

export interface AgentSearchMatch {
  eventId: string;
  type: 'prompt' | 'message' | 'helper';
  sender: 'user' | 'agent' | 'system' | 'helper';
  ts: number;
  snippet: string;
}

export interface AgentSearchHit {
  conversationId: string;
  projectId: string;
  projectName?: string;
  title: string;
  updatedAt: number;
  matches: AgentSearchMatch[];
}

export interface AgentSearchResponse {
  query: string;
  scope: 'project' | 'projects' | 'all';
  hits: AgentSearchHit[];
  note: string;
}

export interface AgentContextItem {
  eventId: string;
  type: 'prompt' | 'message' | 'helper' | 'tool_call' | 'tool_result';
  sender: 'user' | 'agent' | 'system' | 'helper';
  ts: number;
  text: string;
  isAnchor: boolean;
  truncated?: boolean;
}

export interface AgentConversationContextResponse {
  conversationId: string;
  projectId: string;
  title: string;
  anchorEventId: string;
  items: AgentContextItem[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  note: string;
}
