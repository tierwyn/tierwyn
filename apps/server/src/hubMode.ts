import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dedicated hub install (`tierwyn setup` → hub mode writes TIERWYN_DEDICATED_HUB=1
 *  into ~/.config/tierwyn/hub.env). A dev checkout never sets it, so agents there
 *  keep a writable repo and sandbox stays off by default. */
export function isDedicatedHub(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TIERWYN_DEDICATED_HUB === '1';
}

/** Repo root of this running server (src/ and dist/ both sit at apps/server/<x>/). */
export const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** True when a project at `rootPath` would hand agents the hub checkout as cwd —
 *  inside it or an ancestor of it. cwd is RW even under bwrap. */
export function overlapsHubRoot(rootPath: string, hubRoot: string = HUB_ROOT): boolean {
  const p = real(rootPath);
  const h = real(hubRoot);
  return within(p, h) || within(h, p);
}

/** Error text for a project root a dedicated hub must refuse, or null. */
export function hubRootGuard(rootPath: string, env: NodeJS.ProcessEnv = process.env, hubRoot: string = HUB_ROOT): string | null {
  if (!isDedicatedHub(env) || !overlapsHubRoot(rootPath, hubRoot)) return null;
  return `rootPath overlaps the hub install (${hubRoot}) — agents would be able to edit the hub. Pick a folder outside it.`;
}
