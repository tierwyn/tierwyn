export type BtwStatus = 'asking' | 'done' | 'error';

export interface BtwSettings {
  /** 'question-aware' prepends a focus instruction to the summariser;
   *  'generic' = current behaviour (no focus). */
  primingMode: 'question-aware' | 'generic';
  /** Override the profile used for the PRIMING (summariser) call.
   *  null = use compaction.preferredProfileId (current behaviour). */
  primingProfileId: string | null;
}

export interface BtwAvailability {
  ready: boolean;
  reason?: string;
}

export interface BtwQuery {
  id: string;
  parentConvId: string;
  childConvId: string | null;
  forkedConvId: string | null;
  question: string;
  answer: string | null;
  status: BtwStatus;
  agentId: string;
  model: string | null;
  errorMessage: string | null;
  /** ponytail: derived flag — not a DB column. Computed at read time:
   *  status==='done' && answer.trim().length < 15. Surfaces 'thin answer' badge. */
  degenerate?: boolean;
  createdAt: number;
  completedAt: number | null;
}
