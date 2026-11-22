/**
 * Sync manifest scan (scrub list ready before any spawn — F18) + async activate.
 * `TIERWYN_PLUGINS=off` disables loading entirely.
 * Dir = `TIERWYN_PLUGINS_DIR ?? './plugins'`
 * — per-instance, gitignored, empty on a fresh clone; first-party source is `plugin-src/`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { isCredentialKeyAllowed, type PluginManifest } from '@tierwyn/shared';
import { envPref, envPrefOr } from '../config/env.js';
import type { PluginHost } from './host.js';

const ID_RE = /^[a-z][a-z0-9-]{1,48}$/;
const CAP_RE = /^[a-z][a-z0-9.]*$/;
const MAX_CAPABILITY_TIMEOUT_MS = 300_000;

/** Per-plugin HELP.md cap; anything larger is treated as absent (warn at boot). */
export const MAX_HELP_BYTES = 64 * 1024;

export interface ScannedPlugin {
  dir: string;
  manifest: PluginManifest;
  /** Contents of `plugins/<id>/HELP.md` when present, regular, and ≤ MAX_HELP_BYTES. */
  help?: string;
}

/**
 * Read `HELP.md` synchronously once at boot. Optional by design: a missing,
 * oversized, symlinked, or non-regular HELP.md means "no help" — never a boot
 * failure. Size is checked via lstat before reading so a giant file is never
 * pulled into memory.
 */
function readHelp(pluginDir: string): string | undefined {
  const helpPath = join(pluginDir, 'HELP.md');
  try {
    const st = lstatSync(helpPath);
    if (!st.isFile()) return undefined; // covers symlinks, dirs, fifos…
    if (st.size > MAX_HELP_BYTES) {
      console.warn(`[plugins] HELP.md in ${pluginDir} exceeds ${MAX_HELP_BYTES} bytes — ignoring`);
      return undefined;
    }
    return readFileSync(helpPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[plugins] cannot read ${helpPath}: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }
}

export function pluginsDir(): string {
  return envPrefOr('PLUGINS_DIR', './plugins');
}

export function validateManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'manifest is not an object' };
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    return { ok: false, reason: `invalid id ${JSON.stringify(m.id)}` };
  }
  if (m.apiVersion !== 1) {
    return { ok: false, reason: `unsupported apiVersion ${JSON.stringify(m.apiVersion)}` };
  }
  if (typeof m.name !== 'string' || !m.name) {
    return { ok: false, reason: 'missing name' };
  }
  if (typeof m.version !== 'string' || !m.version) {
    return { ok: false, reason: 'missing version' };
  }
  if (!Array.isArray(m.capabilities)) {
    return { ok: false, reason: 'capabilities must be an array' };
  }
  for (const cap of m.capabilities) {
    if (!cap || typeof cap !== 'object') return { ok: false, reason: 'capability is not an object' };
    const c = cap as Record<string, unknown>;
    if (typeof c.name !== 'string' || !CAP_RE.test(c.name)) {
      return { ok: false, reason: `invalid capability name ${JSON.stringify(c.name)}` };
    }
    if (typeof c.summary !== 'string') {
      return { ok: false, reason: `capability ${c.name} missing summary` };
    }
    if (typeof c.agentCallable !== 'boolean') {
      return { ok: false, reason: `capability ${c.name} missing agentCallable` };
    }
    if (c.timeoutMs !== undefined
        && (!Number.isInteger(c.timeoutMs) || (c.timeoutMs as number) < 1 || (c.timeoutMs as number) > MAX_CAPABILITY_TIMEOUT_MS)) {
      return { ok: false, reason: `capability ${c.name} timeoutMs must be an integer 1..${MAX_CAPABILITY_TIMEOUT_MS}` };
    }
    if (c.usageProvider !== undefined) {
      if (!c.usageProvider || typeof c.usageProvider !== 'object' || Array.isArray(c.usageProvider)) {
        return { ok: false, reason: `capability ${c.name} usageProvider must be an object` };
      }
      const up = c.usageProvider as Record<string, unknown>;
      if (typeof up.label !== 'string' || !up.label.trim()) {
        return { ok: false, reason: `capability ${c.name} usageProvider.label required` };
      }
      if (up.section !== undefined && (typeof up.section !== 'string' || !up.section.trim())) {
        return { ok: false, reason: `capability ${c.name} usageProvider.section must be a non-empty string` };
      }
      if (up.matchAgent !== undefined && typeof up.matchAgent !== 'string') {
        return { ok: false, reason: `capability ${c.name} usageProvider.matchAgent must be a string` };
      }
      if (up.matchModel !== undefined && typeof up.matchModel !== 'string') {
        return { ok: false, reason: `capability ${c.name} usageProvider.matchModel must be a string` };
      }
    }
  }
  if (m.credentials !== undefined) {
    if (!Array.isArray(m.credentials)) return { ok: false, reason: 'credentials must be an array' };
    for (const cred of m.credentials) {
      if (!cred || typeof cred !== 'object') return { ok: false, reason: 'credential is not an object' };
      const key = (cred as Record<string, unknown>).key;
      if (typeof key !== 'string' || !isCredentialKeyAllowed(key)) {
        return { ok: false, reason: `credential key not allowed: ${JSON.stringify(key)}` };
      }
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) return { ok: false, reason: 'permissions must be an array' };
    for (const perm of m.permissions) {
      if (typeof perm !== 'string') {
        return { ok: false, reason: 'permissions must be an array of strings' };
      }
    }
  }
  return { ok: true, manifest: m as unknown as PluginManifest };
}

