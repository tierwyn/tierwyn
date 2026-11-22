import { execFile } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isCloneUrlAllowed, type FsCloneParams, type FsCloneResult, type FsMkdirParams, type FsMkdirResult } from '@tierwyn/shared';
import { pathUnderRoots } from './policy.js';
import { RpcError } from './rpc.js';
import { gitArgv } from '../git/gitExec.js';

/** Fixed, shell-free argv — the url/target are always behind `--`. */
export function buildCloneArgv(url: string, target: string): string[] {
  return [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    'clone', '--no-recurse-submodules', '--', url, target,
  ];
}

/** Validates an absolute, normalised leaf target whose existing parent realpaths inside roots. */
export function resolveLeafTarget(roots: string[], root: unknown): { realParent: string; target: string } {
  if (
    typeof root !== 'string' || !root
    || !isAbsolute(root) || root.includes('\0')
    || resolve(root) !== root
    || basename(root) === '' || basename(root) === '.' || basename(root) === '..' || basename(root) === '.git'
  ) {
    throw new RpcError('bad_path', 'invalid path');
  }
  const segments = root.split(/[/\\]+/);
  if (segments.includes('.git')) {
    throw new RpcError('bad_path', 'path cannot contain .git segment');
  }
  const realParent = pathUnderRoots(dirname(root), roots);
  if (!realParent) throw new RpcError('path_outside_roots', 'parent outside roots');
  const target = join(realParent, basename(root));
  return { realParent, target };
}

export function fsMkdir(roots: string[], p: FsMkdirParams): FsMkdirResult {
  const { target } = resolveLeafTarget(roots, p?.path);
  try {
    mkdirSync(target);
    return { path: realpathSync(target), created: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      if (statSync(target).isDirectory()) return { path: realpathSync(target), created: false };
      throw new RpcError('exists', 'target exists and is not a directory');
    }
    throw new RpcError('mkdir_failed', (err as NodeJS.ErrnoException).code ?? 'mkdir failed');
  }
}

/** In-flight clone targets — a second concurrent clone of the same path → busy. */
const active = new Set<string>();

function redact(s: string): string {
  return s.replace(/:\/\/[^@/\s]+@/g, '://***@');
}

export async function fsClone(
  roots: string[],
  p: FsCloneParams,
  opts?: { timeoutMs?: number; git?: string; env?: NodeJS.ProcessEnv },
): Promise<FsCloneResult> {
  if (!isCloneUrlAllowed(p.url)) throw new RpcError('bad_url', 'clone url not allowed');
  const { realParent, target } = resolveLeafTarget(roots, p.root);
  if (active.has(target)) throw new RpcError('busy', 'clone already in progress for this target');
  try {
    mkdirSync(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RpcError('exists', 'target already exists');
    }
    throw err;
  }
  active.add(target);
  let cloned = false;
  try {
    const cloneEnv = { ...(opts?.env ?? process.env) };
    delete cloneEnv.GIT_ALLOW_PROTOCOL;
    for (const k of Object.keys(cloneEnv)) {
      if (k.startsWith('GIT_CONFIG_')) delete cloneEnv[k];
    }
    cloneEnv.GIT_TERMINAL_PROMPT = '0';
    cloneEnv.GIT_SSH_COMMAND = opts?.env?.GIT_SSH_COMMAND ?? process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes';

    await new Promise<void>((res, rej) => {
      execFile(opts?.git ?? 'git', [...gitArgv([], 'background'), ...buildCloneArgv(p.url, target)], {
        cwd: realParent,
        timeout: opts?.timeoutMs ?? 5 * 60_000,
        killSignal: 'SIGTERM',
        maxBuffer: 1 << 20,
        // Host credentials only — BatchMode fails fast on unknown host keys or
        // passphrase-locked keys instead of hanging the RPC.
        env: cloneEnv,
      }, (err, _stdout, stderr) => {
        if (!err) return res();
        const tail = String(stderr || err.message).slice(-2048);
        rej(new RpcError('clone_failed', redact(tail) || 'git clone failed'));
      });
    });
    cloned = true;
    return { path: realpathSync(target) };
  } finally {
    // git leaves a partial checkout behind on failure — remove it (the target
    // was absent at validation time, so anything present now is git's debris).
    if (!cloned && existsSync(target)) rmSync(target, { recursive: true, force: true });
    active.delete(target);
  }
}

function lstatSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
