import { dirname, resolve } from 'path';
import type { NodeSandboxPathsAllow, SandboxPath } from '@tierwyn/shared';
import { checkCustomPath, type CustomPathCtx } from '../sandbox/customPaths.js';
import { RpcError } from './rpc.js';

/** Node config dir, key file/dir, and artifact storage — never custom-bound. */
export function nodeHardDenyPaths(input: {
  nodeDir?: string;
  keyPath?: string;
  artifactsRoot?: string;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p?: string) => {
    if (!p) return;
    const abs = resolve(p);
    if (abs === '/' || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  add(input.nodeDir);
  add(input.keyPath);
  if (input.keyPath) add(dirname(input.keyPath));
  add(input.artifactsRoot);
  return out;
}

/** Re-validate hub-requested custom binds against this node's policy and hard-deny. */
export function applyNodeSandboxPaths(
  requested: SandboxPath[] | undefined,
  allow: NodeSandboxPathsAllow,
  ctx: CustomPathCtx,
): SandboxPath[] | undefined {
  if (!requested?.length) return undefined;
  if (allow === 'none') {
    throw new RpcError('sandbox_paths_disabled_on_node', 'sandbox_paths_disabled_on_node');
  }
  const out: SandboxPath[] = [];
  for (const p of requested) {
    if (allow === 'ro' && p.mode === 'rw') {
      throw new RpcError('sandbox_path_denied', p.path);
    }
    const checked = checkCustomPath(p, ctx);
    if (!checked.ok) {
      if (checked.reason === 'outside node.json roots' || p.optional === false) {
        throw new RpcError('sandbox_path_denied', p.path);
      }
      continue;
    }
    out.push({
      path: p.path,
      mode: p.mode,
      ...(p.optional !== undefined ? { optional: p.optional } : {}),
    });
  }
  return out.length ? out : undefined;
}
