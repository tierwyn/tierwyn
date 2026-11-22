import type { AgentSearchScopeSetting, MoveProjectErrorCode, SandboxPath, SandboxSetting, UpdateProjectRequest } from '@tierwyn/shared';

/** Matches PATCH /projects/:id. */
export const MAX_PROJECT_NAME_LENGTH = 200;

function pathsKey(paths: SandboxPath[] | null | undefined): string {
  return JSON.stringify((paths ?? []).map((p) => ({ path: p.path, mode: p.mode, optional: p.optional ?? true })));
}

export function buildProjectEditPatch(
  current: { name: string; rootPath: string; trustRepoConfig?: boolean; sandbox?: SandboxSetting | null; sandboxPaths?: SandboxPath[] | null; agentSearchScope?: AgentSearchScopeSetting | null },
  draft: { name: string; rootPath: string; trustRepoConfig?: boolean; sandbox?: SandboxSetting | null; sandboxPaths?: SandboxPath[] | null; agentSearchScope?: AgentSearchScopeSetting | null },
): { ok: true; patch: UpdateProjectRequest | null } | { ok: false; error: string } {
  const name = draft.name.trim();
  const rootPath = draft.rootPath.trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return { ok: false, error: `name too long (max ${MAX_PROJECT_NAME_LENGTH})` };
  }
  if (!rootPath) return { ok: false, error: 'rootPath required' };
  if (!rootPath.startsWith('/')) {
    return { ok: false, error: 'rootPath must be an absolute path (leading /)' };
  }
  const patch: UpdateProjectRequest = {};
  if (name !== current.name) patch.name = name;
  if (rootPath !== current.rootPath) patch.rootPath = rootPath;
  if (draft.trustRepoConfig !== undefined && draft.trustRepoConfig !== current.trustRepoConfig) {
    patch.trustRepoConfig = draft.trustRepoConfig;
  }
  if (draft.sandbox !== undefined && (draft.sandbox ?? null) !== (current.sandbox ?? null)) {
    patch.sandbox = draft.sandbox;
  }
  if (draft.sandboxPaths !== undefined && pathsKey(draft.sandboxPaths) !== pathsKey(current.sandboxPaths)) {
    const next = draft.sandboxPaths ?? [];
    patch.sandboxPaths = next.length ? next : null;
  }
  if (draft.agentSearchScope !== undefined && (draft.agentSearchScope ?? null) !== (current.agentSearchScope ?? null)) {
    patch.agentSearchScope = draft.agentSearchScope;
  }
  if (
    patch.name === undefined
    && patch.rootPath === undefined
    && patch.trustRepoConfig === undefined
    && patch.sandbox === undefined
    && patch.sandboxPaths === undefined
    && patch.agentSearchScope === undefined
  ) return { ok: true, patch: null };
  return { ok: true, patch };
}

export function splitProjectEdit(
  current: { name: string; rootPath: string; trustRepoConfig?: boolean; sandbox?: SandboxSetting | null; sandboxPaths?: SandboxPath[] | null; agentSearchScope?: AgentSearchScopeSetting | null },
  draft: { name: string; rootPath: string; trustRepoConfig?: boolean; sandbox?: SandboxSetting | null; sandboxPaths?: SandboxPath[] | null; agentSearchScope?: AgentSearchScopeSetting | null },
): { ok: false; error: string } | { ok: true; patch: UpdateProjectRequest | null; newRootPath: string | null } {
  const res = buildProjectEditPatch(current, draft);
  if (!res.ok) return res;
  if (!res.patch) return { ok: true, patch: null, newRootPath: null };
  const { rootPath, ...rest } = res.patch;
  const newRootPath = rootPath ?? null;
  const patch = Object.keys(rest).length > 0 ? rest : null;
  return { ok: true, patch, newRootPath };
}

export function moveErrorMessage(code: MoveProjectErrorCode | undefined, fallback: string): string {
  switch (code) {
    case 'agents_active':
      return 'Agents are working in this project. Stop them, then try again.';
    case 'move_in_progress':
      return "This project's folder is already being moved.";
    case 'exists':
      return 'Something already exists at the new path.';
    case 'parent_missing':
      return 'The parent folder could not be created. Check permissions, or create it first (folder browser → New folder).';
    case 'cross_device':
      return 'The new path is on a different disk. Move the folder by hand, then set the path to point at it.';
    case 'path_outside_roots':
      return 'Both paths must be inside the allowed project roots.';
    case 'into_self':
      return 'A folder cannot be moved inside itself.';
    case 'contains_other_project':
      return 'Another project lives inside this folder. Move that project first.';
    case 'node_update_required':
      return 'Update tierwyn node on the host to move folders (tierwyn node update).';
    case 'host_disconnected':
      return 'The remote host is not connected.';
    case 'rollback_failed':
    case 'move_state_unknown':
      return fallback;
    default:
      return fallback;
  }
}
