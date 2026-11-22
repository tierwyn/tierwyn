import type { Express } from 'express';
import { existsSync } from 'fs';
import os from 'os';
import type { Database } from 'better-sqlite3';
import type {
  Conversation,
  UpdateConversationRequest,
  RewindConversationRequest,
  CreateCheckpointRequest,
  UpdateCheckpointRequest,
  CheckpointsResponse,
  GetDraftResponse,
  PutDraftRequest,
  PutDraftResponse,
  PromptAttachment,
  ServerFrame,
  DraftProcessing,
  DraftBusyResponse,
  UndoEnhanceResponse,
} from '@tierwyn/shared';
import { canonicalCapabilityProfileId, normaliseTags, parseOptionalDesignation, isKnownDesignation, REMOTE_AGENTS_PROJECT_ID, validateMcpIdList, resolveSandbox, sandboxChain, unionSandboxPaths } from '@tierwyn/shared';
import {
  renameConversation, setConversationTemplate, setConversationSpawnWorkdir, setConversationPinned, setConversationArchived, setConversationDescription, deleteConversation,
  markConversationUnread, markConversationViewed, markConversationsViewed, forkConversation, getConversation, listDescendants, moveConversationTree,
  updateConversationTags, duplicateConversation, setConversationDesignation, setConversationCapabilityProfile, setConversationMcpServers,
  setConversationPermissionMode, setConversationEffort, EFFORT_PREFERENCES, setConversationSandbox, setConversationPendingHandoffMode, setConversationRules,
  setConversationRulePresetIds,
} from '../repositories/conversations.js';
import { describeRulesLayers, loadRules, normaliseRules, renderedRules } from '../spawn/rules.js';
import { normalisePresetIds } from '../repositories/rulePresets.js';
import { getCapabilityProfile, getDefaultCapabilityProfileId } from '../repositories/capabilityProfiles.js';
import { refreshConversationCapabilityTokens } from '../spawn/capabilityRefresh.js';
import { unlinkTtsWavPaths } from '../repositories/ttsRecordings.js';
import { rmAttachmentShards } from './files.js';
import { getTemplate, listCustomDesignations } from '../repositories/settings.js';
import { listEventsForConversation, getEvent, deleteTurnEventsByIds } from '../repositories/events.js';
import { getProject } from '../repositories/projects.js';
import { getRemoteHost, remoteHostIdFor } from '../repositories/remoteHosts.js';
import { getSandboxSettings } from '../repositories/sandboxSettings.js';
import { sandboxCapability } from '../sandbox/capability.js';
import { dbPathFromEnv } from '../config/env.js';
import { annotateEffectivePaths, hubDataDir, hubTierwynRoot } from '../sandbox/customPaths.js';
import { renderConversationMarkdown, exportFilename } from '../conversationExport.js';
import { getSession, lastSessionForConversation, setNativeSessionId } from '../repositories/sessions.js';
import {
  listCheckpoints, createCheckpoint, getCheckpoint, deleteCheckpoint, updateCheckpoint, getCheckpointByEvent,
} from '../repositories/checkpoints.js';
import {
  getDraft, upsertDraft, setDraftProfile, deleteDraft, undoEnhance,
  effectiveProcessing, getProcessing, draftCanUndo,
} from '../repositories/drafts.js';
import { regenerateConversationDescription } from '../conversationDescribe.js';
import { nativeTurnIndex, rewindConversationToEvent } from '../repositories/rewind.js';
import { snapshotCodeForCheckpoint, recordPreRestoreCheckpoint } from '../checkpointService.js';
import { assertValidRemoteAgentProfile } from '../repositories/remoteAgents.js';
import {
  resolveConversationCwd, evaluateCodeRewindGate, deleteShadowRef, codeDiff,
} from '../git/shadowCheckpoint.js';
import { localShadowOpsFor } from '../git/shadowOps.js';
import { checkpointOpsFor } from '../git/checkpointOps.js';
import { WorkingTreeContextError } from '../git/remoteOps.js';
import { createAdapterFor } from '../node/proxyAdapter.js';
import type { SessionManager } from '../sessionManager.js';

export interface ConversationRouteDeps {
  getDb: () => Database;
  sessionManager?: SessionManager;
  broadcast?: (conversationId: string, frame: ServerFrame) => void;
  broadcastAll?: (frame: ServerFrame) => void;
  notifyConversationUpdated?: (conversationId: string) => void;
  dataDir?: string;
}

function notifyCheckpoints(deps: ConversationRouteDeps, conversationId: string): void {
  deps.broadcast?.(conversationId, { type: 'checkpoints_updated', conversationId });
  deps.notifyConversationUpdated?.(conversationId);
}

function sendAsyncRouteError(res: import('express').Response, err: unknown): void {
  if (res.headersSent) return;
  const status = err instanceof WorkingTreeContextError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_DRAFT_ATTACHMENTS_TOTAL = 20 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;

export type ValidateAttachmentsResult =
  | { ok: true; json: string; attachments: PromptAttachment[] }
  | { ok: false; reason: string };

/** Shared with the prompt-timer route: a timer snapshot uses the same caps as a
 *  draft (10 files / 5 MiB each / 20 MiB total). One validator, one set of numbers. */
export function validateDraftAttachments(atts: unknown): ValidateAttachmentsResult {
  if (atts === undefined) {
    return { ok: true, json: '[]', attachments: [] };
  }
  if (!Array.isArray(atts)) {
    return { ok: false, reason: 'attachments must be an array' };
  }
  if (atts.length > MAX_ATTACHMENT_COUNT) {
    return { ok: false, reason: 'too many attachments' };
  }
  let totalBytes = 0;
  const parsed: PromptAttachment[] = [];
  for (const att of atts) {
    if (typeof att !== 'object' || att === null) {
      return { ok: false, reason: 'invalid attachment' };
    }
    const { base64, mediaType, name } = att as Record<string, unknown>;
    if (typeof base64 !== 'string' || typeof mediaType !== 'string') {
      return { ok: false, reason: 'invalid attachment fields' };
    }
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, reason: 'invalid attachment name' };
    }
    let decodedLen: number;
    try {
      decodedLen = Buffer.from(base64, 'base64').length;
    } catch {
      return { ok: false, reason: 'invalid base64' };
    }
    if (decodedLen > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'attachment too large' };
    }
    totalBytes += decodedLen;
    if (totalBytes > MAX_DRAFT_ATTACHMENTS_TOTAL) {
      return { ok: false, reason: 'total attachments too large' };
    }
    parsed.push({ base64, mediaType, ...(name !== undefined ? { name } : {}) });
  }
  return { ok: true, json: JSON.stringify(parsed), attachments: parsed };
}

function parseStoredAttachments(raw: string | undefined): PromptAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as PromptAttachment[] : [];
  } catch {
    return [];
  }
}

