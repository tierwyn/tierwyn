export type MemoryKind = 'gotcha' | 'decision' | 'fact';
export type MemoryStatus = 'active' | 'flagged' | 'superseded';
export type MemoryRuleSuggestion = 'pending' | 'dismissed' | 'promoted';
export type MemoryFlagCategory = 'addressed_to_agents' | 'task_chatter' | 'secret_like' | 'irrelevant_recall';

export const MEMORY_LIMITS = {
  text: 500,
  ruleReason: 200,
  savesPerHour: 20,
  pendingSuggestionsPerProject: 5,
} as const;

const ID_RE = /^m_([1-9]\d*)$/;

export function formatMemoryId(n: number): string {
  return `m_${n}`;
}

export function parseMemoryId(s: string): number | null {
  const m = ID_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

export interface MemoryDto {
  id: string;
  projectId: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  supersededBy: string | null;
  ruleSuggestion: MemoryRuleSuggestion | null;
  ruleReason: string | null;
  flagReason: MemoryFlagCategory | null;
  createdByAgent: string | null;
  createdByConversation: string | null;
  /** Null once retention has purged the source conversation. */
  createdByConversationTitle: string | null;
  createdAt: number;
}

export interface MemoryCounts {
  pendingSuggestions: number;
  flagged: number;
}

export interface SaveMemoryRequest {
  kind: MemoryKind;
  text: string;
  suggestRule?: boolean;
  ruleReason?: string;
}

export interface SimilarMemory {
  id: string;
  text: string;
}

export interface SaveMemoryResponse {
  id: string;
  similar: SimilarMemory[];
  hint?: string;
  ruleSuggestion?: 'pending' | 'rejected';
  warning?: string;
}

export interface SearchMemoryResponse {
  note: string;
  memories: Array<Pick<MemoryDto, 'id' | 'kind' | 'text' | 'createdAt'>>;
}

export interface ListMemoriesResponse {
  memories: MemoryDto[];
  counts: MemoryCounts;
}
