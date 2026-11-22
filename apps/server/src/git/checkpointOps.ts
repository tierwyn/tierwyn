import type { Database } from 'better-sqlite3';
import { hostHasFeature } from '@tierwyn/shared';
import { getRemoteHost, remoteHostIdFor } from '../repositories/remoteHosts.js';
import { resolveConversationCwd } from './shadowCheckpoint.js';
import type { CodeDiffMode, CodeRestoreMode, ShadowOps } from './shadowOps.js';
import { RemoteGitOps, type GitNodeHub } from './remoteOps.js';

/**
 * Hub-process-lifetime hub binding for checkpoint RPCs. Set once at boot from
 * index.ts; tests install a stub. `undefined` → checkpointOpsFor always nulls.
 */
let checkpointNodeHub: GitNodeHub | undefined;

export function setCheckpointNodeHub(hub: GitNodeHub | undefined): void {
  checkpointNodeHub = hub;
}

/**
 * `ShadowOps` bound to a conversation's cwd on its remote host, over `git.call`.
 * Method failures surface as `WorkingTreeContextError` (503/501/…) from call().
 */
export class RemoteShadowOps extends RemoteGitOps implements ShadowOps {
  constructor(hub: GitNodeHub, hostId: string, private readonly dir: string) {
    super(hub, hostId);
  }

  isGitRepo() { return this.call<boolean>('isGitRepo', this.dir); }
  snapshotCode(conversationId: string, checkpointId: string) {
    return this.call<string | null>('snapshotCode', this.dir, [conversationId, checkpointId]);
  }
  restoreCode(codeRef: string, mode: CodeRestoreMode) {
    return this.call<void>('restoreCode', this.dir, [codeRef, mode]);
  }
  deleteShadowRef(conversationId: string, checkpointId: string) {
    return this.call<void>('deleteShadowRef', this.dir, [conversationId, checkpointId]);
  }
  resolveShadowRef(conversationId: string, checkpointId: string) {
    return this.call<string | null>('resolveShadowRef', this.dir, [conversationId, checkpointId]);
  }
  codeDiff(codeRef: string, mode?: CodeDiffMode) {
    return this.call<string | null>('codeDiff', this.dir, mode ? [codeRef, mode] : [codeRef]);
  }
  isWorkingTreeClean() { return this.call<boolean>('isWorkingTreeClean', this.dir); }
  currentHead() { return this.call<string | null>('currentHead', this.dir); }
}

/**
 * Resolve the `ShadowOps` binding for a conversation's checkpoint work.
 * Returns null (→ callers keep today's codeRef-less / 409 remote-host behaviour)
 * when the project is local, the host row predates `git.shadow`, the host is
 * disconnected, or the hub binding is unset.
 */
export async function checkpointOpsFor(
  db: Database,
  conversationId: string,
): Promise<{ ops: ShadowOps; cwd: string } | null> {
  const hostId = remoteHostIdFor(db, { conversationId });
  if (!hostId) return null;
  const host = getRemoteHost(db, hostId);
  if (!host || !hostHasFeature(host.hello, 'git.shadow')) return null;
  const cwd = resolveConversationCwd(db, conversationId);
  if (!cwd) return null;
  const hub = checkpointNodeHub;
  if (!hub) return null;
  try {
    hub.link(hostId);
  } catch {
    return null;
  }
  return { ops: new RemoteShadowOps(hub, hostId, cwd), cwd };
}
