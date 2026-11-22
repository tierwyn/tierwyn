import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import type { SpawnEdgeOutcome, SpawnRequest, SpawnResponse, SpawnResultResponse, SpawnTemplateRole, SpawnStopResponse, GrokBotLifecycleStatus, RemoteHostView, HandoffOverride } from '@tierwyn/shared';
import { agentSupportsPermissionMode, agentTakesBarePrompt, grokBotUsable, hostHasFeature, interactionModeRequiresPermissionCapable, monotonicChildSandbox, profileAvailableOnHost, resolveSpawnWorkdir, resolveSpawnDesignation, resolveTimerFireAt, TIMER_MAX_PROMPT_CHARS, agentDeferCapError, BARE_PROMPT_ADAPTERS } from '@tierwyn/shared';
import { frameSubagentProse, failureHint, proseFromEvents, sanitizeToken, shortReason } from '../spawn/prose.js';
import { tryMeshCallerRate } from '../mesh/rate.js';
import { watchChildResult, type ChildWatchResult } from '../spawn/watch.js';
import { stopChild } from '../spawn/stop.js';
import { listEventsForConversation } from '../repositories/events.js';
import { catalogue } from '../catalogue.js';
import { sessionHub } from '../sessionHub.js';
import { effectiveInteractionMode, type SessionManager } from '../sessionManager.js';
import { getProject } from '../repositories/projects.js';
import { isProjectMoving, PROJECT_MOVING_ERROR } from '../projectMove.js';
import {
  getConversation, createConversation, deleteConversation, childConversationIds, spawnPolicyDepth, isDescendedFrom, getStoppedAt,
} from '../repositories/conversations.js';
import { getTemplate, getCompactionSettings, listCustomDesignations } from '../repositories/settings.js';
import { resolveSandboxFor } from '../repositories/sandboxSettings.js';
import { sandboxCapability } from '../sandbox/capability.js';
import { resolveDescentOverride } from '../spawn/descentOverride.js';
import { isGitRepo, createWorktree } from '../worktree.js';
import { RemoteGitOps, WorkingTreeContextError, type GitNodeHub } from '../git/remoteOps.js';
import { getRemoteHost } from '../repositories/remoteHosts.js';
import { MAX_SPAWN_DEPTH } from '../spawn/config.js';
import { validateSpawnToken, validateMessageToken, peekSpawnToken, touchSpawnToken, getSpawnTokenTtlMs } from '../spawn/tokens.js';
import { redactAll } from '../secrets/redactAll.js';
import { canMessage } from '../mesh/policy.js';
import { deliverLateral } from '../mesh/deliver.js';
import { insertMeshAudit } from '../mesh/edges.js';
import { autoMintPeerRing } from '../mesh/autoEdges.js';
import {
  createSpawnRequest, getSpawnRequest, listPendingForConversation, listAllPending,
  approveSpawnRequest, denySpawnRequest, attachChild, expireStale, requeueSpawnRequest,
} from '../repositories/spawnRequests.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { createTimer, getPendingNonOperatorTimer } from '../repositories/conversationTimers.js';
import { createSpawnEdge, resolveSpawnEdge, getEdgeByChild } from '../repositories/spawnEdges.js';
import { assertGrokBotAllowedInProject } from '../repositories/remoteAgents.js';
import { bareChildResultPath } from '../promptText.js';
import { helpHint } from '../spawn/agentHelp.js';

/** Child conversation title — role/template identity only. The prompt's first
 *  line moves to the spawn marker prose (never the title). */
export function spawnChildTitle(roleOrLabel: string): string {
  return `↳ ${roleOrLabel}`;
}

/** Lateral POST /spawn/:id/message body cap, applied BEFORE frameSubagentProse
 *  so a tail-truncating adapter cannot drop the untrusted wrapper (F4).
 *  ~8k tokens; raise only with a reason. Descent (T0) is uncapped. */
const MESH_MAX_BYTES = 32 * 1024;

function messageErr(res: Response, status: 400 | 403 | 409, body: Record<string, unknown>): void {
  res.status(status).json({ ...body, ...helpHint('messaging') });
}

export const pendingMessageWaits = new Set<string>();

type GrokBotNewTurnGate = { ok: true } | { ok: false; status: 400 | 409; error: string };

/** Project-chats, usable, and one-desktop-busy gates for a grok-bot new turn.
 *  Fresh spawn and idle `/message` resume/profile-switch share this. Live
 *  mid-turn steer skips it — the composer is already owned by that session. */
function grokBotNewTurnGate(
  db: Database,
  deps: Deps,
  conversationId: string,
  projectId: string | undefined,
  profileId: string,
): GrokBotNewTurnGate {
  try {
    assertGrokBotAllowedInProject(db, conversationId, projectId, profileId, 'grok-bot');
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }
  if (!grokBotUsable(deps.grokBotStatus?.())) {
    return {
      ok: false,
      status: 400,
      error: 'grok-bot unavailable: the Grok Bot app is not running',
    };
  }
  if (deps.sessionManager.activeSessions().some((s) => s.agentType === 'grok-bot')) {
    return { ok: false, status: 409, error: 'grok-bot busy: one live Grok Bot turn at a time' };
  }
  return { ok: true };
}

