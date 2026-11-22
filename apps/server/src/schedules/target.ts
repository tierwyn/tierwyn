import type { Database } from 'better-sqlite3';
import type { ExecutionMode, Project, RemoteHostView, Workdir } from '@tierwyn/shared';
import {
  agentTakesBarePrompt,
  profileAvailableOnHost,
  REMOTE_AGENTS_PROJECT_ID,
  SCHEDULE_INHERIT_PROFILE_ID,
} from '@tierwyn/shared';
import { catalogue } from '../catalogue.js';
import { getConversation } from '../repositories/conversations.js';
import { getRemoteAgentBotId } from '../repositories/remoteAgents.js';
import { lastSessionForConversation } from '../repositories/sessions.js';

export interface ScheduleTargetInput {
  project: Project;
  executionMode: ExecutionMode;          // effective (create body ?? 'spawn_child'; PATCH → job value)
  profileId: string;                     // effective
  boundConversationId?: string | null;   // effective
  packSlug?: string;
  templateName?: string | null;
  steps?: unknown[] | undefined;
  workdir?: Workdir;
  agentMayComplete?: boolean;
  /** Live host view for remote-project availability (Task 11). */
  hostView?: RemoteHostView;
}

export type ScheduleTargetResult =
  | { ok: true; profileId: string }      // possibly rewritten (Task 8 pins Bots)
  | { ok: false; status: 400 | 409 | 501; error: string; code?: string; reason?: string };

/** Job fields the PATCH overlay reads for target validation. */
export interface ScheduleTargetJobSnapshot {
  profileId: string;
  executionMode: ExecutionMode;
  boundConversationId?: string | null;
  templateName?: string | null;
  workdir?: Workdir;
  agentMayComplete?: boolean;
  packSlug?: string | null;
}

/** Presence-aware PATCH overlay. Absent keys keep the stored job value. */
export interface ScheduleTargetPatchFields {
  profileId?: string;
  workdir?: Workdir;
  templateName?: string | null;
  agentMayComplete?: boolean;
  boundConversationId?: string | null;
  /** When `stepsKeyPresent`, this list (incl. `[]`) overlays stored steps. */
  steps?: unknown[];
  stepsKeyPresent?: boolean;
}

function bareUnsupported(field: string, label: string): ScheduleTargetResult {
  return {
    ok: false,
    status: 400,
    error: `${field} is not supported for ${label} (bare-prompt agent)`,
    code: 'bare_prompt_unsupported',
  };
}

/** Bare-prompt field gate used by create and by post-pin re-checks. */
function barePromptFieldErrors(
  input: ScheduleTargetInput,
  label: string,
): ScheduleTargetResult | null {
  if (input.packSlug?.trim()) {
    return bareUnsupported('pack', label);
  }
  if (typeof input.templateName === 'string' && input.templateName.trim()) {
    return bareUnsupported('delegation template', label);
  }
  if (Array.isArray(input.steps) && input.steps.length > 0) {
    return bareUnsupported('plan steps', label);
  }
  if (input.workdir === 'worktree') {
    return bareUnsupported('worktree workdir', label);
  }
  if (input.agentMayComplete === true) {
    return bareUnsupported('agent-may-complete', label);
  }
  return null;
}

/**
 * After Bot pinning may rewrite `inherit` / `grok-bot:default` → `grok-bot:<botId>`,
 * re-run bare-prompt field checks against the pinned profile. The create path
 * skips the bare block for `inherit`; PATCH bound-only / inherit branches call
 * pinning directly — this is the last gate before ok.
 */
function recheckBareAfterPin(
  input: ScheduleTargetInput,
  pinnedProfileId: string,
): ScheduleTargetResult | null {
  const rewritten =
    input.profileId === SCHEDULE_INHERIT_PROFILE_ID
    || input.profileId === 'grok-bot:default'
    || input.profileId !== pinnedProfileId;
  if (!rewritten) return null;
  const pinnedProfile = catalogue.getProfile(pinnedProfileId);
  if (!pinnedProfile || !agentTakesBarePrompt(pinnedProfile.agentType)) return null;
  return barePromptFieldErrors(input, pinnedProfile.label);
}

function normTemplate(t: string | null | undefined): string | null {
  if (t == null || t === '') return null;
  return t;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasBoundId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.trim().length > 0;
}

