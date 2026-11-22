import type { Database } from 'better-sqlite3';
import type { Project, SchedulePackFile, SchedulePackFilesResult } from '@tierwyn/shared';
import { hostHasFeature } from '@tierwyn/shared';
import { getRemoteHost } from '../repositories/remoteHosts.js';
import { RpcError } from '../node/rpc.js';
import {
  materialisePackFiles,
  unlinkPackFiles,
  substitutePackTokens,
  PackFileConflict,
  PackFilePathError,
} from './packFiles.js';

/** Hub-side host/feature failure when materialising pack files on a remote. */
export class PackHostError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PackHostError';
    this.status = status;
    this.code = code;
  }
}

export type PackFilesNodeHub = {
  link(id: string): { request<T>(m: string, p: unknown): Promise<T> };
};

/**
 * Local or remote pack-file materialisation. Remote projects write via the
 * feature-gated `schedule.packFiles` RPC (D4). Tokens are substituted hub-side
 * before the RPC so the node never sees variable maps.
 *
 * Lives in this hub-only module so `packFiles.ts` stays free of `repositories/`
 * imports (node entry-graph isolation).
 */
export async function materialisePackFilesFor(
  db: Database,
  nodeHub: PackFilesNodeHub | undefined,
  project: Project,
  jobSlug: string,
  files: SchedulePackFile[],
  vars: Record<string, string>,
  opts: { overwrite?: boolean } = {},
): Promise<{ written: string[]; rollback: () => Promise<void> }> {
  const kinds = files.map((f) => f.kind);

  if (!project.remoteHostId) {
    const { written } = materialisePackFiles(project.rootPath, jobSlug, files, vars, opts);
    return {
      written,
      rollback: async () => { unlinkPackFiles(project.rootPath, jobSlug, kinds); },
    };
  }

  if (!nodeHub) {
    throw new PackHostError(409, 'host_disconnected', 'remote host not connected');
  }

  const host = getRemoteHost(db, project.remoteHostId);
  if (!hostHasFeature(host?.hello, 'schedule.packFiles')) {
    throw new PackHostError(501, 'node_update_required', 'remote host needs update');
  }

  let link: { request<T>(m: string, p: unknown): Promise<T> };
  try {
    link = nodeHub.link(project.remoteHostId);
  } catch (e) {
    if (e instanceof RpcError && (e.code === 'host_disconnected' || e.code === 'disconnected')) {
      throw new PackHostError(409, 'host_disconnected', 'remote host not connected');
    }
    throw new PackHostError(409, 'host_disconnected', 'remote host not connected');
  }

  const substituted = files.map((f) => ({
    kind: f.kind,
    body: substitutePackTokens(f.body, vars),
  }));

  let result: SchedulePackFilesResult;
  try {
    result = await link.request<SchedulePackFilesResult>('schedule.packFiles', {
      op: 'write',
      root: project.rootPath,
      jobSlug,
      files: substituted,
      overwrite: opts.overwrite,
    });
  } catch (e) {
    if (e instanceof RpcError) {
      if (e.code === 'host_disconnected' || e.code === 'disconnected') {
        throw new PackHostError(409, 'host_disconnected', 'remote host not connected');
      }
      if (e.code === 'bad_path') {
        throw new PackFilePathError(e.message);
      }
      if (e.code === 'no_method') {
        throw new PackHostError(501, 'node_update_required', 'remote host needs update');
      }
    }
    throw e;
  }

  if (!result.ok) {
    throw new PackFileConflict(result.conflicts);
  }

  const written = result.written;
  return {
    written,
    rollback: async () => {
      try {
        await link.request('schedule.packFiles', {
          op: 'unlink',
          root: project.rootPath,
          jobSlug,
          files: kinds.map((kind) => ({ kind, body: '' })),
        });
      } catch (e) {
        console.error('[schedule-packs] remote unlink rollback failed', e);
      }
    },
  };
}