function notifyDraft(
  deps: ConversationRouteDeps,
  conversationId: string,
  opts: {
    text: string;
    hasAttachments: boolean;
    updatedAt: number;
    processing: DraftProcessing;
    processingStartedAt: number | null;
    canUndo: boolean;
    error?: string;
    profileId?: string | null;
  },
): void {
  deps.broadcast?.(conversationId, {
    type: 'draft_updated',
    conversationId,
    text: opts.text,
    hasAttachments: opts.hasAttachments,
    updatedAt: opts.updatedAt,
    processing: opts.processing,
    processingStartedAt: opts.processingStartedAt,
    canUndo: opts.canUndo,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.profileId !== undefined ? { profileId: opts.profileId } : {}),
  });
}

function rejectIfBusy(
  deps: ConversationRouteDeps,
  conversationId: string,
  res: import('express').Response,
): boolean {
  const processing = getProcessing(deps.getDb(), conversationId);
  if (processing === 'idle') return false;
  // ponytail: attachments are not locked separately — PUT/POST/DELETE all 409
  // while processing; the freeze already disables the attach button.
  res.status(409).json({ error: 'draft busy', processing } satisfies DraftBusyResponse);
  return true;
}

function rowHasAttachments(row: ReturnType<typeof getDraft>): boolean {
  return parseStoredAttachments(row?.attachments).length > 0;
}