/** Create/PATCH host gate for concrete profiles on remote projects (H2).
 *  Callers that omit the `hostView` key (step-replace) skip this gate —
 *  fire-time dispatch is the enforcement point that matters for offline hosts.
 *  Callers that pass `hostView: undefined` (create with no view) still 400. */
function hostAvailabilityError(input: ScheduleTargetInput): ScheduleTargetResult | null {
  if (!input.project.remoteHostId) return null;
  if (!Object.prototype.hasOwnProperty.call(input, 'hostView')) return null;
  if (input.profileId === SCHEDULE_INHERIT_PROFILE_ID) return null;
  const profile = catalogue.getProfile(input.profileId);
  if (!profile) return null;
  const avail = profileAvailableOnHost(profile, input.hostView);
  if (!avail.ok) {
    return {
      ok: false,
      status: 400,
      error: 'not available on host',
      reason: avail.reason,
    };
  }
  return null;
}

/**
 * Bound-conversation rules for `resume_conversation` (create + PATCH rebind).
 * Returns an error string or null when valid.
 */
export function validateBoundConversationForResume(
  db: Database,
  projectId: string,
  boundConversationId: string | null | undefined,
): string | null {
  if (!hasBoundId(boundConversationId)) {
    return 'boundConversationId required for resume_conversation';
  }
  const conv = getConversation(db, boundConversationId);
  if (!conv) {
    return 'bound conversation not found';
  }
  if (conv.projectId !== projectId) {
    return 'bound conversation must belong to this project';
  }
  if (conv.archived) {
    return 'bound conversation is archived';
  }
  if (conv.kind != null && conv.kind !== 'chat') {
    return 'cannot bind a schedule run conversation';
  }
  // Walk ancestors: reject schedule_home and any conversation inside a schedule tree.
  let cursor: string | undefined = conv.parentConversationId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const ancestor = getConversation(db, cursor);
    if (!ancestor) break;
    if (ancestor.kind === 'schedule_home') {
      return 'cannot bind a schedule run conversation';
    }
    cursor = ancestor.parentConversationId;
  }
  return null;
}

export function validateScheduleTarget(db: Database, input: ScheduleTargetInput): ScheduleTargetResult {
  const isInherit = input.profileId === SCHEDULE_INHERIT_PROFILE_ID;

  if (isInherit) {
    if (input.executionMode !== 'resume_conversation') {
      return {
        ok: false,
        status: 400,
        error: 'inherit profile requires resume_conversation',
      };
    }
  } else {
    const profile = catalogue.getProfile(input.profileId);
    if (!profile || !profile.enabled) {
      return { ok: false, status: 400, error: `unknown or disabled profile: ${input.profileId}` };
    }

    if (input.project.id === REMOTE_AGENTS_PROJECT_ID && profile.agentType !== 'grok-bot') {
      return {
        ok: false,
        status: 400,
        error: 'Remote Agents project only accepts grok-bot profiles',
      };
    }

    if (agentTakesBarePrompt(profile.agentType)) {
      const bareErr = barePromptFieldErrors(input, profile.label);
      if (bareErr) return bareErr;
    }

    // H2/D6: create-time host availability for concrete profiles on remote projects.
    // inherit is checked at fire only (after resolveJobProfile).
    const hostErr = hostAvailabilityError(input);
    if (hostErr) return hostErr;
  }

  if (input.executionMode === 'resume_conversation') {
    const boundErr = validateBoundConversationForResume(
      db,
      input.project.id,
      input.boundConversationId,
    );
    if (boundErr) {
      return { ok: false, status: 400, error: boundErr };
    }
  } else if (hasBoundId(input.boundConversationId)) {
    return {
      ok: false,
      status: 400,
      error: 'boundConversationId only valid for resume_conversation',
    };
  }

  // Bot pinning / resume-only (after Task 1–4 field rules).
  return applyGrokBotScheduleRules(db, input);
}

/**
 * Grok Bot + Remote Agents schedule rules (Task 8).
 * Agent-created jobs stay spawn_child (D8), so an agent can never schedule a
 * Bot (R5) — this gate rejects spawn_child for grok-bot / Remote Agents.
 */
