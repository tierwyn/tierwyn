import type { Database } from 'better-sqlite3';
import type { Checkpoint } from '@tierwyn/shared';
import { getSession } from './repositories/sessions.js';
import { createCheckpoint, getCheckpoint, deleteCheckpoint, getCheckpointByEvent, setCheckpointCodeRef } from './repositories/checkpoints.js';
import { nativeTurnIndex } from './repositories/rewind.js';
import { resolveConversationCwd } from './git/shadowCheckpoint.js';
import { localShadowOpsFor, type ShadowOps } from './git/shadowOps.js';
import { checkpointOpsFor } from './git/checkpointOps.js';
import { latestEventForConversation } from './repositories/events.js';
import { remoteHostIdFor } from './repositories/remoteHosts.js';

/**
 * Resolve the ShadowOps binding for a conversation's code snapshots: remote
 * over `git.call` when the host supports `git.shadow`, local wrappers when the
 * project is local, null when snapshots are unavailable (old/disconnected node).
 */
async function codeSnapshotTarget(
  db: Database,
  conversationId: string,
): Promise<{ ops: ShadowOps } | null> {
  const remote = await checkpointOpsFor(db, conversationId);
  if (remote) return remote;
  // Remote project whose host can't take snapshots (no feature / disconnected).
  if (remoteHostIdFor(db, { conversationId })) return null;
  const cwd = resolveConversationCwd(db, conversationId);
  if (!cwd) return null;
  return { ops: localShadowOpsFor(cwd) };
}

/** Fire-and-forget auto checkpoint at a completed user-turn boundary. */
export async function recordAutoCheckpoint(
  db: Database,
  input: { conversationId: string; sessionId: string; eventId: string },
): Promise<void> {
  const existing = getCheckpointByEvent(db, input.eventId);
  if (existing) return;

  const session = getSession(db, input.sessionId);
  const checkpoint = createCheckpoint(db, {
    conversationId: input.conversationId,
    eventId: input.eventId,
    sessionId: input.sessionId,
    nativeSessionId: session?.nativeSessionId,
    nativeTurnIndex: nativeTurnIndex(db, input.eventId) || undefined,
    kind: 'auto',
    pinned: false,
  });

  try {
    const target = await codeSnapshotTarget(db, input.conversationId);
    if (!target) return;
    const codeRef = await target.ops.snapshotCode(input.conversationId, checkpoint.id);
    if (codeRef) setCheckpointCodeRef(db, checkpoint.id, codeRef);
  } catch { /* code snapshot must never fail the turn */ }
}

/** Snapshot code for a checkpoint row that already exists (manual create path). */
export async function snapshotCodeForCheckpoint(
  db: Database,
  conversationId: string,
  checkpointId: string,
): Promise<void> {
  try {
    const target = await codeSnapshotTarget(db, conversationId);
    if (!target) return;
    const codeRef = await target.ops.snapshotCode(conversationId, checkpointId);
    if (codeRef) setCheckpointCodeRef(db, checkpointId, codeRef);
  } catch { /* fail-soft */ }
}

/**
 * Snapshot the CURRENT dirty worktree as a pinned undo point before a destructive restore.
 * Anchored at the conversation's latest surviving event so it isn't pruned (code-only path).
 *
 * ponytail: undo point only for the one lossy path (code-only worktree reset on a dirty tree).
 * Both-mode truncates the transcript which would prune a head-anchored checkpoint; shared-mode
 * keeps commits. Upgrade path: if users want Both-mode undo, anchor at the rewind target instead.
 */
export async function recordPreRestoreCheckpoint(
  db: Database,
  conversationId: string,
): Promise<Checkpoint | null> {
  const latest = latestEventForConversation(db, conversationId);
  if (!latest) return null;

  // Mirror recordAutoCheckpoint's guard: the latest event usually already has an
  // auto-checkpoint (fired at every completed turn), and checkpoints.event_id is
  // UNIQUE. Without this guard the createCheckpoint INSERT throws and the whole
  // rewind 500s — which on a dirty shared root is the primary restore path.
  if (getCheckpointByEvent(db, latest.id)) return null;

  const checkpoint = createCheckpoint(db, {
    conversationId,
    eventId: latest.id,
    sessionId: latest.sessionId,
    kind: 'auto',
    pinned: true,
    label: 'Before restore',
  });

  try {
    const target = await codeSnapshotTarget(db, conversationId);
    if (!target) {
      // Remote host without snapshot support: keep the row codeRef-less.
      return getCheckpoint(db, checkpoint.id) ?? checkpoint;
    }
    const codeRef = await target.ops.snapshotCode(conversationId, checkpoint.id);
    if (!codeRef) {
      // Tree was clean — nothing distinct to save; remove the empty row
      deleteCheckpoint(db, checkpoint.id);
      return null;
    }
    setCheckpointCodeRef(db, checkpoint.id, codeRef);
    return getCheckpoint(db, checkpoint.id) ?? null;
  } catch {
    deleteCheckpoint(db, checkpoint.id);
    return null;
  }
}