function upsertDraftFromRequest(
  deps: ConversationRouteDeps,
  conversationId: string,
  text: string | undefined,
  attachments: unknown,
  res: import('express').Response,
  profileId?: string,
): boolean {
  const db = deps.getDb();
  if (profileId !== undefined) {
    try {
      assertValidRemoteAgentProfile(db, conversationId, undefined, profileId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return false;
    }
  }
  // Profile-only: touch profile_id, never rewrite text/attachments. A stale
  // read-then-upsert would clobber a concurrent text PUT (schedule-run picker
  // seed racing the debounce, or a late persist after `!` deleteDraft).
  if (text === undefined && attachments === undefined) {
    if (profileId === undefined) {
      res.status(400).json({ error: 'text or profileId required' });
      return false;
    }
    const updatedAt = setDraftProfile(db, conversationId, profileId);
    const row = getDraft(db, conversationId);
    const processing = effectiveProcessing(row);
    const attachmentsForBroadcast = parseStoredAttachments(row?.attachments);
    const textToWrite = row?.text ?? '';
    notifyDraft(deps, conversationId, {
      text: textToWrite,
      hasAttachments: attachmentsForBroadcast.length > 0,
      updatedAt,
      processing,
      processingStartedAt: processing === 'idle' ? null : (row?.processingStartedAt ?? null),
      canUndo: draftCanUndo(row, processing),
      profileId: row?.profileId ?? null,
    });
    const body: PutDraftResponse = {
      text: textToWrite,
      attachments: attachmentsForBroadcast,
      updatedAt,
      profileId: row?.profileId ?? null,
    };
    res.json(body);
    return true;
  }

  let textToWrite: string;
  if (text === undefined) {
    if (profileId === undefined) {
      res.status(400).json({ error: 'text or profileId required' });
      return false;
    }
    const existing = getDraft(db, conversationId);
    textToWrite = existing?.text ?? '';
  } else {
    if (typeof text !== 'string') { res.status(400).json({ error: 'text (string) required' }); return false; }
    if (text.length > 256_000) { res.status(413).json({ error: 'draft too large' }); return false; }
    textToWrite = text;
  }

  let jsonToWrite: string;
  let attachmentsForBroadcast: PromptAttachment[];
  if (attachments === undefined) {
    // Text-only update — preserve existing attachments (beacon omits when oversize).
    const existing = getDraft(db, conversationId);
    attachmentsForBroadcast = parseStoredAttachments(existing?.attachments);
    jsonToWrite = JSON.stringify(attachmentsForBroadcast);
  } else {
    const validated = validateDraftAttachments(attachments);
    if (!validated.ok) {
      res.status(413).json({ error: 'attachment(s) too large' });
      return false;
    }
    jsonToWrite = validated.json;
    attachmentsForBroadcast = validated.attachments;
  }

  const updatedAt = upsertDraft(db, conversationId, textToWrite, jsonToWrite, profileId);
  const row = getDraft(db, conversationId);
  const processing = effectiveProcessing(row);
  notifyDraft(deps, conversationId, {
    text: textToWrite,
    hasAttachments: attachmentsForBroadcast.length > 0,
    updatedAt,
    processing,
    processingStartedAt: processing === 'idle' ? null : (row?.processingStartedAt ?? null),
    canUndo: draftCanUndo(row, processing),
    profileId: row?.profileId ?? null,
  });
  const body: PutDraftResponse = {
    text: textToWrite,
    attachments: attachmentsForBroadcast,
    updatedAt,
    profileId: row?.profileId ?? null,
  };
  res.json(body);
  return true;
}

/** Per-id failure shape shared by the extracted conversation operations.
 *  `status` is what the single-id HTTP route returns; the bulk route ignores it
 *  and reports only `error` (FW-18 D7 — one error vocabulary, not two). */
export type ConversationOpFailure = { ok: false; status: 400 | 404 | 409 | 500; error: string };

export type DeleteOutcome = { ok: true; deletedIds: string[] } | ConversationOpFailure;

export type MoveOutcome =
  | { ok: true; conversation: Conversation; movedIds: string[] }
  | ConversationOpFailure;

/**
 * DELETE /conversations/:id minus the HTTP shell. Extracted for FW-18 so the
 * bulk route reuses the guards AND the post-commit native/TTS unlink instead of
 * copying them (FW-18 D9 — a copy would drift and strand .jsonl files).
 *
 * Caller supplies the id; every guard, the parked-session reap, the DB delete,
 * the best-effort native unlink and the TTS unlink happen here. Never throws for
 * a caller error — those come back as `{ ok: false, status, error }`.
 */
// An async throw here escapes Express 4 and kills the hub (no
// unhandledRejection handler) — every caller, incl. bulk, goes through this.
export async function performConversationDelete(deps: ConversationRouteDeps, convId: string): Promise<DeleteOutcome> {
  try {
    return await performConversationDeleteUnsafe(deps, convId);
  } catch (err) {
    console.error('[delete-conversation] failed:', err);
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performConversationDeleteUnsafe(
  deps: ConversationRouteDeps,
  convId: string,
): Promise<DeleteOutcome> {
  const db = deps.getDb();
  const existing = getConversation(db, convId);
  if (!existing) return { ok: false, status: 404, error: 'no such conversation' };
  // Schedule homes are structural — delete the job instead so runs/home stay consistent.
  if (existing.kind === 'schedule_home') {
    return {
      ok: false,
      status: 400,
      error: 'cannot delete schedule home conversation; delete the schedule job instead',
    };
  }

  // Guard + reap the whole spawn subtree (root + descendants) so cascade cannot
  // delete sessions out from under a live/parked adapter.
  const subtree = [convId, ...listDescendants(db, convId).map((c) => c.id)];
  if (deps.sessionManager) {
    for (const id of subtree) {
      if (deps.sessionManager.inFlightSessionForConversation(id)) {
        return { ok: false, status: 409, error: 'conversation tree has a live session' };
      }
    }
    await Promise.all(subtree.map((id) => deps.sessionManager!.reapParkedSessions(id, { all: true })));
  }

  // Capture before deleteConversation — the conversation row is gone after,
  // and remoteHostIdFor({ conversationId }) would miss the remote host.
  const projectId = existing.projectId;
  const { ok, nativeSessions, ttsWavPaths, deletedIds } = deleteConversation(db, convId);
  if (!ok) return { ok: false, status: 404, error: 'no such conversation' };

  // Best-effort native-file unlink AFTER the DB tx commits. Failures here must
  // NOT turn a successful conversation delete into a 500 — the conversation is
  // already gone from the DB; a stranded .jsonl is recoverable by hand. The
  // optional-call (`?.`) is the safety mechanism for adapters whose native
  // state is a shared DB (hermes, opencode) — absence = graceful skip.
  if (nativeSessions.length > 0) {
    const unique = Array.from(
      new Map(nativeSessions.map((s) => [`${s.agentId}:${s.nativeSessionId}`, s])).values(),
    );
    await Promise.all(unique.map(async ({ agentId, nativeSessionId }) => {
      try {
        const adapter = createAdapterFor(db, agentId, { projectId });
        await adapter.deleteNativeSession?.(nativeSessionId);
      } catch (err) {
        console.error(`[delete-conversation] native unlink failed for ${agentId}/${nativeSessionId}:`, err);
      }
    }));
  }
  unlinkTtsWavPaths(ttsWavPaths);
  if (deps.dataDir) await rmAttachmentShards(deps.dataDir, deletedIds);

  return { ok: true, deletedIds };
}

/**
 * The FW-10 move guards + the tree move, minus the HTTP shell. Extracted for
 * FW-18 alongside performConversationDelete.
 *
 * NOTE: the caller is responsible for validating that `targetProjectId` exists
 * (PATCH does it before calling; the bulk route does it once, before its loop).
 * Keeping it out here means the bulk route does not hit `projects` 50 times.
 */
export function performConversationMove(
  deps: ConversationRouteDeps,
  convId: string,
  targetProjectId: string,
): MoveOutcome {
  const db = deps.getDb();
  const existing = getConversation(db, convId);
  if (!existing) return { ok: false, status: 404, error: 'no such conversation' };
  // Schedule homes are structural: schedule_jobs.project_id pins the job, so
  // re-homing the home alone would desync the schedule tree. 409 (not DELETE's
  // 400) — the request is well-formed, the resource state blocks it.
  if (existing.kind === 'schedule_home') {
    return {
      ok: false,
      status: 409,
      error: 'cannot move schedule home conversation; move the schedule job instead',
    };
  }
  // Root-only, same rule and wording as the pin guard. This also covers schedule
  // RUN conversations for free: they are kind:'chat' with parent = the schedule home.
  if (existing.parentConversationId) {
    return { ok: false, status: 400, error: 'move applies to root conversations only' };
  }
  // Same in-flight guard as DELETE, over the same subtree we are about to move.
  // inFlightSessionForConversation (NOT activeSessionForConversation): a parked
  // hold-open conversation is the normal case for filing a chat away and must
  // stay movable. Do NOT reap — a move keeps sessions valid.
  const subtree = [convId, ...listDescendants(db, convId).map((c) => c.id)];
  if (deps.sessionManager) {
    for (const sid of subtree) {
      if (deps.sessionManager.inFlightSessionForConversation(sid)) {
        return { ok: false, status: 409, error: 'conversation tree has a live session' };
      }
    }
  }

  const moved = moveConversationTree(db, convId, targetProjectId);
  if (!moved) return { ok: false, status: 404, error: 'no such conversation' };
  // Root only: the frame carries no project info, so one is as informative as N.
  // Skipped for a same-project no-op (movedIds empty).
  if (moved.movedIds.length > 0) {
    deps.notifyConversationUpdated?.(convId);
  }
  return { ok: true, conversation: moved.conversation, movedIds: moved.movedIds };
}

/** Mounts PATCH/DELETE/POST /conversations/:id. `getDb` lets tests inject an in-memory DB. */
export function registerConversationMutationRoutes(app: Express, deps: ConversationRouteDeps | (() => Database)): void {
  const resolved: ConversationRouteDeps = typeof deps === 'function'
    ? { getDb: deps }
    : deps;

  app.patch('/conversations/:id', async (req, res) => {
    const body = req.body as UpdateConversationRequest;
    const db = resolved.getDb();
    const hasTitle = typeof body.title === 'string' && body.title.trim().length > 0;
    const hasTemplate = Object.prototype.hasOwnProperty.call(body, 'templateName');
    const hasSpawnWorkdir = Object.prototype.hasOwnProperty.call(body, 'spawnWorkdir');
    const hasPinned = Object.prototype.hasOwnProperty.call(body, 'pinned');
    const hasArchived = Object.prototype.hasOwnProperty.call(body, 'archived');
    const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
    const hasProjectId = Object.prototype.hasOwnProperty.call(body, 'projectId');
    const hasTags = Object.prototype.hasOwnProperty.call(body, 'tags');
    const hasDesignation = Object.prototype.hasOwnProperty.call(body, 'designation');
    const hasCapabilityProfile = Object.prototype.hasOwnProperty.call(body, 'capabilityProfile');
    const hasMcpServers = Object.prototype.hasOwnProperty.call(body, 'mcpServers');
    const hasDisableNativeMcp = Object.prototype.hasOwnProperty.call(body, 'disableNativeMcp');
    const hasDisabledNativeMcp = Object.prototype.hasOwnProperty.call(body, 'disabledNativeMcp');
    const hasPermissionMode = Object.prototype.hasOwnProperty.call(body, 'permissionMode');
    const hasEffort = Object.prototype.hasOwnProperty.call(body, 'effort');
    const hasSandbox = Object.prototype.hasOwnProperty.call(body, 'sandbox');
    const hasPendingHandoffMode = Object.prototype.hasOwnProperty.call(body, 'pendingHandoffMode');
    const hasRules = Object.prototype.hasOwnProperty.call(body, 'rules');
    const hasRulePresetIds = Object.prototype.hasOwnProperty.call(body, 'rulePresetIds');
    if (!hasTitle && !hasTemplate && !hasSpawnWorkdir && !hasPinned && !hasArchived && !hasDescription && !hasProjectId && !hasTags && !hasDesignation && !hasCapabilityProfile && !hasMcpServers && !hasDisableNativeMcp && !hasDisabledNativeMcp && !hasPermissionMode && !hasEffort && !hasSandbox && !hasPendingHandoffMode && !hasRules && !hasRulePresetIds) {
      res.status(400).json({ error: 'title, templateName, spawnWorkdir, pinned, archived, projectId, description, tags, designation, capabilityProfile, mcpServers, disableNativeMcp, disabledNativeMcp, permissionMode, effort, sandbox, pendingHandoffMode, rules, or rulePresetIds required' });
      return;
    }
    if (hasMcpServers && body.mcpServers !== null) {
      const err = validateMcpIdList(body.mcpServers);
      if (err) { res.status(400).json({ error: err }); return; }
    }
    if (hasDisableNativeMcp && body.disableNativeMcp !== null && typeof body.disableNativeMcp !== 'boolean') {
      res.status(400).json({ error: 'disableNativeMcp must be a boolean or null' });
      return;
    }
    if (hasDisabledNativeMcp && body.disabledNativeMcp !== null) {
      if (!Array.isArray(body.disabledNativeMcp) || body.disabledNativeMcp.some((x: unknown) => typeof x !== 'string')) {
        res.status(400).json({ error: 'disabledNativeMcp must be an array of strings or null' });
        return;
      }
    }
    if (hasPermissionMode) {
      const m = body.permissionMode;
      if (m !== null && m !== undefined && m !== 'bypass' && m !== 'questions' && m !== 'prompt') {
        res.status(400).json({ error: 'invalid permissionMode' });
        return;
      }
    }
    if (hasEffort && body.effort != null && !EFFORT_PREFERENCES.has(body.effort)) {
      res.status(400).json({ error: 'invalid effort' });
      return;
    }
    if (hasSandbox) {
      const s = body.sandbox;
      if (s !== null && s !== undefined && s !== 'on' && s !== 'off') {
        res.status(400).json({ error: 'invalid sandbox' });
        return;
      }
    }
    if (hasPendingHandoffMode) {
      const m = body.pendingHandoffMode;
      if (m !== null && m !== undefined && m !== 'fresh' && m !== 'summary') {
        res.status(400).json({ error: 'invalid pendingHandoffMode' });
        return;
      }
    }
    let updated;
    if (hasTitle) {
      updated = renameConversation(db, req.params.id, body.title!.trim());
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    if (hasDescription) {
      const d = body.description;
      if (d !== null && typeof d !== 'string') { res.status(400).json({ error: 'description must be a string or null' }); return; }
      updated = setConversationDescription(db, req.params.id, d === null ? null : d.trim() || null);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    if (hasTemplate) {
      const name = body.templateName ?? null;
      if (name !== null && !getTemplate(db, name)) {
        res.status(400).json({ error: `unknown template: ${name}` });
        return;
      }
      const existing = getConversation(db, req.params.id);
      if ((existing?.templateName ?? null) !== name && resolved.sessionManager) {
        await resolved.sessionManager.reapParkedSessions(req.params.id, { all: true });
      }
      updated = setConversationTemplate(db, req.params.id, name);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    if (hasSpawnWorkdir) {
      const wd = body.spawnWorkdir ?? null;
      if (wd !== null && wd !== 'shared' && wd !== 'worktree') {
        res.status(400).json({ error: `invalid spawnWorkdir: ${wd}` }); return;
      }
      updated = setConversationSpawnWorkdir(db, req.params.id, wd);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    if (hasPinned) {
      if (typeof body.pinned !== 'boolean') {
        res.status(400).json({ error: 'pinned must be a boolean' });
        return;
      }
      const existing = getConversation(db, req.params.id);
      if (!existing) { res.status(404).json({ error: 'no such conversation' }); return; }
      if (existing.parentConversationId) {
        res.status(400).json({ error: 'pin applies to root conversations only' });
        return;
      }
      updated = setConversationPinned(db, req.params.id, body.pinned);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    // Migration 114 — soft-archive. Same root-only guard as pin: spawn
    // children/schedule runs live and die with their root; archiving the
    // root archives the subtree from the sidebar's point of view already.
    if (hasArchived) {
      if (typeof body.archived !== 'boolean') {
        res.status(400).json({ error: 'archived must be a boolean' });
        return;
      }
      const existing = getConversation(db, req.params.id);
      if (!existing) { res.status(404).json({ error: 'no such conversation' }); return; }
      if (existing.parentConversationId) {
        res.status(400).json({ error: 'archive applies to root conversations only' });
        return;
      }
      updated = setConversationArchived(db, req.params.id, body.archived);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    // FW-15 — replace the whole tag list. Unlike pin/move there is no
    // root-only guard: spawn children and schedule runs are taggable too.
    // Validation is normaliseTags in @tierwyn/shared, the same function the
    // web modal calls — the client is never trusted, it is only pre-flighted.
    if (hasTags) {
      const normalised = normaliseTags(body.tags);
      if (!normalised.ok) {
        res.status(400).json({ error: normalised.error });
        return;
      }
      updated = updateConversationTags(db, req.params.id, normalised.tags);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    if (hasDesignation) {
      const parsed = parseOptionalDesignation(body.designation);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      if (parsed.token && !isKnownDesignation(parsed.token, listCustomDesignations(db))) {
        res.status(400).json({ error: `unknown designation: ${parsed.token}` });
        return;
      }
      updated = setConversationDesignation(db, req.params.id, parsed.token);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    // Capability profile — persists via migration 128 column (null = 'all').
    // A change writes the column on this conversation AND every descendant
    // (a narrowed parent must not keep an `all` child as a confused deputy),
    // then kills parked sessions and live tokens. Re-issue only when a
    // session is actually live so we never mint an orphan Bearer.
    if (hasCapabilityProfile) {
      const raw = body.capabilityProfile;
      const nextRaw = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
      if (nextRaw && !getCapabilityProfile(db, nextRaw)) {
        res.status(400).json({ error: `unknown capability profile: ${nextRaw}` });
        return;
      }
      const existing = getConversation(db, req.params.id);
      if (!existing) { res.status(404).json({ error: 'no such conversation' }); return; }
      const defaultId = getDefaultCapabilityProfileId(db);
      const next = canonicalCapabilityProfileId(nextRaw, defaultId);
      const changed = canonicalCapabilityProfileId(existing.capabilityProfile, defaultId) !== next;
      updated = setConversationCapabilityProfile(db, req.params.id, next);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
      if (changed) {
        const ids = [req.params.id, ...listDescendants(db, req.params.id).map((c) => c.id)];
        for (const id of ids) {
          if (id !== req.params.id) setConversationCapabilityProfile(db, id, next);
          await refreshConversationCapabilityTokens(id, resolved.sessionManager);
        }
      }
    }
    // MCP selection & native overrides (migration 140). WP-2.4: claude-code with a live query swaps
    // in place (SDK Query.setMcpServers); anything else keeps next-turn semantics via reap.
    if (hasMcpServers || hasDisableNativeMcp || hasDisabledNativeMcp) {
      const existing = getConversation(db, req.params.id);
      if (!existing) { res.status(404).json({ error: 'no such conversation' }); return; }
      const nextServers = hasMcpServers ? (body.mcpServers ?? null) : (existing.mcpServers ?? null);
      const nextDisableNative = hasDisableNativeMcp ? (body.disableNativeMcp === true) : Boolean(existing.disableNativeMcp);
      const nextDisabledNative = hasDisabledNativeMcp
        ? (Array.isArray(body.disabledNativeMcp) ? body.disabledNativeMcp : [])
        : (existing.disabledNativeMcp ?? []);
      updated = setConversationMcpServers(db, req.params.id, nextServers, nextDisableNative, nextDisabledNative);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
      await resolved.sessionManager?.applyConversationMcpServers(req.params.id);
    }
    // Sticky per-conversation permission mode (migration 141, WP-2.1).
    if (hasPermissionMode) {
      updated = setConversationPermissionMode(db, req.params.id, body.permissionMode ?? null);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
      await resolved.sessionManager?.applyConversationPermissionMode(req.params.id);
    }
    if (hasEffort) {
      updated = setConversationEffort(db, req.params.id, body.effort ?? null);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    if (hasSandbox) {
      updated = setConversationSandbox(db, req.params.id, body.sandbox ?? null);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
      await resolved.sessionManager?.applyConversationSandbox(req.params.id);
    }
    // Staged next-send action (migration 142). Not a reason to reap parked sessions.
    if (hasPendingHandoffMode) {
      updated = setConversationPendingHandoffMode(db, req.params.id, body.pendingHandoffMode ?? null);
      if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
    }
    // Operator rules (migration 143) + preset stack (144). Fingerprint picks up the edit on the next session.
    if (hasRules || hasRulePresetIds) {
      const existing = getConversation(db, req.params.id);
      if (!existing) { res.status(404).json({ error: 'no such conversation' }); return; }
      const proj = getProject(db, existing.projectId);
      if (proj?.system) {
        res.status(409).json({ error: 'system project conversations cannot have rules' });
        return;
      }
      if (hasRules) {
        const parsed = normaliseRules(body.rules);
        if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
        updated = setConversationRules(db, req.params.id, parsed.value);
        if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
      }
      if (hasRulePresetIds) {
        const parsed = normalisePresetIds(db, body.rulePresetIds, existing.projectId);
        if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
        updated = setConversationRulePresetIds(db, req.params.id, parsed.value);
        if (!updated) { res.status(404).json({ error: 'no such conversation' }); return; }
      }
    }
    // FW-10 — re-home this conversation into another project. Runs LAST so a
    // guard rejection here cannot roll back an already-applied rename: the
    // route has no request-level transaction, and the other fields above are
    // independently valid. A rejected move returns its error with the other
    // edits kept; the operator retries the move on its own.
    if (hasProjectId) {
      const targetProjectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (!targetProjectId) {
        res.status(400).json({ error: 'projectId must be a non-empty string' });
        return;
      }
      // Target-project existence is checked HERE (not in performConversationMove)
      // so the bulk route can check it once instead of per id. Order note: this
      // now runs before the "no such conversation" 404, which is fine — the two
      // existing tests each hold the other input valid.
      if (!getProject(db, targetProjectId)) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const source = getConversation(db, req.params.id);
      if (!source) { res.status(404).json({ error: 'no such conversation' }); return; }
      if (source.projectId === REMOTE_AGENTS_PROJECT_ID || targetProjectId === REMOTE_AGENTS_PROJECT_ID) {
        res.status(409).json({ error: 'Remote Agents conversations cannot be moved' });
        return;
      }
      const moved = performConversationMove(resolved, req.params.id, targetProjectId);
      if (!moved.ok) { res.status(moved.status).json({ error: moved.error }); return; }
      updated = moved.conversation;
    }
    // FW-15 F10: other tabs/devices keep chips in sync. Absent tags on the
    // frame means "unchanged"; send `[]` when the operator cleared the list.
    if (hasTags && updated) {
      resolved.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: req.params.id,
        ts: Date.now(),
        tags: updated.tags ?? [],
      });
    }
    if (hasDesignation && updated) {
      resolved.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: req.params.id,
        ts: Date.now(),
        designation: updated.designation ?? null,
      });
    }
    // Same frame, different field: absent archived means "unchanged". Other
    // tabs refetch their sidebar list on this frame, so an archive/unarchive
    // in one tab hides/shows the row everywhere.
    if (hasArchived && updated) {
      resolved.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: req.params.id,
        ts: Date.now(),
        archived: updated.archived === true,
      });
    }
    if (hasPendingHandoffMode && updated) {
      resolved.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: req.params.id,
        ts: Date.now(),
        pendingHandoffMode: updated.pendingHandoffMode ?? null,
      });
    }
    if ((hasPermissionMode || hasEffort || hasMcpServers || hasDisableNativeMcp || hasDisabledNativeMcp || hasTemplate || hasCapabilityProfile) && updated) {
      resolved.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: req.params.id,
        ts: Date.now(),
        settingsChanged: true,
      });
    }
    if (hasSandbox && updated) {
      resolved.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: req.params.id,
        ts: Date.now(),
        sandbox: updated.sandbox ?? null,
      });
    }
    res.json({ conversation: updated });
  });

  app.get('/conversations/:id/sandbox', (req, res) => {
    const db = resolved.getDb();
    const conversation = getConversation(db, req.params.id);
    if (!conversation) { res.status(404).json({ error: 'no such conversation' }); return; }
    const project = getProject(db, conversation.projectId);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    const agentType = lastSessionForConversation(db, conversation.id)?.agentId ?? '';
    const hostId = project.remoteHostId ?? 'hub';
    const hello = project.remoteHostId ? getRemoteHost(db, project.remoteHostId)?.hello : undefined;
    const capable = agentType ? sandboxCapability(hostId, agentType, hello) : null;
    const settings = getSandboxSettings(db);
    const input = {
      conv: conversation.sandbox,
      project: project.sandbox,
      hostId,
      agentType,
      settings,
      capable,
    };
    const unioned = unionSandboxPaths(settings.hostPaths[hostId] ?? [], project.sandboxPaths ?? []);
    const paths = annotateEffectivePaths(
      unioned,
      project.remoteHostId
        ? {
          home: hello?.homedir ?? os.homedir(),
          cwd: project.rootPath,
          repoRoot: '/.__tierwyn_hub_repo__',
          agentType,
          roots: hello?.roots ?? [],
        }
        : {
          home: os.homedir(),
          cwd: project.rootPath,
          repoRoot: hubTierwynRoot(),
          agentType,
          dataDir: hubDataDir(dbPathFromEnv()),
        },
      project.remoteHostId ? () => true : existsSync,
    );
    res.json({
      resolved: resolveSandbox(input),
      chain: sandboxChain(input),
      paths,
    });
  });

  app.get('/conversations/:id/rules', (req, res) => {
    const db = resolved.getDb();
    const conversation = getConversation(db, req.params.id);
    if (!conversation) { res.status(404).json({ error: 'no such conversation' }); return; }
    const project = getProject(db, conversation.projectId);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    const view = loadRules(db, conversation, project);
    const layers = describeRulesLayers(db, conversation, project);
    res.json({
      project: layers.project,
      chain: layers.chain,
      hash: view?.hash ?? null,
      omitted: view?.omitted ?? 0,
      rendered: view ? renderedRules(view) : '',
    });
  });

  app.get('/conversations/:id', (req, res) => {
    const conversation = getConversation(resolved.getDb(), req.params.id);
    if (!conversation) { res.status(404).json({ error: 'no such conversation' }); return; }
    res.json({ conversation });
  });

  // FW-9: full conversation history as a downloadable Markdown file. Server-side so a
  // parked conversation exports everything in SQLite, not the client's partial buffer.
  // Reads only through listEventsForConversation — payloads are already token-redacted
  // at persist time (repositories/events.ts appendEvent).
  app.get('/conversations/:id/export', (req, res) => {
    const db = resolved.getDb();
    const conversation = getConversation(db, req.params.id);
    if (!conversation) { res.status(404).json({ error: 'no such conversation' }); return; }
    const project = getProject(db, conversation.projectId);
    const markdown = renderConversationMarkdown(
      {
        title: conversation.title,
        conversationId: conversation.id,
        projectId: conversation.projectId,
        projectName: project?.name,
        description: conversation.description,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
      listEventsForConversation(db, conversation.id),
    );
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFilename(conversation.title, conversation.id)}"`,
    );
    res.send(markdown);
  });

  app.post('/conversations/:id/describe', async (req, res) => {
    const result = await regenerateConversationDescription(
      resolved.getDb(),
      req.params.id,
      resolved.broadcastAll,
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ conversation: result.conversation });
  });

  app.delete('/conversations/:id', async (req, res) => {
    const out = await performConversationDelete(resolved, req.params.id);
    if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
    res.json({ ok: true, deletedIds: out.deletedIds });
  });

  app.post('/conversations/:id/fork', (req, res) => {
    const { eventId, title } = req.body as { eventId: string; title?: string };
    if (!eventId) { res.status(400).json({ error: 'eventId required' }); return; }
    try {
      const newConv = forkConversation(resolved.getDb(), req.params.id, eventId, title);
      res.json({ conversation: newConv });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // FW-13: full-transcript snapshot into a NEW ROOT chat. Distinct from /fork
  // (which needs an eventId, branches at that point and copies sessions) and
  // from the header "Copy conversation" clipboard action.
  app.post('/conversations/:id/duplicate', (req, res) => {
    const db = resolved.getDb();
    const { projectId, includeTools, title } = (req.body ?? {}) as {
      projectId?: unknown; includeTools?: unknown; title?: unknown;
    };
    if (includeTools !== undefined && typeof includeTools !== 'boolean') {
      res.status(400).json({ error: 'includeTools must be a boolean' }); return;
    }
    if (title !== undefined && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string' }); return;
    }
    if (projectId !== undefined && typeof projectId !== 'string') {
      res.status(400).json({ error: 'projectId must be a string' }); return;
    }

    const source = getConversation(db, req.params.id);
    if (!source) { res.status(404).json({ error: 'no such conversation' }); return; }
    // Schedule homes are structural (same rationale as delete/move) — the copy
    // would be a home with no job behind it. Schedule RUN chats are fine.
    if (source.kind === 'schedule_home') {
      res.status(409).json({ error: 'cannot duplicate schedule home conversation' }); return;
    }
    if (source.projectId === REMOTE_AGENTS_PROJECT_ID) {
      res.status(409).json({ error: 'cannot duplicate a Remote Agents conversation' }); return;
    }
    if (projectId !== undefined && !getProject(db, projectId)) {
      res.status(404).json({ error: 'no such project' }); return;
    }

    // ponytail: pre-checked above, so no try/catch — duplicateConversation's
    // ConversationNotFound is unreachable from here and a genuine throw
    // (disk/FK) should surface as a 500, not be flattened into a 404.
    const conversation = duplicateConversation(db, req.params.id, {
      projectId: typeof projectId === 'string' ? projectId : undefined,
      includeTools: typeof includeTools === 'boolean' ? includeTools : undefined,
      title: typeof title === 'string' ? title : undefined,
    });
    res.json({ conversation });
  });

  app.post('/conversations/mark-read', (req, res) => {
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (Array.isArray(ids)) {
      const validIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
      markConversationsViewed(resolved.getDb(), validIds);
    } else {
      markConversationsViewed(resolved.getDb());
    }
    res.json({ ok: true });
  });

  app.post('/conversations/:id/mark-read', (req, res) => {
    markConversationViewed(resolved.getDb(), req.params.id);
    res.json({ ok: true });
  });

  app.post('/conversations/:id/mark-unread', (req, res) => {
    markConversationUnread(resolved.getDb(), req.params.id);
    res.json({ ok: true });
  });

  app.post('/conversations/:id/reissue-token', async (req, res) => {
    const db = resolved.getDb();
    const conv = getConversation(db, req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (!resolved.sessionManager) {
      res.status(500).json({ error: 'SessionManager not available' });
      return;
    }
    const result = await resolved.sessionManager.reissueSpawnToken(conv.id);
    if (!result) { res.status(409).json({ error: 'conversation takes no token' }); return; }
    res.json(result);
  });

  app.get('/conversations/:id/draft', (req, res) => {
    const db = resolved.getDb();
    const row = getDraft(db, req.params.id);
    const processing = effectiveProcessing(row);
    const body: GetDraftResponse = {
      text: row?.text ?? '',
      attachments: parseStoredAttachments(row?.attachments),
      updatedAt: row?.updatedAt ?? null,
      processing,
      processingStartedAt: processing === 'idle' ? null : (row?.processingStartedAt ?? null),
      canUndo: draftCanUndo(row, processing),
      autoSend: Boolean(row?.autoSend),
      profileId: row?.profileId ?? null,
    };
    res.json(body);
  });

  app.put('/conversations/:id/draft', (req, res) => {
    if (rejectIfBusy(resolved, req.params.id, res)) return;
    const { text, attachments, profileId } = (req.body ?? {}) as PutDraftRequest;
    upsertDraftFromRequest(resolved, req.params.id, text, attachments, res, profileId);
  });

  app.delete('/conversations/:id/draft', (req, res) => {
    if (rejectIfBusy(resolved, req.params.id, res)) return;
    const db = resolved.getDb();
    deleteDraft(db, req.params.id);
    notifyDraft(resolved, req.params.id, {
      text: '',
      hasAttachments: false,
      updatedAt: Date.now(),
      processing: 'idle',
      processingStartedAt: null,
      canUndo: false,
      profileId: null,
    });
    res.status(204).end();
  });

  // POST alias so navigator.sendBeacon (Task 8c) can flush on unload — beacon is POST-only,
  // cannot PUT/DELETE, cannot set headers. Body is the same { text } shape as PUT. Auth rides
  // on the session cookie (same-origin), which sendBeacon DOES send.
  app.post('/conversations/:id/draft', (req, res) => {
    if (rejectIfBusy(resolved, req.params.id, res)) return;
    const { text, attachments, profileId } = (req.body ?? {}) as PutDraftRequest;
    upsertDraftFromRequest(resolved, req.params.id, text, attachments, res, profileId);
  });

  app.post('/conversations/:id/draft/undo-enhance', (req, res) => {
    const db = resolved.getDb();
    const cid = req.params.id;
    if (rejectIfBusy(resolved, cid, res)) return;
    const restored = undoEnhance(db, cid);
    if (!restored) { res.status(409).json({ error: 'nothing to undo' }); return; }
    const row = getDraft(db, cid);
    notifyDraft(resolved, cid, {
      text: restored.text,
      hasAttachments: rowHasAttachments(row),
      updatedAt: restored.updatedAt,
      processing: 'idle',
      processingStartedAt: null,
      canUndo: false,
    });
    res.json(restored satisfies UndoEnhanceResponse);
  });

  app.get('/conversations/:id/checkpoints', (req, res) => {
    const body: CheckpointsResponse = { checkpoints: listCheckpoints(resolved.getDb(), req.params.id) };
    res.json(body);
  });

  app.post('/conversations/:id/checkpoints', async (req, res) => {
    try {
      const db = resolved.getDb();
      const convId = req.params.id;
      const body = req.body as CreateCheckpointRequest;
      if (!body.eventId) { res.status(400).json({ error: 'eventId required' }); return; }
      const event = getEvent(db, body.eventId);
      if (!event) { res.status(400).json({ error: 'unknown event' }); return; }
      const session = getSession(db, event.sessionId);
      if (!session || session.conversationId !== convId) {
        res.status(400).json({ error: 'event does not belong to conversation' });
        return;
      }
      const existing = getCheckpointByEvent(db, body.eventId);
      if (existing) {
        const updated = updateCheckpoint(db, existing.id, {
          label: body.label ?? existing.label,
          pinned: body.pinned ?? existing.pinned,
        });
        notifyCheckpoints(resolved, convId);
        res.json({ checkpoint: updated });
        return;
      }
      const checkpoint = createCheckpoint(db, {
        conversationId: convId,
        eventId: body.eventId,
        sessionId: event.sessionId,
        nativeSessionId: session.nativeSessionId,
        nativeTurnIndex: nativeTurnIndex(db, body.eventId) || undefined,
        label: body.label,
        kind: 'manual',
        pinned: body.pinned ?? false,
      });
      await snapshotCodeForCheckpoint(db, convId, checkpoint.id);
      notifyCheckpoints(resolved, convId);
      res.json({ checkpoint: getCheckpoint(db, checkpoint.id) ?? checkpoint });
    } catch (err) {
      sendAsyncRouteError(res, err);
    }
  });

  app.delete('/conversations/:id/checkpoints/:cid', async (req, res) => {
    try {
      const db = resolved.getDb();
      const row = getCheckpoint(db, req.params.cid);
      if (!row || row.conversationId !== req.params.id) {
        res.status(404).json({ error: 'no such checkpoint' });
        return;
      }
      const remoteOps = await checkpointOpsFor(db, req.params.id);
      if (remoteOps) {
        try {
          await remoteOps.ops.deleteShadowRef(req.params.id, req.params.cid);
        } catch { /* best-effort: the row is going away regardless */ }
      } else if (!remoteHostIdFor(db, { conversationId: req.params.id })) {
        const cwd = resolveConversationCwd(db, req.params.id);
        if (cwd) deleteShadowRef(cwd, req.params.id, req.params.cid);
      }
      deleteCheckpoint(db, req.params.cid);
      notifyCheckpoints(resolved, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendAsyncRouteError(res, err);
    }
  });

  app.get('/conversations/:id/checkpoints/:cid/code-diff', async (req, res) => {
    try {
      const db = resolved.getDb();
      const row = getCheckpoint(db, req.params.cid);
      if (!row || row.conversationId !== req.params.id) {
        res.status(404).json({ error: 'no such checkpoint' });
        return;
      }
      const remoteOps = await checkpointOpsFor(db, req.params.id);
      if (!remoteOps && remoteHostIdFor(db, { conversationId: req.params.id })) {
        res.status(409).json({ error: 'not available for remote-host projects (P3)' });
        return;
      }
      if (!row.codeRef) {
        res.json({ diff: null });
        return;
      }
      // ponytail: ?mode=captured shows what the checkpoint represents (vs its parent);
      // default 'restore' shows what restoring would change (vs working tree).
      const mode = req.query.mode === 'captured' ? 'captured' : 'restore';
      try {
        const diff = remoteOps
          ? await remoteOps.ops.codeDiff(row.codeRef, mode)
          : (() => {
              const cwd = resolveConversationCwd(db, req.params.id);
              return cwd ? codeDiff(cwd, row.codeRef, mode) : null;
            })();
        res.json({ diff });
      } catch {
        res.json({ diff: null });
      }
    } catch (err) {
      sendAsyncRouteError(res, err);
    }
  });

  app.patch('/conversations/:id/checkpoints/:cid', (req, res) => {
    const db = resolved.getDb();
    const existing = getCheckpoint(db, req.params.cid);
    if (!existing || existing.conversationId !== req.params.id) {
      res.status(404).json({ error: 'no such checkpoint' });
      return;
    }
    const body = req.body as UpdateCheckpointRequest;
    const updated = updateCheckpoint(db, req.params.cid, {
      label: body.label,
      pinned: body.pinned,
    });
    notifyCheckpoints(resolved, req.params.id);
    res.json({ checkpoint: updated });
  });

  app.post('/conversations/:id/rewind', async (req, res) => {
    try {
    const db = resolved.getDb();
    const convId = req.params.id;
    const body = req.body as RewindConversationRequest;
    if (!body.eventId) { res.status(400).json({ error: 'eventId required' }); return; }
    if (!getConversation(db, convId)) {
      res.status(404).json({ error: 'no such conversation' });
      return;
    }
    if (resolved.sessionManager?.inFlightSessionForConversation(convId)) {
      res.status(409).json({ error: 'conversation has a live session' });
      return;
    }
    // Parked hold-open subprocess (claude SDK) after a done
    // turn is NOT an in-flight turn — reap it so its record clears and the truncation
    // below doesn't run out from under a stale subprocess.
    await resolved.sessionManager?.reapParkedSessions(convId, { all: true });
    const event = getEvent(db, body.eventId);
    if (!event) { res.status(400).json({ error: 'unknown event' }); return; }
    const session = getSession(db, event.sessionId);
    if (!session || session.conversationId !== convId) {
      res.status(400).json({ error: 'event does not belong to conversation' });
      return;
    }

    const rewindConversation = body.rewindConversation !== false;
    const rewindCode = body.rewindCode === true;
    if (!rewindConversation && !rewindCode) {
      res.status(400).json({ error: 'rewindConversation or rewindCode required' });
      return;
    }

    const conv = getConversation(db, convId)!;
    const cwd = resolveConversationCwd(db, convId);
    const existingAtEvent = getCheckpointByEvent(db, body.eventId);
    const codeRefForRestore = existingAtEvent?.codeRef;
    const remote = !!remoteHostIdFor(db, { conversationId: convId });
    // Snapshot ops: remote over git.call when the host advertises git.shadow,
    // local wrappers otherwise. null on old/disconnected nodes (P2 behaviour).
    const remoteOps = remote ? await checkpointOpsFor(db, convId) : null;
    const ops = remoteOps ? remoteOps.ops : remote ? null : cwd ? localShadowOpsFor(cwd) : null;

    let codeApplied = false;
    let codeSkippedReason: 'shared_tree' | 'diverged' | 'no_ref' | 'not_git' | 'remote_host' | undefined;

    if (rewindCode && remote && !rewindConversation && !remoteOps) {
      res.status(409).json({ error: 'not available for remote-host projects (P3)' });
      return;
    }

    // Step 1: Both-mode pre-flight — gate BEFORE truncating anything.
    // If the gate fails here, neither transcript nor files have been touched → safe to 409 and retry.
    // Remote leftover codeRef must not run hub git (T15 L2); old nodes skip straight to
    // Step 3's remote_host skip so the transcript rewind still works.
    if (rewindConversation && rewindCode && !(remote && !remoteOps)) {
      if (!ops) {
        res.status(409).json({ ok: false, codeApplied: false, codeSkippedReason: 'not_git' });
        return;
      }
      const preGate = await evaluateCodeRewindGate(ops, conv.workdirPath, codeRefForRestore, body.confirmSharedCode === true);
      if (!preGate.ok) {
        res.status(409).json({ ok: false, codeApplied: false, codeSkippedReason: preGate.reason });
        return;
      }
    }

    // Step 2: Conversation rewind first (reversible if code restore later fails).
    let result: Awaited<ReturnType<typeof rewindConversationToEvent>> = {};
    try {
      if (rewindConversation) {
        result = await rewindConversationToEvent(db, (agentId) => createAdapterFor(db, agentId, { conversationId: convId }), {
          conversationId: convId,
          eventId: body.eventId,
          mode: 'rewind',
          createCheckpoint: body.createCheckpoint !== false,
        });
        notifyCheckpoints(resolved, convId);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Step 3: Code restore last (destructive op runs only after conversation is safely rewound).
    if (rewindCode) {
      if (remote && !remoteOps) {
        // Old node / disconnected host — graceful fallback to the P2 behaviour.
        codeSkippedReason = 'remote_host';
      } else if (!ops) {
        if (!rewindConversation) {
          // Nothing has changed yet — safe to hard-fail
          res.status(409).json({ ok: false, codeApplied: false, codeSkippedReason: 'not_git' });
          return;
        }
        // Conversation already rewound; defensive 200-with-reason
        codeSkippedReason = 'not_git';
      } else {
        const gate = await evaluateCodeRewindGate(ops, conv.workdirPath, codeRefForRestore, body.confirmSharedCode === true);
        if (!gate.ok) {
          if (!rewindConversation) {
            res.status(409).json({ ok: false, codeApplied: false, codeSkippedReason: gate.reason });
            return;
          }
          // Conversation already rewound; defensive 200-with-reason
          codeSkippedReason = gate.reason;
        } else {
          // Safety checkpoint: code-only + dirty tree → snapshot before blasting.
          // Both worktree (reset --hard) and shared (git restore --source) modes overwrite
          // uncommitted edits — snapshot them first so the operator can recover via the
          // checkpoint list. Gated on code-only (!rewindConversation) because a Both-mode
          // snapshot anchored at the latest event would be pruned by truncateConversation
          // immediately (rewind.ts:74-76).
          if (!rewindConversation && !(await ops.isWorkingTreeClean())) {
            await recordPreRestoreCheckpoint(db, convId);
            notifyCheckpoints(resolved, convId);
          }
          try {
            await ops.restoreCode(codeRefForRestore!, gate.mode);
            codeApplied = true;
          } catch (err) {
            if (!rewindConversation) {
              const status = err instanceof WorkingTreeContextError ? err.status : 500;
              res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
              return;
            }
            // Conversation already rewound; defensive 200-with-reason (log, don't surface 500)
            console.error('[rewind] restoreCode failed after conversation rewind:', err);
            codeSkippedReason = 'diverged';
          }
        }
      }
    }

    res.json({
      ok: true,
      checkpoint: result.checkpoint,
      nativeDrift: result.nativeDrift,
      codeApplied,
      codeSkippedReason,
    });
    } catch (err) {
      sendAsyncRouteError(res, err);
    }
  });

  // v2: surgical single-turn delete. Removes exactly the supplied event ids
  // from the transcript AND forks the native session with that turn excised
  // (parentUuid rewired so the result is resumable). Only claude-code +
  // claude-code implement exciseNativeTurn; absence on other adapters is the
  // safety mechanism — we 409 with a clear message so the client can offer a
  // transcript-only fallback.
  app.post('/conversations/:id/excise-turn', async (req, res) => {
    const db = resolved.getDb();
    const convId = req.params.id;
    const body = req.body as { turnIndex?: number; eventIds?: string[] };

    if (typeof body.turnIndex !== 'number' || !Array.isArray(body.eventIds) || body.eventIds.length === 0) {
      res.status(400).json({ error: 'turnIndex (number) and eventIds (non-empty string[]) required' });
      return;
    }
    const eventIds: string[] = body.eventIds;
    if (!getConversation(db, convId)) {
      res.status(404).json({ error: 'no such conversation' });
      return;
    }
    if (resolved.sessionManager?.inFlightSessionForConversation(convId)) {
      res.status(409).json({ error: 'conversation has a live session' });
      return;
    }
    await resolved.sessionManager?.reapParkedSessions(convId, { all: true });

    // Resolve the session that owns the deleted turn (any of the event ids —
    // they all belong to the same turn/session). We need its agentId to pick
    // the adapter and its nativeSessionId to point exciseNativeTurn at the file.
    const ownerEvent = getEvent(db, eventIds[0]);
    if (!ownerEvent) {
      res.status(400).json({ error: 'unknown event' });
      return;
    }
    const session = getSession(db, ownerEvent.sessionId);
    if (!session || session.conversationId !== convId) {
      res.status(400).json({ error: 'event does not belong to conversation' });
      return;
    }
    if (!session.nativeSessionId) {
      res.status(409).json({ error: 'conversation has no native session to excise' });
      return;
    }
    if (!session.agentId) {
      res.status(409).json({ error: 'session has no agent; cannot excise native session' });
      return;
    }

    let adapter;
    try {
      adapter = createAdapterFor(db, session.agentId, { conversationId: convId });
    } catch {
      res.status(409).json({ error: `no adapter registered for agent ${session.agentId}` });
      return;
    }
    if (!adapter.exciseNativeTurn) {
      res.status(409).json({ error: 'native excision not supported for this adapter' });
      return;
    }

    // turnIndex from the client is 0-indexed over turns[]; the adapter helper
    // is 1-indexed over isRealUserPrompt counting. Convert here so the boundary
    // lives in exactly one place (and is unit-tested at the route layer).
    let newNativeId: string;
    try {
      newNativeId = await adapter.exciseNativeTurn(session.nativeSessionId, body.turnIndex + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Single-turn file (operator tried to delete the only turn) → 400 with
      // actionable messaging. Out-of-range / not-found are also caller errors.
      if (/single-turn|out of range|not found/i.test(msg)) {
        res.status(400).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
      return;
    }

    // DB tx: drop the specific event ids, then re-point the session row at the
    // forked native id so the next resume reads the excised file.
    const deleted = db.transaction(() => {
      const n = deleteTurnEventsByIds(db, eventIds);
      setNativeSessionId(db, session.id, newNativeId);
      return n;
    })();

    // Refresh signal mirrors rewind: client refetches transcript + checkpoints.
    notifyCheckpoints(resolved, convId);

    res.json({ ok: true, deletedEvents: deleted, nativeSessionId: newNativeId });
  });
}