export function applyGrokBotScheduleRules(
  db: Database,
  input: ScheduleTargetInput,
): ScheduleTargetResult {
  const isRemoteAgents = input.project.id === REMOTE_AGENTS_PROJECT_ID;
  const isInherit = input.profileId === SCHEDULE_INHERIT_PROFILE_ID;

  let agentType: string | undefined;
  if (isInherit) {
    if (hasBoundId(input.boundConversationId)) {
      agentType = lastSessionForConversation(db, input.boundConversationId)?.agentId;
    }
  } else {
    agentType = catalogue.getProfile(input.profileId)?.agentType;
  }

  const isGrokBot = agentType === 'grok-bot';
  if (!isGrokBot && !isRemoteAgents) {
    return { ok: true, profileId: input.profileId };
  }

  if (input.executionMode === 'spawn_child') {
    return {
      ok: false,
      status: 400,
      error: 'Grok Bot schedules must send to an existing conversation',
      code: 'grok_bot_requires_resume',
    };
  }

  if (!hasBoundId(input.boundConversationId)) {
    return {
      ok: false,
      status: 400,
      error: 'bound conversation has no Grok Bot yet — send it a message first',
      code: 'grok_bot_unbound',
    };
  }

  let botId: string | undefined;
  if (isRemoteAgents) {
    botId = getRemoteAgentBotId(db, input.boundConversationId);
  } else {
    botId = lastSessionForConversation(db, input.boundConversationId, { agentId: 'grok-bot' })
      ?.nativeSessionId;
  }

  if (!botId) {
    return {
      ok: false,
      status: 400,
      error: 'bound conversation has no Grok Bot yet — send it a message first',
      code: 'grok_bot_unbound',
    };
  }

  const pinned = `grok-bot:${botId}`;
  // Reject an explicit pin to a different Bot than the bound conversation owns.
  if (
    !isInherit
    && input.profileId !== 'grok-bot:default'
    && input.profileId.startsWith('grok-bot:')
    && input.profileId !== pinned
  ) {
    return {
      ok: false,
      status: 400,
      error: `conversation is bound to grok-bot:${botId}`,
    };
  }

  const pinnedProfile = catalogue.getProfile(pinned);
  if (!pinnedProfile || !pinnedProfile.enabled) {
    return {
      ok: false,
      status: 400,
      error: `${pinned} not in catalogue — refresh agents`,
    };
  }

  // Rewrite inherit / grok-bot:default so the stored job never follows the open app chat.
  // When the rewrite changes the effective profile, re-check bare-prompt fields
  // (create skips them for inherit; PATCH inherit / bound-only call this directly).
  const bareErr = recheckBareAfterPin(input, pinned);
  if (bareErr) return bareErr;
  return { ok: true, profileId: pinned };
}

/**
 * PATCH semantics for schedule targets (legacy-tolerant).
 * - No relevant value change → skip (rename / unchanged-values keep legacy steps).
 * - Staying bare-prompt → reject only fields the patch changes into violation.
 * - Moving into bare-prompt → strict-validate the full effective input.
 * Bound / executionMode immutability are enforced in the PATCH route (Task 4).
 */
