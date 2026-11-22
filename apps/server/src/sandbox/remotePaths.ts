import {
  hostHasFeature,
  type NodeHello,
  type SandboxPath,
  type SandboxSource,
} from '@tierwyn/shared';

export const REMOTE_PATHS_UPDATE_NOTICE =
  'Sandbox: remote custom paths require a node update. This turn ran sandboxed without the extra paths.';

export const REMOTE_PATHS_DISABLED_NOTICE =
  'Sandbox: this host disallows extra sandbox paths (node.json sandboxPaths.allow=none). This turn ran sandboxed without the extra paths.';

export const REMOTE_PATHS_RO_NOTICE =
  'Sandbox: this host only allows read-only extra sandbox paths (node.json sandboxPaths.allow=ro). Read-write paths were omitted for this turn.';

const EXPLICIT: ReadonlySet<SandboxSource> = new Set(['conversation', 'project']);

export function gateRemoteSandboxPaths(input: {
  paths: SandboxPath[];
  source: SandboxSource;
  on: boolean;
  hello?: Pick<NodeHello, 'features' | 'sandboxPaths'> | null;
}): { sandboxPaths?: SandboxPath[]; notice?: string } {
  if (!input.on || input.paths.length === 0) return {};
  const explicit = EXPLICIT.has(input.source);
  const has = hostHasFeature(input.hello ?? undefined, 'sandbox_paths');
  if (!has) {
    if (explicit) return { sandboxPaths: input.paths };
    return { notice: REMOTE_PATHS_UPDATE_NOTICE };
  }
  if (input.hello?.sandboxPaths?.allow === 'none') {
    if (explicit) return { sandboxPaths: input.paths };
    return { notice: REMOTE_PATHS_DISABLED_NOTICE };
  }
  if (input.hello?.sandboxPaths?.allow === 'ro' && input.paths.some((p) => p.mode === 'rw')) {
    if (explicit) return { sandboxPaths: input.paths };
    const kept = input.paths.filter((p) => p.mode !== 'rw');
    return {
      ...(kept.length ? { sandboxPaths: kept } : {}),
      notice: REMOTE_PATHS_RO_NOTICE,
    };
  }
  return { sandboxPaths: input.paths };
}
