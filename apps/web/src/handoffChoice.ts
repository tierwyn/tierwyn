import { MODEL_SWITCH_RESUME_ADAPTERS, type HandoffMode, type PendingHandoffMode } from '@tierwyn/shared';

export interface HandoffChoiceOptions { continue: boolean; fresh: boolean; summary: boolean; transcript: boolean }

/** Staged `+` menu action that lets a switch skip the modal: only when the modal would offer it. */
export function stagedHandoffSkip(staged: PendingHandoffMode | null | undefined, options: HandoffChoiceOptions): PendingHandoffMode | null {
  return staged && options[staged] ? staged : null;
}

/** Which cards the profile-switch modal offers. `continue` = keep the native session (same agent,
 *  resumable, adapter applies the new model on resume); the rest map to a HandoffOverride. */
export function handoffChoiceOptions(o: {
  fromAgent?: string; toAgent: string; nativeAvailable: boolean;
  handoffMode?: HandoffMode; fork?: boolean;
}): HandoffChoiceOptions {
  const both = o.fork || !o.handoffMode || o.handoffMode === 'prompt';
  return {
    continue: !o.fork && o.fromAgent === o.toAgent && o.nativeAvailable && MODEL_SWITCH_RESUME_ADAPTERS.has(o.toAgent),
    fresh: true,
    summary: both || o.handoffMode === 'summary',
    transcript: both || o.handoffMode === 'transcript',
  };
}