export function validateScheduleTargetPatch(
  db: Database,
  input: {
    project: Project;
    job: ScheduleTargetJobSnapshot;
    storedSteps: unknown[];
    patch: ScheduleTargetPatchFields;
    /** Live host view when the PATCH changes profile (or full re-validate). */
    hostView?: RemoteHostView;
  },
): ScheduleTargetResult {
  const { project, job, storedSteps, patch, hostView } = input;
  const profileChanged = hasOwn(patch, 'profileId') && patch.profileId !== job.profileId;
  const workdirChanged = hasOwn(patch, 'workdir') && patch.workdir !== (job.workdir ?? 'shared');
  const templateChanged = hasOwn(patch, 'templateName')
    && normTemplate(patch.templateName) !== normTemplate(job.templateName);
  const mayCompleteChanged = hasOwn(patch, 'agentMayComplete')
    && patch.agentMayComplete !== Boolean(job.agentMayComplete);
  const boundChanged = hasOwn(patch, 'boundConversationId')
    && patch.boundConversationId !== job.boundConversationId;
  const stepsKeyPresent = Boolean(patch.stepsKeyPresent);
  const relevantChanged = profileChanged || workdirChanged || templateChanged || mayCompleteChanged;

  // Rename / unchanged-values: keep legacy steps. Bound-only rebind still
  // re-runs Bot pinning below so a Bot job cannot drift to another Bot id.
  if (!relevantChanged && !stepsKeyPresent && !boundChanged) {
    return { ok: true, profileId: job.profileId };
  }

  const effProfileId = hasOwn(patch, 'profileId') ? String(patch.profileId) : job.profileId;
  const effWorkdir = (hasOwn(patch, 'workdir') ? patch.workdir : job.workdir) ?? 'shared';
  const effTemplate = hasOwn(patch, 'templateName') ? patch.templateName : job.templateName;
  const effMayComplete = hasOwn(patch, 'agentMayComplete')
    ? patch.agentMayComplete
    : job.agentMayComplete;
  const effBound = hasOwn(patch, 'boundConversationId')
    ? patch.boundConversationId
    : job.boundConversationId;
  const effSteps = stepsKeyPresent ? (patch.steps ?? []) : storedSteps;

  const effectiveInput: ScheduleTargetInput = {
    project,
    executionMode: job.executionMode,
    profileId: effProfileId,
    boundConversationId: effBound,
    packSlug: job.packSlug ?? undefined,
    templateName: effTemplate,
    steps: effSteps,
    workdir: effWorkdir,
    agentMayComplete: effMayComplete,
    hostView,
  };

  // Bound-only change: re-pin, then bare-check effective fields (including
  // stored steps the create-time inherit skip may have let through, or legacy
  // values that become violations once the job is pinned bare).
  if (!relevantChanged && !stepsKeyPresent && boundChanged) {
    const pin = applyGrokBotScheduleRules(db, effectiveInput);
    if (!pin.ok) return pin;
    const pinnedProfile = catalogue.getProfile(pin.profileId);
    if (pinnedProfile && agentTakesBarePrompt(pinnedProfile.agentType)) {
      const bareErr = barePromptFieldErrors(effectiveInput, pinnedProfile.label);
      if (bareErr) return bareErr;
    }
    return pin;
  }

  // inherit skips catalogue / bare-prompt checks; only valid on resume jobs.
  // Bot pinning rewrites + re-checks bare fields against the pinned profile.
  if (effProfileId === SCHEDULE_INHERIT_PROFILE_ID) {
    if (job.executionMode !== 'resume_conversation') {
      return {
        ok: false,
        status: 400,
        error: 'inherit profile requires resume_conversation',
      };
    }
    return applyGrokBotScheduleRules(db, effectiveInput);
  }

  const preProfile = catalogue.getProfile(job.profileId);
  const wasBare = agentTakesBarePrompt(preProfile?.agentType);
  const postProfile = catalogue.getProfile(effProfileId);
  const nowBare = agentTakesBarePrompt(postProfile?.agentType);
  const movingIntoRestriction = !wasBare && nowBare;

  if (movingIntoRestriction) {
    // Full create-time validation (includes Bot pinning).
    return validateScheduleTarget(db, effectiveInput);
  }

  // Profile identity / Remote Agents / enabled — always when profileId key present
  // or when we need a label for bare change-checks.
  if (relevantChanged || stepsKeyPresent) {
    if (!postProfile || !postProfile.enabled) {
      return { ok: false, status: 400, error: `unknown or disabled profile: ${effProfileId}` };
    }
    if (project.id === REMOTE_AGENTS_PROJECT_ID && postProfile.agentType !== 'grok-bot') {
      return {
        ok: false,
        status: 400,
        error: 'Remote Agents project only accepts grok-bot profiles',
      };
    }
  }

  if (nowBare) {
    const label = postProfile?.label ?? 'bare-prompt agent';
    if (hasOwn(patch, 'templateName') && typeof patch.templateName === 'string' && patch.templateName.trim()) {
      return bareUnsupported('delegation template', label);
    }
    if (hasOwn(patch, 'workdir') && patch.workdir === 'worktree') {
      return bareUnsupported('worktree workdir', label);
    }
    if (hasOwn(patch, 'agentMayComplete') && patch.agentMayComplete === true) {
      return bareUnsupported('agent-may-complete', label);
    }
    if (stepsKeyPresent && Array.isArray(patch.steps) && patch.steps.length > 0) {
      return bareUnsupported('plan steps', label);
    }
  }

  // Rebind or profile change on a Bot job re-runs pinning on the effective input.
  if (profileChanged || boundChanged || project.id === REMOTE_AGENTS_PROJECT_ID || nowBare) {
    const pin = applyGrokBotScheduleRules(db, effectiveInput);
    if (!pin.ok) return pin;
    if (profileChanged) {
      const hostErr = hostAvailabilityError({ ...effectiveInput, profileId: pin.profileId });
      if (hostErr) return hostErr;
    }
    return pin;
  }

  if (profileChanged) {
    const hostErr = hostAvailabilityError(effectiveInput);
    if (hostErr) return hostErr;
  }

  return { ok: true, profileId: effProfileId };
}