/** Wall-clock wait from edge insert to now. Omit rather than 0/NaN if createdAt is unusable. */
function spawnEdgeDurationMs(createdAt: number): number | undefined {
  if (!Number.isFinite(createdAt)) return undefined;
  const ms = Date.now() - createdAt;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

interface Deps {
  getDb: () => Database;
  sessionManager: SessionManager;
  /** True when the request carries a valid operator session cookie (manual UI). */
  isAuthed: (req: Request) => boolean;
  grokBotStatus?: () => GrokBotLifecycleStatus | undefined;
  remoteHosts?: { view(hostId: string): RemoteHostView | undefined };
  nodeHub?: GitNodeHub;
}

interface SpawnAuth {
  bearer: boolean;
  manual: boolean;
  bearerToken?: string;
}

function checkSpawnAuth(req: Request, parentConversationId: string, deps: Deps): SpawnAuth | null {
  const header = req.headers.authorization;
  const headerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const bearer = validateSpawnToken(headerToken, parentConversationId);
  const manual = deps.isAuthed(req);
  if (!bearer && !manual) return null;
  return { bearer, manual, ...(bearer ? { bearerToken: headerToken } : {}) };
}

// ponytail: resolved Phase 3 — template → global fallback chain.
function approvalRequired(db: Database, parentConversationId?: string): boolean {
  if (parentConversationId) {
    const conv = getConversation(db, parentConversationId);
    if (conv?.templateName) {
      const template = getTemplate(db, conv.templateName);
      if (template?.spawnApprovalRequired !== undefined) {
        return template.spawnApprovalRequired === true;
      }
    }
  }
  return getCompactionSettings(db).spawnApprovalRequired === true;
}

/** Bearer spawns admitted past the cap whose child session isn't registered yet
 *  (worktree RPCs + handlePrompt's pre-registration awaits). Counted against the
 *  cap so concurrent POSTs can't all pass the live-session check. */
const pendingSpawns = new Map<string, number>();
export function pendingSpawnCount(parentId: string): number {
  return pendingSpawns.get(parentId) ?? 0;
}

type SpawnSlot = { release: () => void; handedOff: boolean };

function clientGone(req: Request, res: Response): boolean {
  return res.destroyed || req.socket.destroyed;
}

/** Client-gone / failed approve re-dispatch: return the row to the operator queue
 *  instead of stranding it in 'approved' or 'dispatched' with no live child. */
function requeueOnClientGone(db: Database, spawnRequestId: string | undefined): void {
  if (!spawnRequestId) return;
  db.prepare(`
    UPDATE spawn_requests
    SET child_conversation_id = NULL, status = 'pending', decided_at = NULL, decided_by = NULL
    WHERE id = ? AND status IN ('approved', 'dispatched')
  `).run(spawnRequestId);
}

/** Shared spawn dispatch (validate parent → create child → watch → handlePrompt).
 *  spawnRequestId: if set, this dispatch is fulfilling an approved pending request;
 *  attachChild() will link the resulting child conversation. */
async function dispatchSpawn(
  body: SpawnRequest,
  req: Request,
  res: Response,
  deps: Deps,
  auth: SpawnAuth,
  spawnRequestId?: string,
): Promise<void> {
  // Async spawns notify by default: the preamble tells the parent to end its turn
  // and not poll, so a silent async success would strand the pipeline.
  // Explicit notifyParent:false still opts out (fire-and-forget).
  body = { ...body, notifyParent: body.notifyParent ?? !body.wait };
  const slot: SpawnSlot = { release: () => {}, handedOff: false };
  try {
    await dispatchSpawnInner(body, req, res, deps, auth, spawnRequestId, slot);
  } finally {
    if (!slot.handedOff) slot.release();
  }
}

async function dispatchSpawnInner(
  body: SpawnRequest,
  req: Request,
  res: Response,
  deps: Deps,
  auth: SpawnAuth,
  spawnRequestId: string | undefined,
  slot: SpawnSlot,
): Promise<void> {
  const { getDb, sessionManager } = deps;
  const db = getDb();
  const prompt = body.prompt;

  // wait:true + approval flag: reject early before any row insert (no orphan).
  if (body.wait === true && approvalRequired(db, body.parentConversationId) && auth.bearer && !auth.manual) {
    res.status(400).json({ error: 'wait:true spawns are not allowed when spawn approval is required; use async spawn (wait:false)' });
    return;
  }

  if (!body.parentConversationId || !prompt?.trim()) {
    res.status(400).json({ error: 'parentConversationId and prompt are required' }); return;
  }
  const parent = getConversation(db, body.parentConversationId);
  if (!parent) { res.status(400).json({ error: 'unknown parent conversation' }); return; }
  if (spawnPolicyDepth(db, parent.id) >= MAX_SPAWN_DEPTH) {
    res.status(400).json({ error: 'depth limit: this conversation is too deep to spawn further children' }); return;
  }

  const role: string | undefined = body.role;
  let profileId = body.profileId;
  const template = parent.templateName ? getTemplate(db, parent.templateName) : undefined;
  let templateRole: SpawnTemplateRole | undefined;

  // 🔒 Bearer (agent-token) spawns may only pick delegates that appear on the parent's
  // template roster. The delegation preamble's role list is now *enforcement*, not advice:
  // a prompt-injected agent can no longer name an arbitrary enabled profileId (or
  // X-Spawn-Profile header) to escape its configured roster. Cookie/manual spawns (the
  // operator's Spawn modal) stay unrestricted — the operator authored the request.
  // ponytail: one branch on auth, no policy object — the roster lock is the only
  //   bearer-vs-manual difference in profile resolution.
  if (auth.bearer && !auth.manual) {
    if (!template || template.roles.length === 0) {
      res.status(400).json({ error: 'parent has no spawn template', ...helpHint('spawn') }); return;
    }
    if (role) {
      templateRole = template.roles.find((r) => r.role === role);
      if (!templateRole) {
        res.status(400).json({ error: `role "${role}" not found in the conversation template`, ...helpHint('spawn') }); return;
      }
      // Both sent → they must agree. The approve re-dispatch always sends both, and for
      // rows created from a role they agree by construction (profileId was resolved from
      // that role at queue time).
      if (profileId && profileId !== templateRole.profileId) {
        res.status(400).json({
          error: `role "${role}" maps to profile ${templateRole.profileId}, not ${profileId}`,
          ...helpHint('spawn'),
        }); return;
      }
      profileId = templateRole.profileId;
    } else {
      if (!profileId) { res.status(400).json({ error: 'profileId or role required', ...helpHint('spawn') }); return; }
      templateRole = template.roles.find((r) => r.profileId === profileId);
      if (!templateRole) {
        res.status(400).json({ error: 'profile not in parent template roster', ...helpHint('spawn') }); return;
      }
    }
  } else {
    // Manual (operator cookie) — unchanged behaviour: any enabled catalogue profile,
    // template optional.
    if (!profileId && role) {
      templateRole = template?.roles.find((r) => r.role === role);
      if (!templateRole) { res.status(400).json({ error: `role "${role}" not found in the conversation template`, ...helpHint('spawn') }); return; }
      profileId = templateRole.profileId;
    } else if (profileId && template) {
      templateRole = template.roles.find((r) => r.profileId === profileId);
    }
    if (!profileId) { res.status(400).json({ error: 'profileId or role required', ...helpHint('spawn') }); return; }
  }
  const profile = catalogue.getProfile(profileId);
  if (!profile || !profile.enabled) { res.status(400).json({ error: `unknown or disabled profile: ${profileId}` }); return; }

  const parentProject = getProject(db, parent.projectId);
  if (parentProject?.remoteHostId) {
    const avail = profileAvailableOnHost(profile, deps.remoteHosts?.view(parentProject.remoteHostId));
    if (!avail.ok) {
      res.status(400).json({ error: 'not available on host', reason: avail.reason });
      return;
    }
  }

  if (profile.agentType === 'grok-bot') {
    const gate = grokBotNewTurnGate(db, deps, parent.id, parent.projectId, profileId);
    if (!gate.ok) {
      res.status(gate.status).json({ error: gate.error });
      return;
    }
  }

  const designationResult = resolveSpawnDesignation({
    ...(Object.prototype.hasOwnProperty.call(body, 'designation') ? { requested: body.designation } : {}),
    roleDefault: templateRole?.defaultDesignation,
    custom: listCustomDesignations(db),
  });
  if (!designationResult.ok) {
    res.status(400).json({ error: designationResult.error }); return;
  }
  const designation = designationResult.token;

  // Phase 4: reject spawn to bypass-only agent only in full 'prompt' mode.
  // ponytail: children always run bypass internally, but we still reject so the operator
  // knows they've configured an incompatible role for this permission mode.
  const parentMode = effectiveInteractionMode(db, body.parentConversationId);
  if (interactionModeRequiresPermissionCapable(parentMode) && !agentSupportsPermissionMode(profile.agentType)) {
    res.status(400).json({
      error: `Agent ${profile.label} (${profile.agentType}) does not support permission mode '${parentMode}' — use claude-code, codex, or hermes`,
    });
    return;
  }

  const { bearer, manual } = auth;

  // Approval gate: bearer-initiated spawn queued for operator approval when flag is on.
  // Placement: AFTER profile validation (profile is confirmed enabled), BEFORE breadth cap
  // (breadth cap fires at approve time instead — parity with design doc §Layer3).
  // Skip if spawnRequestId is set — this IS the approved re-dispatch, not a new request.
  if (!spawnRequestId && approvalRequired(db, body.parentConversationId) && bearer && !manual) {
    const parentSessionId = sessionManager.activeSessionForConversation(parent.id)?.id ?? '';
    const pendingRow = createSpawnRequest(db, {
      parentConversationId: parent.id,
      parentSessionId,
      role,
      profileId,
      prompt: redactAll(body.prompt),
      workdir: body.workdir,
      wait: body.wait ?? false,
      notifyParent: body.notifyParent ?? false,
      designation,
    });
    sessionHub.broadcastAll({ type: 'spawn_request_updated', conversationId: parent.id });
    res.status(202).json({ requestId: pendingRow.id, status: 'pending' });
    return;
  }

  if (bearer && !manual) {
    // Parked / reaped / restarted parents have no in-memory record (and the approve
    // re-dispatch at /spawn/requests/:id/approve almost never does) — fall back to the
    // last persisted session's profile so the cap still applies. Same chain as the
    // parent-identity resolution 30 lines below.
    const spawnerProfileId = sessionManager.activeSessionForConversation(parent.id)?.profileId
      ?? lastSessionForConversation(db, parent.id)?.agentModelId;
    const spawnerProfile = spawnerProfileId ? catalogue.getProfile(spawnerProfileId) : undefined;
    if (spawnerProfile) {
      // Schedule ⏱ runs are spawn-policy depth 0 (maxConcurrentSpawns) even when
      // parented under schedule_home for the sidebar.
      const cap = (spawnPolicyDepth(db, parent.id) === 0
        ? spawnerProfile?.maxConcurrentSpawns
        : spawnerProfile?.maxGrandchildSpawns) ?? 0;
      const childIds = new Set(childConversationIds(db, parent.id));
      const all = sessionManager.activeSessions().filter((s) => childIds.has(s.conversationId));
      const TERMINAL = new Set(['idle', 'done', 'error']);
      const isLive = (s: { lastStatus?: string }) => !s.lastStatus || !TERMINAL.has(s.lastStatus);
      for (const s of all) if (!isLive(s)) void sessionManager.stopSession(s.id);
      const live = all.filter(isLive);
      const pending = pendingSpawnCount(parent.id);
      if (live.length + pending >= cap) {
        const detail = live.map((s) => ({
          conversationId: s.conversationId,
          lastStatus: s.lastStatus ?? 'unknown',
          ageSeconds: Math.round((Date.now() - s.startedAt) / 1000),
        }));
        res.status(429).json({
          error: `too many active sub-agents (${live.length + pending}/${cap}) for this profile`,
          active: detail,
        }); return;
      }
      pendingSpawns.set(parent.id, pending + 1);
      let released = false;
      slot.release = () => {
        if (released) return;
        released = true;
        const n = pendingSpawnCount(parent.id) - 1;
        if (n > 0) pendingSpawns.set(parent.id, n); else pendingSpawns.delete(parent.id);
      };
    }
  }

  const project = getProject(db, parent.projectId)!;
  if (isProjectMoving(project.id)) {
    res.status(409).json({ error: PROJECT_MOVING_ERROR });
    return;
  }

  // 4b. Parent profile identity (for marker + future preamble use)
  const parentProfileId = sessionManager.activeSessionForConversation(parent.id)?.profileId
    ?? lastSessionForConversation(db, parent.id)?.agentModelId;
  const parentProfileLabel = parentProfileId
    ? (catalogue.getProfile(parentProfileId)?.label ?? parentProfileId)
    : undefined;

  // 4a. Unified workdir resolver — manual (cookie) beats pin, bearer loses to pin.
  const resolved = resolveSpawnWorkdir({
    manualChoice: manual ? body.workdir : undefined,
    conversationPin: parent.spawnWorkdir ?? null,
    requestWorkdir: manual ? undefined : body.workdir,
    roleDefault: templateRole?.defaultWorkdir,
    globalDefault: getCompactionSettings(db).defaultSpawnWorkdir,
  });
  const mode = resolved.workdir;
  const remoteHostId = project.remoteHostId;
  const hostHello = remoteHostId
    ? (deps.remoteHosts?.view(remoteHostId)?.hello ?? getRemoteHost(db, remoteHostId)?.hello)
    : undefined;
  const remoteSupportsWorktree = Boolean(remoteHostId && deps.nodeHub && hostHasFeature(hostHello, 'git.worktree'));
  const wantWorktree = mode === 'worktree' && !body.confirmShared && (!remoteHostId || remoteSupportsWorktree);
  let repoOk = false;
  if (wantWorktree) {
    if (remoteHostId) {
      try {
        if (clientGone(req, res)) {
          requeueOnClientGone(db, spawnRequestId);
          return;
        }
        const ops = new RemoteGitOps(deps.nodeHub!, remoteHostId);
        repoOk = (await ops.readWorkingTree(project.rootPath)).isRepo;
      } catch (err) {
        if (!res.headersSent) {
          const status = err instanceof WorkingTreeContextError ? err.status : 502;
          res.status(status).json({
            error: 'failed to access remote worktree',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    } else {
      repoOk = isGitRepo(project.rootPath);
    }
  }
  if (wantWorktree && !repoOk && !body.confirmShared) {
    res.status(409).json({
      warning: 'not a git repo; worktree unavailable',
      wouldRunIn: 'shared',
      retryWith: { confirmShared: true },
    });
    return;
  }

  if (clientGone(req, res)) {
    requeueOnClientGone(db, spawnRequestId);
    return;
  }

  const firstLine = prompt.trim().split('\n')[0].slice(0, 60);
  const parentAgent = sessionManager.activeSessionForConversation(parent.id)?.agentType
    ?? lastSessionForConversation(db, parent.id)?.agentId
    ?? '';
  const parentEff = resolveSandboxFor(
    db,
    parent,
    project,
    parentAgent,
    parentAgent ? sandboxCapability(project.remoteHostId ?? 'hub', parentAgent, hostHello) : null,
  );
  const child = createConversation(db, {
    projectId: parent.projectId,
    title: spawnChildTitle(role || profile.label),
    parentConversationId: parent.id,
    templateName: parent.templateName,
    designation,
    // Spawn children live inside the parent's grant — the child's tokens are
    // minted from its own (inherited) profile at issue time.
    capabilityProfile: parent.capabilityProfile,
    // Children get only the role's MCP servers (the resolver never applies the
    // template default to a child conversation).
    ...(templateRole?.mcpServers ? { mcpServers: templateRole.mcpServers } : {}),
    sandbox: monotonicChildSandbox(parentEff),
  });
  // Link the pending row to the child conversation (approve re-dispatch path).
  if (spawnRequestId) {
    attachChild(db, spawnRequestId, child.id);
  }
  const edge = createSpawnEdge(db, {
    parentConversationId: parent.id,
    childConversationId: child.id,
    role,
    profileId,
    notifyParent: body.notifyParent ?? false,
  });
  // Auto-mint the mesh ring. Gated on meshMessaging inside autoMintPeerRing —
  // with the kill switch off this writes nothing at all.
  autoMintPeerRing(db, { parentId: parent.id, childId: child.id });
  let cwd = project.rootPath;
  let workdirPath: string | undefined;
  if (repoOk) {
    if (remoteHostId) {
      // ponytail: create-then-delete instead of a preflight RPC; add a worktreeParentAllowed read if the delete ever leaves residue.
      try {
        const ops = new RemoteGitOps(deps.nodeHub!, remoteHostId);
        const wt = await ops.createSpawnWorktree(project.rootPath, child.id);
        if (clientGone(req, res)) {
          requeueOnClientGone(db, spawnRequestId);
          deleteConversation(db, child.id);
          console.warn('[spawn] client gone after remote worktree create; residue left on host', wt.path);
          return;
        }
        cwd = wt.path;
        workdirPath = `${wt.path} (${wt.branch})`;
        db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run(wt.path, child.id);
      } catch (err) {
        requeueOnClientGone(db, spawnRequestId);
        deleteConversation(db, child.id);
        const reason = err instanceof Error ? err.message : String(err);
        res.status(409).json({
          warning: `worktree unavailable on host: ${reason}`,
          wouldRunIn: 'shared',
          retryWith: { confirmShared: true },
        });
        return;
      }
    } else {
      const wt = createWorktree(project.rootPath, child.id);
      cwd = wt.path;
      workdirPath = `${wt.path} (${wt.branch})`;
      db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run(wt.path, child.id);
    }
  }

  // 4c. Loud marker — names the parent profile and records any pin-vs-request suppression.
  const suppressionNote = resolved.suppressed
    ? ` (workdir pinned: ${mode}; request asked ${resolved.suppressed.workdir})`
    : '';
  const byNote = parentProfileLabel ? ` by parent (${parentProfileLabel})` : '';
  sessionManager.recordSpawnMarker(parent.id, {
    kind: 'spawned', childConversationId: child.id, childTitle: child.title,
    text: `⇪ spawned → ${child.title} — ${firstLine}${byNote}${suppressionNote}`, role, workdir: workdirPath,
  });

  // Stall owns its side-effects (marker + edge + optional server-authored notify).
  // Rejection must NOT also call onResult → no fake `◀ result:` with mid-turn prose.
  let stalledHandled = false;

  const watcher = watchChildResult(child.id, {
    onHeartbeat: () => {}, // stall clock still ticks; UI uses a single live timer, not stacked markers
    onStalled: (childId, silentMs) => {
      stalledHandled = true;
      resolveSpawnEdge(db, edge.id, 'stalled', 'stalled'); // 🔒 concern 7: CAS — losers are no-ops
      const durationMs = spawnEdgeDurationMs(edge.createdAt);
      sessionManager.recordSpawnMarker(parent.id, {
        kind: 'stalled', childConversationId: childId,
        text: `⏱ ${childId} stalled: no output for ${Math.round(silentMs / 1000)}s`,
        role, workdir: workdirPath,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      const stuck = sessionManager.activeSessionForConversation(childId);
      if (stuck) void sessionManager.stopSession(stuck.id);
      // Server-authored interrupted text only — never re-feed truncated child prose.
      // A stall is a death notice: deliver it even when notifyParent is false.
      if (!body.wait) {
        const who = role ?? profile.label;
        sessionManager.notifyParentSubagentResult(
          parent.id,
          `Sub-agent (${who}) stalled after ${Math.round(silentMs / 1000)}s with no output. `
            + `Its partial transcript is available via GET /spawn/${childId}/result`
            + `?parentConversationId=${parent.id}. Re-spawn it if the task still matters.`,
          { role: who, childConversationId: childId },
        );
      }
    },
  });

  let childSessionId: string | undefined;
  const onResult = ({ prose, degenerate, errored, errorMessage }: ChildWatchResult) => {
    // CAS: only publish a result if THIS caller won the edge transition. If the edge was
    // already interrupted/stalled (boot reconcile, stall path), a late watcher resolution
    // must NOT emit a premature `◀ result:` with mid-turn prose.
    const outcome: SpawnEdgeOutcome = errored ? 'failed' : degenerate ? 'degenerate' : 'success';
    if (!resolveSpawnEdge(db, edge.id, 'resolved', outcome)) {
      const sid = childSessionId ?? sessionManager.activeSessionForConversation(child.id)?.id;
      if (sid) void sessionManager.stopWhenSettled(child.id, sid);
      watcher.cancel();
      return;
    }
    const marker = errored
      ? `⚠ ◀ child failed: ${shortReason(errorMessage) || prose || 'no output'}`
      : degenerate ? `⚠ ◀ result (degenerate): ${prose}` : `◀ result: ${prose}`;
    const durationMs = spawnEdgeDurationMs(edge.createdAt);
    sessionManager.recordSpawnMarker(parent.id, {
      kind: 'result', childConversationId: child.id,
      text: marker, role, workdir: workdirPath,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    const sid = childSessionId ?? sessionManager.activeSessionForConversation(child.id)?.id;
    if (sid) void sessionManager.stopWhenSettled(child.id, sid);
    // notifyParent:false means "don't re-feed my result prose", not "don't tell
    // me the child died" — a failed child has no result to fetch, so the
    // fire-and-forget assumption is void. Hard failures always notify. The
    // adapter's error text is NOT server-authored (denial messages echo
    // agent-chosen commands; CLI result.error can quote model output), so it
    // travels inside the untrusted frame's <error> block, with a
    // server-authored failureHint appended outside it (G4).
    const who = role ?? profile.label;
    if (!body.wait && (body.notifyParent || errored)) {
      const notifyText = errored
        ? frameSubagentProse(prose, { role: who, childConversationId: child.id, failed: true, error: errorMessage })
          + failureHint(child.id, parent.id, errorMessage)
        : degenerate
          ? `${frameSubagentProse(prose, { role: who, childConversationId: child.id, error: errorMessage })}\n\n⚠ This may be incomplete. Re-fetch the child's full transcript with your spawn token:\n`
            + `GET /spawn/${child.id}/result?parentConversationId=${parent.id}`
          : frameSubagentProse(prose, { role: who, childConversationId: child.id });
      sessionManager.notifyParentSubagentResult(
        parent.id,
        notifyText,
        { role: who, childConversationId: child.id },
      );
    }
    watcher.cancel();
  };

  if (clientGone(req, res)) {
    watcher.cancel();
    requeueOnClientGone(db, spawnRequestId);
    deleteConversation(db, child.id);
    if (workdirPath) console.warn('[spawn] client gone before hand-off; worktree residue', workdirPath);
    return;
  }

  slot.handedOff = true;
  // ponytail: effort applies to the child's first turn and any held-open/parked
  // session. Follow-up turns that start a fresh process (`/spawn/:id/message` →
  // mesh/deliver.ts, sessionManager parent_message paths) do not re-read the
  // template role, so a later respawn runs at the CLI default. Persist effort
  // on the child conversation, or look up the role in those call sites, if the
  // operator reports it.
  void sessionManager.handlePrompt({
    projectId: parent.projectId,
    conversationId: child.id,
    agent: profile.agentType,
    model: profile.model,
    profileId,
    text: redactAll(prompt),
    cwd,
    interactionMode: 'bypass',
    ...(templateRole?.effort ? { effort: templateRole.effort } : {}),
  }).then((sid) => {
    childSessionId = sid;
  }).catch((err: unknown) => watcher.fail(err instanceof Error ? err.message : String(err)))
    .finally(slot.release);

  if (body.wait) {
    req.setTimeout(0); res.setTimeout(0);
    // Caller is provably live while blocked here (not descendant-based keepalive):
    // slide its own bearer so it can still act when the child returns. No-op for cookie/approve.
    const keepAlive = auth.bearerToken
      ? setInterval(() => touchSpawnToken(auth.bearerToken), getSpawnTokenTtlMs() / 3)
      : undefined;
    keepAlive?.unref();
    try {
      const result = await watcher.promise;
      onResult(result);
      const out: SpawnResponse = {
        conversationId: child.id,
        workdir: workdirPath ?? cwd,
        result: result.prose,
        errored: result.errored,
        ...(result.stopped ? { stopped: true } : {}),
        ...(agentTakesBarePrompt(profile.agentType)
          ? { resultPath: bareChildResultPath(cwd, role, child.id) }
          : {}),
        ...(mode === 'worktree' && !wantWorktree && !body.confirmShared
          ? { workdirNote: 'worktree unavailable on remote host; ran shared' }
          : {}),
      };
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Stall already wrote its marker (+ optional notify); don't fake a ◀ result.
      if (!stalledHandled) onResult({ prose: msg, degenerate: false, errored: true });
      res.status(504).json({ error: msg });
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      touchSpawnToken(auth.bearerToken);
    }
    return;
  }

  void watcher.promise.then(
    onResult,
    (err: Error) => {
      if (stalledHandled) {
        watcher.cancel();
        return;
      }
      onResult({ prose: err.message, degenerate: false, errored: true });
    },
  );
  const out: SpawnResponse = {
    conversationId: child.id,
    workdir: workdirPath ?? cwd,
    errored: false,
    ...(agentTakesBarePrompt(profile.agentType)
      ? { resultPath: bareChildResultPath(cwd, role, child.id) }
      : {}),
    ...(mode === 'worktree' && !wantWorktree && !body.confirmShared
      ? { workdirNote: 'worktree unavailable on remote host; ran shared' }
      : {}),
  };
  res.json(out);
}

export function registerSpawnRoutes(app: Express, deps: Deps): void {
  app.post('/spawn', async (req, res) => {
    const body = req.body as SpawnRequest;
    if (!body.parentConversationId || !body.prompt) {
      res.status(400).json({ error: 'parentConversationId and prompt are required' }); return;
    }
    const auth = checkSpawnAuth(req, body.parentConversationId, deps);
    if (!auth) { res.status(401).json({ error: 'spawn requires a valid token or operator session — if your bearer was rotated or revoked, use the token from your most recent delegation preamble or stub; earlier bearers are dead' }); return; }
    await dispatchSpawn(body, req, res, deps, auth);
  });

  // Raw-body transport for agent delegation: prompt bytes in the request body
  // (curl --data-binary @file), envelope in X-Spawn-* headers. No server-side
  // path read — same security model as inline POST /spawn JSON prompt.
  app.post('/spawn/raw', async (req, res) => {
    const parentConversationId = req.header('x-spawn-parent') ?? '';
    if (!parentConversationId) {
      res.status(400).json({ error: 'X-Spawn-Parent header required' }); return;
    }
    const auth = checkSpawnAuth(req, parentConversationId, deps);
    if (!auth) { res.status(401).json({ error: 'spawn requires a valid token or operator session — if your bearer was rotated or revoked, use the token from your most recent delegation preamble or stub; earlier bearers are dead' }); return; }

    const prompt = typeof req.body === 'string' ? req.body : '';
    if (!prompt.trim()) {
      res.status(400).json({ error: 'empty prompt body' }); return;
    }

    const role = req.header('x-spawn-role') ?? undefined;
    const profileId = req.header('x-spawn-profile') ?? undefined;
    if (!role && !profileId) {
      res.status(400).json({ error: 'X-Spawn-Role or X-Spawn-Profile required', ...helpHint('spawn') }); return;
    }

    const workdirRaw = req.header('x-spawn-workdir');
    const body: SpawnRequest = {
      parentConversationId,
      role,
      profileId,
      prompt,
      wait: req.header('x-spawn-wait') === 'true',
      notifyParent: req.header('x-spawn-notify') === undefined ? undefined : req.header('x-spawn-notify') === 'true',
      workdir: workdirRaw === 'shared' || workdirRaw === 'worktree' ? workdirRaw : undefined,
      confirmShared: req.header('x-spawn-confirm-shared') === 'true',
      ...(req.header('x-spawn-designation') !== undefined
        ? { designation: req.header('x-spawn-designation') }
        : {}),
    };
    await dispatchSpawn(body, req, res, deps, auth);
  });

  // ── Spawn request queue (Phase 1 approval gate) ─────────────────────────

  /** List pending spawn requests. Cookie-only — never bearer.
   *  Without `parentConversationId`, returns ALL pending requests across every
   *  conversation — the approval queue is operator-global (a request must be
   *  approvable regardless of which conversation is currently open). The query
   *  param is still accepted for callers that want to scope to one conversation. */
  app.get('/spawn/requests', (req, res) => {
    if (!deps.isAuthed(req)) { res.status(403).json({ error: 'operator session required' }); return; }
    const parentConversationId = req.query.parentConversationId as string | undefined;
    const db = deps.getDb();
    expireStale(db);
    const requests = parentConversationId
      ? listPendingForConversation(db, parentConversationId)
      : listAllPending(db);
    res.json({ requests });
  });

  /** Approve a pending spawn request. Cookie-only — never bearer.
   *  Re-dispatches as { bearer:true, manual:false } so the breadth cap fires at approve time.
   *  // ponytail: approve re-dispatches as bearer so the existing breadth cap fires at
   *  //   approve time, not request time — parity with parent doc §Layer3. */
  app.post('/spawn/requests/:id/approve', async (req, res) => {
    if (!deps.isAuthed(req)) { res.status(403).json({ error: 'operator session required' }); return; }
    const db = deps.getDb();
    expireStale(db);
    const row = getSpawnRequest(db, req.params.id);
    if (!row) { res.status(404).json({ error: 'spawn request not found' }); return; }
    const won = approveSpawnRequest(db, row.id);
    if (!won) {
      const current = getSpawnRequest(db, row.id)!;
      res.status(409).json({ ok: false, status: current.status }); return;
    }
    sessionHub.broadcastAll({ type: 'spawn_request_updated', conversationId: row.parentConversationId });
    // Reconstruct the SpawnRequest body from the stored row and re-dispatch.
    const spawnBody: SpawnRequest = {
      parentConversationId: row.parentConversationId,
      profileId: row.profileId,
      role: row.role,
      prompt: row.prompt,
      wait: row.wait,
      workdir: row.workdir,
      notifyParent: row.notifyParent,
      designation: row.designation ?? '',
    };
    // A rejected re-dispatch (e.g. the breadth cap's 429, which for parked
    // parents only fires at approve time) must roll the row back to 'pending'
    // instead of stranding it in 'approved' with no child attached — a state
    // nothing reads or recovers. Every rejection path in dispatchSpawn responds
    // with an error status BEFORE createConversation/attachChild; success is 200
    // with the row already flipped to 'dispatched'.
    await dispatchSpawn(spawnBody, req, res, deps, { bearer: true, manual: false }, row.id);
    if (res.statusCode >= 400) requeueSpawnRequest(db, row.id);
  });

  /** Deny a pending spawn request. Cookie-only — never bearer.
   *  Emits a 'denied' spawn marker + subagent_notify to the parent. */
  app.post('/spawn/requests/:id/deny', (req, res) => {
    if (!deps.isAuthed(req)) { res.status(403).json({ error: 'operator session required' }); return; }
    const db = deps.getDb();
    const row = getSpawnRequest(db, req.params.id);
    if (!row) { res.status(404).json({ error: 'spawn request not found' }); return; }
    const reason = (req.body as { reason?: string } | undefined)?.reason;
    const won = denySpawnRequest(db, row.id, reason);
    if (!won) {
      const current = getSpawnRequest(db, row.id)!;
      res.status(409).json({ ok: false, status: current.status }); return;
    }
    // Notify the parent agent that the spawn was denied.
    const text = `Spawn request denied${reason ? `: ${reason}` : ''} — role: ${row.role ?? row.profileId ?? 'unknown'}`;
    deps.sessionManager.recordSpawnMarker(row.parentConversationId, {
      kind: 'denied', childConversationId: '',  // ponytail: no child created; '' keeps web grouping compat
      text: `✗ spawn denied: ${row.role ?? row.profileId ?? 'unknown'}`, role: row.role,
    });
    deps.sessionManager.notifyParentSubagentResult(
      row.parentConversationId, text,
      { role: row.role },  // ponytail: childConversationId omitted (optional) — no child was created
    );
    sessionHub.broadcastAll({ type: 'spawn_request_updated', conversationId: row.parentConversationId });
    res.json({ ok: true, requestId: row.id, status: 'denied' });
  });

  // ── End approval gate routes ─────────────────────────────────────────

  app.get('/spawn/:childConversationId/result', (req, res) => {
    const { getDb } = deps;
    const db = getDb();
    const { childConversationId } = req.params;
    const parentConversationId = req.query.parentConversationId as string | undefined;

    const header = req.headers.authorization;
    const headerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const bearer = !!parentConversationId && validateSpawnToken(headerToken, parentConversationId);
    const manual = deps.isAuthed(req);
    if (!bearer && !manual) {
      res.status(401).json({ error: 'spawn result fetch requires a valid token or operator session' }); return;
    }

    const child = getConversation(db, childConversationId);
    if (!child) {
      res.status(404).json({ error: 'child conversation not found' }); return;
    }

    if (parentConversationId && !isDescendedFrom(db, childConversationId, parentConversationId)) {
      res.status(403).json({ error: 'child conversation is not descended from the specified parent' }); return;
    }

    const events = listEventsForConversation(db, childConversationId);
    // Same delta-reassembly as the push route: raw rows are streamed deltas, a
    // `join('\n\n')` over them shreds mid-word text and breaks markdown.
    const prose = proseFromEvents(events);

    const stoppedAt = getStoppedAt(db, childConversationId);
    const out: SpawnResultResponse = {
      conversationId: childConversationId,
      parentConversationId: parentConversationId ?? child.parentConversationId ?? '',
      prose,
      degenerate: prose === '',
      events,
      ...(stoppedAt != null ? { stoppedAt } : {}),
    };
    res.json(out);
  });

  /** Parent-authorized kill of a strict descendant. Unlike /message, parentConversationId
   *  is accepted from JSON body, query, or X-Spawn-Parent (spec asks for the aliases). */
  app.post('/spawn/:childConversationId/stop', async (req, res) => {
    const { childConversationId } = req.params;
    const rawBody = req.body;
    const body = (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody))
      ? rawBody as Record<string, unknown>
      : {};

    if (body.parentConversationId !== undefined && typeof body.parentConversationId !== 'string') {
      res.status(400).json({ error: 'parentConversationId must be a string' }); return;
    }
    const graceRaw = body.graceMs;
    if (graceRaw !== undefined && (typeof graceRaw !== 'number' || !Number.isFinite(graceRaw) || graceRaw < 0)) {
      res.status(400).json({ error: 'graceMs must be a non-negative number' }); return;
    }
    const graceMs = graceRaw === undefined ? 3000 : Math.min(15000, Math.floor(graceRaw));

    let parentConversationId = (typeof body.parentConversationId === 'string' && body.parentConversationId.trim())
      ? body.parentConversationId
      : '';
    if (!parentConversationId) {
      const q = req.query.parentConversationId;
      if (typeof q === 'string' && q.trim()) parentConversationId = q;
    }
    if (!parentConversationId) {
      const h = req.header('x-spawn-parent');
      if (typeof h === 'string' && h.trim()) parentConversationId = h;
    }
    if (!parentConversationId) {
      res.status(400).json({ error: 'parentConversationId required (JSON body, query, or X-Spawn-Parent)' }); return;
    }

    const auth = checkSpawnAuth(req, parentConversationId, deps);
    if (!auth) {
      res.status(401).json({ error: 'spawn requires a valid token or operator session — if your bearer was rotated or revoked, use the token from your most recent delegation preamble or stub; earlier bearers are dead' }); return;
    }

    if (childConversationId === parentConversationId) {
      res.status(400).json({ error: 'cannot stop yourself' }); return;
    }

    const db = deps.getDb();
    const child = getConversation(db, childConversationId);
    if (!child) {
      res.status(404).json({ error: 'child conversation not found' }); return;
    }
    if (!isDescendedFrom(db, childConversationId, parentConversationId)) {
      res.status(403).json({ error: 'target conversation is not a strict descendant of the specified parent' }); return;
    }

    try {
      const out: SpawnStopResponse = await stopChild(deps.sessionManager, {
        childId: childConversationId,
        callerId: parentConversationId,
        graceMs,
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Talk-back: a validated ancestor messages a STRICT descendant (T0), or a
   *  mesh-adjacent peer with a live edge (T3). Bearer token scoped to
   *  parentConversationId (spawn OR mesh), or operator cookie.
   *  Lateral `text` is capped at MESH_MAX_BYTES (32 KiB utf8) before framing. */
  app.post('/spawn/:childConversationId/message', async (req, res) => {
    const db = deps.getDb();
    const { childConversationId } = req.params;
    const body = req.body as {
      parentConversationId?: string;
      text?: string;
      profileId?: string;
      role?: string;
      handoff?: HandoffOverride;
      fireInMs?: number;
      fireAtMs?: number;
      notifyParent?: boolean;
      wait?: boolean;
    } | undefined;
    const parentConversationId = body?.parentConversationId ?? '';
    const text = body?.text ?? '';

    // Adversary review S1-1 (58908b8): every body field must be a string before
    // any .trim() runs (descentOverride, the text check below). A numeric
    // role/profileId — or an object text — threw inside this async handler,
    // and Express 4 + Node ≥15 turn an unhandled rejection into process exit.
    // Present-but-wrong-type only: absent fields keep flowing to the existing
    // shape checks so their error messages stay stable.
    if ((body?.parentConversationId !== undefined && typeof body.parentConversationId !== 'string')
      || (body?.text !== undefined && typeof body.text !== 'string')
      || (body?.profileId !== undefined && typeof body.profileId !== 'string')
      || (body?.role !== undefined && typeof body.role !== 'string')) {
      messageErr(res, 400, { error: 'parentConversationId, text, profileId and role must be strings' }); return;
    }
    if ((body?.notifyParent !== undefined && typeof body.notifyParent !== 'boolean')
      || (body?.wait !== undefined && typeof body.wait !== 'boolean')) {
      messageErr(res, 400, { error: 'notifyParent and wait must be booleans' }); return;
    }
    if (body?.handoff !== undefined && body.handoff !== 'fresh' && body.handoff !== 'summary' && body.handoff !== 'transcript') {
      messageErr(res, 400, { error: 'handoff must be one of fresh, summary, transcript' }); return;
    }

    const header = req.headers.authorization;
    const headerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    // Shape before credentials: without parentConversationId the token can't be
    // validated at all, so a 401 here would blame the token for a body typo
    // (text/plain body, query param, or X-Spawn-Parent header — all ignored).
    if (!parentConversationId) {
      messageErr(res, 400, { error: 'parentConversationId and text are required in a JSON body' }); return;
    }
    const bearer = validateMessageToken(headerToken, parentConversationId);
    const manual = deps.isAuthed(req);
    if (!bearer && !manual) {
      // Disambiguate the failure: a live token bound to a DIFFERENT conversation
      // used to draw the same 401 as a dead token, which sent agents hunting for
      // a token rotation that never happened (smoke-test Phase-2 deadlock). Name
      // the bound id so one retry self-corrects. Like the 429 flood gate below,
      // these denials stay unaudited — they sit before the rate limiter, and
      // auditing pre-gate denials would re-open the flood.
      const entry = peekSpawnToken(headerToken);
      if (entry && entry.conversationId !== parentConversationId) {
        messageErr(res, 403, {
          error: `token is bound to conversation ${entry.conversationId}; send it as parentConversationId`,
          decision: 'denied_sender_mismatch',
        }); return;
      }
      if (entry) {
        messageErr(res, 403, { error: 'token lacks spawn and mesh capability', decision: 'denied_token_scope' }); return;
      }
      res.status(401).json({ error: 'message requires a valid token or operator session' }); return;
    }
    if (!text.trim()) { messageErr(res, 400, { error: 'text is required' }); return; }

    const child = getConversation(db, childConversationId);
    if (!child) { res.status(404).json({ error: 'child conversation not found' }); return; }

    const tokenEntry = peekSpawnToken(headerToken);
    const ctx = {
      callerKind: (bearer ? 'agent' : 'operator') as 'agent' | 'operator',
      tokenScope: tokenEntry?.scope,
    };
    // Flood cap before canMessage so denied_wrong_tree spam cannot fill mesh_messages.
    // Skipped while messaging is off so the T0 off-invariant stays byte-identical.
    // A 429 here is NOT audited — auditing it would re-open the flood.
    const meshOn = getCompactionSettings(db).meshMessaging === 'tree';
    if (meshOn) {
      const gate = tryMeshCallerRate({ callerId: parentConversationId });
      if (!gate.ok) {
        res.setHeader('Retry-After', String(gate.retryAfter));
        res.status(429).json({ error: 'rate limited', decision: 'denied_rate', retryAfter: gate.retryAfter }); return;
      }
    }
    const decision = canMessage(db, parentConversationId, childConversationId, ctx);

    if (!decision.ok) {
      if (!meshOn) {
        messageErr(res, 403, { error: 'target conversation is not a strict descendant of the specified parent' }); return;
      }
      insertMeshAudit(db, {
        callerKind: ctx.callerKind,
        fromConversation: parentConversationId,
        toConversation: childConversationId,
        decision: decision.decision,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
      if (decision.status === 429) {
        res.setHeader('Retry-After', String(decision.retryAfter ?? 1));
        res.status(429).json({ error: 'rate limited', decision: decision.decision, retryAfter: decision.retryAfter }); return;
      }
      messageErr(res, 403, { error: decision.decision, decision: decision.decision }); return;
    }

    const hop = decision.hop ?? 1;

    const last = lastSessionForConversation(db, parentConversationId);
    const role = last?.agentModelId ? catalogue.getProfile(last.agentModelId)?.label : undefined;

    if (decision.via !== 'descent') {
      if (body?.wait !== undefined || body?.notifyParent !== undefined) {
        messageErr(res, 400, { error: 'notifyParent and wait are only supported on descent messages' }); return;
      }
      if (body?.handoff !== undefined) {
        messageErr(res, 400, { error: 'handoff is only supported on descent messages' }); return;
      }
    }

    if (decision.via === 'descent') {
      // Adversary review S2-1 (58908b8): mirror the lateral path — scrub live
      // spawn tokens before the text is framed, delivered, or persisted into a
      // deferred agent-resume timer that fires hours later.
      let outbound = redactAll(text);
      if (bearer) {
        outbound = frameSubagentProse(outbound, {
          role,
          childConversationId: parentConversationId,
          downward: true,
        });
      }
      const parentConv = getConversation(db, parentConversationId);
      const childTemplate = child.templateName ? getTemplate(db, child.templateName) : undefined;
      const parentTemplate = parentConv?.templateName ? getTemplate(db, parentConv.templateName) : undefined;
      const resolved = resolveDescentOverride({
        bearer: !!bearer, manual,
        childTemplate, parentTemplate,
        role: body?.role, profileId: body?.profileId,
        isKnownProfile: (id) => !!catalogue.getProfile(id),
      });
      if (!resolved.ok) { messageErr(res, 400, { error: resolved.error }); return; }

      let effectiveProfileId = resolved.profileId;
      if (effectiveProfileId) {
        const profile = catalogue.getProfile(effectiveProfileId);
        if (!profile || !profile.enabled) {
          messageErr(res, 400, { error: `profile unavailable: ${effectiveProfileId}` }); return;
        }
        const parentMode = effectiveInteractionMode(db, parentConversationId);
        if (interactionModeRequiresPermissionCapable(parentMode) && !agentSupportsPermissionMode(profile.agentType)) {
          messageErr(res, 400, {
            error: `Agent ${profile.label} (${profile.agentType}) does not support permission mode '${parentMode}' — use claude-code, codex, or hermes`,
          }); return;
        }
      }

      const preflightProfileId = effectiveProfileId
        ?? lastSessionForConversation(db, childConversationId)?.agentModelId;
      const preflightProfile = preflightProfileId ? catalogue.getProfile(preflightProfileId) : undefined;
      if (body?.handoff !== undefined && preflightProfile && BARE_PROMPT_ADAPTERS.has(preflightProfile.agentType)) {
        messageErr(res, 400, { error: `handoff not supported for ${preflightProfile.agentType}` });
        return;
      }

      // [S2-6] Spawn-approval posture for profile overrides: with spawn
      // approval required, a bearer (agent) caller must not pivot a descendant
      // onto a DIFFERENT profile — bearer spawns are gated through the
      // approval queue, and this path would silently bypass it. Re-affirming
      // the conversation's current profile stays allowed; operator callers
      // are unaffected.
      if (bearer && !manual && effectiveProfileId && approvalRequired(db, parentConversationId)) {
        const childCurrentProfileId = lastSessionForConversation(db, childConversationId)?.agentModelId;
        if (effectiveProfileId !== childCurrentProfileId) {
          messageErr(res, 403, {
            error: 'spawn approval is required to move this conversation onto a different profile — ask the operator',
            decision: 'denied_profile_override',
          });
          return;
        }
      }

      const fireInMs = (body as { fireInMs?: number }).fireInMs;
      const fireAtMsBody = (body as { fireAtMs?: number }).fireAtMs;
      const wantsDefer = fireInMs !== undefined || fireAtMsBody !== undefined;
      if (wantsDefer) {
        if (body?.wait !== undefined) {
          messageErr(res, 400, { error: 'wait is incompatible with deferral' }); return;
        }
        const notify = body?.notifyParent ?? (body?.wait ? false : undefined);

        const when = resolveTimerFireAt({ fireInMs, fireAtMs: fireAtMsBody, now: Date.now() });
        if (!when.ok) { messageErr(res, 400, { error: when.error }); return; }
        const capErr = agentDeferCapError(when.fireAtMs - Date.now(), getCompactionSettings(db).usageAutoResumeMaxDeferMs);
        if (capErr) { messageErr(res, 400, capErr); return; }

        if (outbound.length > TIMER_MAX_PROMPT_CHARS) {
          messageErr(res, 400, { error: `prompt too long (max ${TIMER_MAX_PROMPT_CHARS})` }); return;
        }
        const pending = getPendingNonOperatorTimer(db, childConversationId);
        if (pending) {
          messageErr(res, 409, {
            error: 'a resume timer is already pending for this conversation',
            timerId: pending.id,
            fireAtMs: pending.fireAtMs,
          }); return;
        }
        const last = lastSessionForConversation(db, childConversationId);
        const snapProfileId = effectiveProfileId ?? last?.agentModelId;
        if (!snapProfileId) {
          messageErr(res, 400, { error: 'child has no last profile to defer onto' }); return;
        }
        let timer: ReturnType<typeof createTimer>;
        try {
          timer = createTimer(db, {
            conversationId: childConversationId,
            prompt: outbound,
            profileId: snapProfileId,
            fireAtMs: when.fireAtMs,
            // [S3-4] Stamp by caller kind: a token-bearing child deferral is
        // agent-resume; an operator cookie deferral is operator-origin, so a
        // fresh prompt (S2-2) never cancels the operator's own wake-up.
        origin: bearer ? 'agent-resume' : 'operator',
            attempt: 1,
            notifyParent: notify,
            handoffOverride: body?.handoff ?? null,
          });

        } catch (e) {
          // [S2-7] The unique pending-timer index is the backstop for the
          // check-then-insert race above: a concurrent deferral won the slot.
          if (e instanceof Error && /UNIQUE constraint/.test(e.message)) {
            const winner = getPendingNonOperatorTimer(db, childConversationId);
            messageErr(res, 409, {
              error: 'a resume timer is already pending for this conversation',
              ...(winner ? { timerId: winner.id, fireAtMs: winner.fireAtMs } : {}),
            });
            return;
          }
          throw e;
        }
        const markerExtra = effectiveProfileId ? ` (${effectiveProfileId})` : '';
        deps.sessionManager.recordSpawnMarker(parentConversationId, {
          kind: 'message', childConversationId,
          text: `⇩ message → ${child.title}${markerExtra} (deferred)`,
        });
        res.json({
          ok: true,
          delivered: 'deferred',
          timerId: timer.id,
          fireAtMs: timer.fireAtMs,
          profileId: snapProfileId,
        });
        return;
      }

      const targetProfileId = effectiveProfileId
        ?? lastSessionForConversation(db, childConversationId)?.agentModelId;
      const targetProfile = targetProfileId ? catalogue.getProfile(targetProfileId) : undefined;
      // Busy/usable only for a new grok-bot turn. In-flight on this child is
      // a steer into the session that already owns the composer.
      if (
        targetProfile?.agentType === 'grok-bot'
        && !deps.sessionManager.inFlightSessionForConversation(childConversationId)
      ) {
        const gate = grokBotNewTurnGate(db, deps, child.id, child.projectId, targetProfile.id);
        if (!gate.ok) {
          messageErr(res, gate.status, { error: gate.error });
          return;
        }
      }

      const notify = body?.notifyParent ?? (body?.wait ? false : undefined);

      if (body?.handoff !== undefined && deps.sessionManager.inFlightSessionForConversation(childConversationId)) {
        messageErr(res, 409, { error: 'child turn is in flight — handoff applies to a new turn; retry when idle or omit handoff' });
        return;
      }
      const reportedHandoff = body?.handoff ?? getConversation(db, childConversationId)?.pendingHandoffMode;

      if (body?.wait) {
        if (deps.sessionManager.inFlightSessionForConversation(childConversationId) || pendingMessageWaits.has(childConversationId)) {
          messageErr(res, 409, { error: 'child turn is in flight — send with wait:false (steer) or retry when idle' });
          return;
        }

        pendingMessageWaits.add(childConversationId);

        req.setTimeout(0);
        res.setTimeout(0);
        const keepToken = bearer ? headerToken : undefined;
        const keepAlive = keepToken ? setInterval(() => touchSpawnToken(keepToken), getSpawnTokenTtlMs() / 3) : undefined;
        keepAlive?.unref();

        let stalled = false;
        const watcher = watchChildResult(childConversationId, {
          armOn: 'turn_start',
          onHeartbeat: () => {},
          onStalled: (childId) => {
            stalled = true;
            const stuck = deps.sessionManager.activeSessionForConversation(childId);
            if (stuck) void deps.sessionManager.stopSession(stuck.id);
          },
        });

        try {
          let delivered: 'steered' | 'new_turn' | 'dropped';
          try {
            delivered = deps.sessionManager.messageDescendant(childConversationId, outbound, {
              replyTo: parentConversationId,
              ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
              ...(notify !== undefined ? { notify } : {}),
              ...(body?.handoff ? { handoff: body.handoff } : {}),
              onStartError: (msg) => watcher.fail(msg),
            });
          } catch (e) {
            watcher.cancel();
            watcher.promise.catch(() => {});
            res.status(500).json({ error: 'message dispatch failed' });
            return;
          }

          if (delivered === 'steered') {
            watcher.cancel();
            res.json({ ok: true, delivered: 'steered', waited: false });
            return;
          }

          if (delivered === 'dropped') {
            watcher.cancel();
            res.json({ ok: false, delivered: 'dropped' });
            return;
          }

          const markerExtra = effectiveProfileId ? ` (${effectiveProfileId})` : '';
          deps.sessionManager.recordSpawnMarker(parentConversationId, {
            kind: 'message',
            childConversationId,
            text: `⇩ message → ${child.title}${markerExtra}`,
          });

          try {
            const watchResult = await watcher.promise;
            res.json({
              ok: true,
              delivered: 'new_turn',
              ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
              ...(reportedHandoff ? { handoff: reportedHandoff } : {}),
              result: watchResult.errorMessage || watchResult.prose,
              errored: watchResult.errored,
              degenerate: watchResult.degenerate,
              ...(watchResult.stopped ? { stopped: true } : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (stalled) {
              res.status(504).json({ error: msg });
            } else {
              res.json({
                ok: true,
                delivered: 'new_turn',
                ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
                ...(reportedHandoff ? { handoff: reportedHandoff } : {}),
                result: msg,
                errored: true,
                degenerate: false,
              });
            }
          }
        } catch (dispatchErr) {
          if (!res.headersSent) {
            res.status(500).json({ error: 'message dispatch failed' });
          }
        } finally {
          if (keepAlive) clearInterval(keepAlive);
          if (keepToken) touchSpawnToken(keepToken);
          watcher.cancel();
          pendingMessageWaits.delete(childConversationId);
        }
        return;
      }

      const delivered = deps.sessionManager.messageDescendant(childConversationId, outbound, {
        replyTo: parentConversationId,
        ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
        ...(notify !== undefined ? { notify } : {}),
        ...(body?.handoff ? { handoff: body.handoff } : {}),
      });
      const markerExtra = delivered === 'new_turn' && effectiveProfileId ? ` (${effectiveProfileId})` : '';
      deps.sessionManager.recordSpawnMarker(parentConversationId, {
        kind: 'message', childConversationId,
        text: `⇩ message → ${child.title}${markerExtra}`,
      });
      res.json({
        ok: delivered !== 'dropped',
        delivered,
        ...(delivered === 'new_turn' && effectiveProfileId ? { profileId: effectiveProfileId } : {}),
        ...(delivered === 'new_turn' && reportedHandoff ? { handoff: reportedHandoff } : {}),
      });
      return;
    }

    // Cap BEFORE framing so tail-truncation cannot drop the untrusted wrapper (F4).
    if (Buffer.byteLength(text, 'utf8') > MESH_MAX_BYTES) {
      insertMeshAudit(db, {
        callerKind: ctx.callerKind,
        fromConversation: parentConversationId,
        toConversation: childConversationId,
        edgeId: decision.edgeId,
        decision: 'denied_too_large',
        hop,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
      res.status(413).json({ error: 'text exceeds 32kb cap', decision: 'denied_too_large' }); return;
    }

    // Lateral path: redact → frame once in the route → deliverLateral (all branches).
    const started = Date.now();
    let auditDecision: Parameters<typeof insertMeshAudit>[1]['decision'] = 'dropped_no_session';
    let delivered: 'steered' | 'deferred' | 'new_turn' | 'dropped' = 'dropped';
    let err: string | undefined;
    let outbound = '';
    try {
      outbound = redactAll(text);
      if (bearer) {
        outbound = frameSubagentProse(outbound, {
          role,
          childConversationId: parentConversationId,
          lateral: true,
        });
      }
      const result = await deliverLateral(deps.sessionManager, childConversationId, outbound, {
        replyTo: parentConversationId,
        role,
        edgeId: decision.edgeId,
        hop,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
      auditDecision = result.decision;
      delivered = result.delivered;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      auditDecision = 'delivery_error';
    } finally {
      insertMeshAudit(db, {
        callerKind: ctx.callerKind,
        fromConversation: parentConversationId,
        toConversation: childConversationId,
        edgeId: decision.edgeId,
        decision: auditDecision,
        hop,
        bytes: Buffer.byteLength(text, 'utf8'),
        content: outbound || undefined,
        durationMs: Date.now() - started,
        error: err,
      });
    }
    // Peer-authored titles land in a trusted ⇄ marker; strip control chars /
    // emoji / overlong titles. Descent ⇩ keeps the raw title so T0 markers
    // stay byte-identical to pre-mesh when messaging is off.
    const markerTitle = sanitizeToken(child.title, 'peer');
    deps.sessionManager.recordSpawnMarker(parentConversationId, {
      kind: 'message', childConversationId,
      text: `⇄ message → ${markerTitle}`,
    });
    res.json({ ok: delivered !== 'dropped', delivered, decision: auditDecision });
  });

  /** Manual "push result up": operator forwards a child's latest answer to its
   *  parent as a subagent_notify. For side-quest follow-ups whose recovery
   *  slot is spent (or notifyParent:false) — the operator explicitly bridges
   *  what the automatic machinery would drop. Cookie-only: a manual action,
   *  not an agent capability (bearer tokens are rejected). Never touches
   *  followup_count — this is not a follow-up turn. */
  app.post('/spawn/:childConversationId/push', (req, res) => {
    if (!deps.isAuthed(req)) { res.status(403).json({ error: 'operator session required' }); return; }
    const db = deps.getDb();
    const { childConversationId } = req.params;

    const child = getConversation(db, childConversationId);
    if (!child) { res.status(404).json({ error: 'child conversation not found' }); return; }
    const parentId = child.parentConversationId;
    if (!parentId) { res.status(400).json({ error: 'conversation has no parent to push to' }); return; }
    const parent = getConversation(db, parentId);
    if (!parent) { res.status(400).json({ error: 'parent conversation not found' }); return; }
    // In-flight guard: a mid-turn child's prose is partial — pushing it would
    // relay a truncated answer and burn a parent LLM turn on it. 409 until the
    // child's turn goes terminal.
    if (deps.sessionManager.inFlightSessionForConversation(childConversationId)) {
      res.status(409).json({ error: 'child turn is still in flight — wait for it to finish before pushing' });
      return;
    }

    // Last turn's agent prose: events split at prompt events regardless of
    // sender — operator follow-ups persist as sender 'user', but sourced turns
    // (subagent_notify / parent_message) persist as sender 'system', and a
    // pushed ⇩ message must reset the turn just the same or a push after a
    // message would relay the stale pre-message answer. Falls back to the full
    // transcript join (same extraction as GET /result) when the last turn has
    // no agent output yet.
    const events = listEventsForConversation(db, childConversationId);
    // Persisted agent messages are streamed deltas: they concatenate (web-render
    // parity), prompt events reset the last turn, runs join with real paragraph
    // breaks. A `join('\n\n')` over raw rows shreds text mid-word and breaks
    // markdown (manual-push incident).
    const lastTurnProse = proseFromEvents(events, { lastTurnOnly: true });
    const prose = lastTurnProse
      || proseFromEvents(events);
    if (!prose) { res.status(400).json({ error: 'no agent output in this conversation to push' }); return; }

    const edge = getEdgeByChild(db, childConversationId);
    const role = edge?.role ?? child.title.replace(/^↳\s*/, '');
    const framed = frameSubagentProse(prose, { role, childConversationId, manual: true });

    deps.sessionManager.recordSpawnMarker(parentId, {
      kind: 'result', childConversationId,
      text: `◀ result (manual push): ${prose}`, role,
    });
    deps.sessionManager.notifyParentSubagentResult(parentId, framed, { role, childConversationId });
    sessionHub.broadcastAll({ type: 'spawn_request_updated', conversationId: parentId });
    res.json({ ok: true, childConversationId, parentConversationId: parentId, proseLength: prose.length });
  });
}