export function isPluginId(s: string): boolean {
  return typeof s === 'string' && ID_RE.test(s);
}

/**
 * Read and validate a single plugin directory.
 * missing: true when plugin.json (+fallbacks) or index.js is absent.
 */
export function readPluginDir(pluginDir: string):
  | { ok: true; plugin: ScannedPlugin }
  | { ok: false; reason: string; missing?: true } {
  let manifestPath = join(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    const example = join(pluginDir, 'plugin.json.example');
    const sample = join(pluginDir, 'plugin.sample.json');
    if (existsSync(example)) manifestPath = example;
    else if (existsSync(sample)) manifestPath = sample;
  }
  const entryPath = join(pluginDir, 'index.js');
  if (!existsSync(manifestPath) || !existsSync(entryPath)) {
    return { ok: false, reason: 'missing plugin.json or index.js', missing: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `invalid JSON (${err instanceof Error ? err.message : err})` };
  }
  const parsed = validateManifest(raw);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  return {
    ok: true,
    plugin: { dir: pluginDir, manifest: parsed.manifest, help: readHelp(pluginDir) },
  };
}

export function credentialKeysFrom(found: ScannedPlugin[]): string[] {
  const keys: string[] = [];
  for (const p of found) {
    for (const c of p.manifest.credentials ?? []) keys.push(c.key);
  }
  return [...new Set(keys)];
}

/** Synchronous: readdir + readFile + JSON.parse + validate. Ready before any spawn. */
export function scanManifests(dir = pluginsDir()): ScannedPlugin[] {
  if (envPref('PLUGINS') === 'off') return [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const found: ScannedPlugin[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`[plugins] cannot read ${dir}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const pluginDir = join(dir, name);
    let st;
    try { st = statSync(pluginDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const res = readPluginDir(pluginDir);
    if (!res.ok) {
      if (!res.missing) {
        console.warn(`[plugins] skip ${name}: ${res.reason}`);
      }
      continue;
    }
    found.push(res.plugin);
  }
  found.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return found;
}

export async function activatePlugin(
  host: PluginHost,
  p: ScannedPlugin,
  ctx: ReturnType<PluginHost['addManifest']>,
  opts: { bust?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Known ceiling: only index.js query param is busted; sibling modules imported
    // by it resolve without query and stay cached from previous incarnation.
    const url = pathToFileURL(resolve(p.dir, 'index.js')).href + (opts.bust ? `?v=${Date.now()}` : '');
    const mod = await import(url) as {
      default?: { activate?: (c: typeof ctx) => unknown; deactivate?: () => void };
    };
    const plugin = mod.default;
    if (!plugin || typeof plugin.activate !== 'function') {
      throw new Error('default export missing activate()');
    }
    await plugin.activate(ctx);
    if (typeof plugin.deactivate === 'function') ctx.onDeactivate(plugin.deactivate);
    host.markActivated(p.manifest.id);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[plugins] failed to activate ${p.manifest.id}: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function activatePlugins(
  host: PluginHost,
  found: ScannedPlugin[],
  disabled: string[],
): Promise<void> {
  const disabledSet = new Set(disabled);
  for (const p of found) {
    const enabled = !disabledSet.has(p.manifest.id);
    const ctx = host.addManifest(p.manifest, { enabled, dir: p.dir, help: p.help });
    if (!enabled) continue;
    const r = await activatePlugin(host, p, ctx);
    if (!r.ok) {
      host.markDisabled(p.manifest.id);
    }
  }
}
