import type { Database } from 'better-sqlite3';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import type {
  DirectLlmProfile, OneShotMode, SidecarBackend, SidecarSite, SidecarSiteRoute, LlmCleanupTransport,
  RemoteHostView,
} from '@tierwyn/shared';
import {
  isSidecarAgentBackend, sidecarAgentConfigured, sidecarOneShotMode, SIDECAR_SITE_DEFAULT_PROFILE,
  SIDECAR_SITES_WITH_CWD,
  pickSidecarPrompt, SIDECAR_BUILTIN_PROMPTS, SIDECAR_BUILTIN_CONTEXT_PROMPTS,
  SIDECAR_BUILTIN_TTS_CODE_PROMPTS,
  SIDECAR_BUILTIN_TTS_DIFF_PROMPTS,
  BUILTIN_ENHANCE_PROJECT_PROMPTS,
  profileAvailableOnHost,
} from '@tierwyn/shared';
import { clean } from './adapters/whisper.js';
import { registry, type AdapterFactoryOpts } from './registry.js';
import {
  getSidecarLlmSettings, listDirectLlmProfiles,
} from './repositories/settings.js';

export const sidecarDeps = {
  clean,
  createAdapter: (agentType: string, opts?: AdapterFactoryOpts) => registry.create(agentType, opts),
  hostView: (_id: string): RemoteHostView | undefined => undefined,
};

type SidecarOneShotMode = OneShotMode;
export const READ_ONLY_TIMEOUT_FLOOR_SECS = 120;

export const ENHANCE_PROJECT_REASON_OFF = 'Enhance is switched off in Settings → Sidecar job routing';
export const ENHANCE_PROJECT_REASON_UNSET = 'Configure Settings → Enhance project reads (adapter + model) first';
export const ENHANCE_PROJECT_REASON_NO_RO = 'This adapter cannot do a read-only one-shot';

export interface OneShotCapableAdapter {
  type: string;
  label: string;
  supportsToolsOff: boolean;
  supportsReadOnly: boolean;
}

export function listOneShotCapableAdapters(): OneShotCapableAdapter[] {
  const out: OneShotCapableAdapter[] = [];
  for (const type of registry.registeredTypes()) {
    const adapter = sidecarDeps.createAdapter(type);
    if (typeof adapter.oneShot !== 'function') continue;
    const modes = adapter.oneShotModes ?? ['none'];
    out.push({
      type,
      label: registry.labelFor(type) ?? type,
      supportsToolsOff: modes.includes('none'),
      supportsReadOnly: modes.includes('read_only'),
    });
  }
  return out;
}

/** Adapter/model for a read-only override. Agent rows use their own adapter;
 *  direct rows use the enhance-only projectAdapter/projectModel. Never BTW's. */
export function readOnlyTarget(route: SidecarSiteRoute): { adapter?: string; model?: string } {
  const [a, m] = isSidecarAgentBackend(route.backend)
    ? [route.adapter, route.model]
    : [route.projectAdapter, route.projectModel];
  return { adapter: a?.trim() || undefined, model: m?.trim() || undefined };
}

/** "Enhance with the project" availability. cwd is per-conversation and is
 *  checked at run time, not here. */
export function enhanceProjectStatus(db: Database): { configured: boolean; reason?: string } {
  const route = getSidecarLlmSettings(db).enhance;
  if (route.enabled === false) return { configured: false, reason: ENHANCE_PROJECT_REASON_OFF };
  const { adapter, model } = readOnlyTarget(route);
  if (!adapter || !model) return { configured: false, reason: ENHANCE_PROJECT_REASON_UNSET };
  try {
    const a = sidecarDeps.createAdapter(adapter);
    if (typeof a.oneShot === 'function' && (a.oneShotModes ?? ['none']).includes('read_only')) {
      return { configured: true };
    }
  } catch { /* unregistered / missing binary → not configured */ }
  return { configured: false, reason: ENHANCE_PROJECT_REASON_NO_RO };
}

function resolveDirectProfile(
  db: Database, site: SidecarSite, route: SidecarSiteRoute,
): DirectLlmProfile | undefined {
  const profiles = listDirectLlmProfiles(db);
  const wanted = route.profile?.trim();
  return profiles.find((p) => p.id === wanted)
    ?? profiles.find((p) => p.id === SIDECAR_SITE_DEFAULT_PROFILE[site])
    ?? profiles[0];                       // may be undefined: every profile deleted
}

function directTransportFor(
  db: Database,
  site: SidecarSite,
  route: SidecarSiteRoute,
  systemPrompt: string,
  timeoutSecs?: number,
): LlmCleanupTransport {
  const p = resolveDirectProfile(db, site, route);
  if (!p) throw new Error(`No Direct LLM profile available for site ${site}`);
  const fallbackSecs = site === 'describe' && p.id === 'enhancer' ? 30 : p.timeoutSecs;
  return {
    provider: p.provider, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
    systemPrompt, timeoutSecs: timeoutSecs ?? fallbackSecs,
  };
}

export function sidecarSiteReady(db: Database, site: SidecarSite): boolean {
  const route = getSidecarLlmSettings(db)[site];
  if (route.enabled === false) return false;                 // explicit kill-switch first
  if (isSidecarAgentBackend(route.backend)) {
    if (!sidecarAgentConfigured(route)) return false;
    if (route.backend === 'agent_readonly' && !SIDECAR_SITES_WITH_CWD.includes(site)) {
      return false;
    }
    // Probe the named adapter directly (same capability signal as
    // listOneShotCapableAdapters) so a missing/unregistered binary fails
    // closed without requiring the whole registry to be instantiated.
    try {
      const adapter = sidecarDeps.createAdapter(route.adapter!);
      if (typeof adapter.oneShot !== 'function') return false;
      const modes = adapter.oneShotModes ?? ['none'];
      return route.backend === 'agent_readonly'
        ? modes.includes('read_only')
        : modes.includes('none');
    } catch {
      return false;
    }
  }
  return resolveDirectProfile(db, site, route)?.configured ?? false;   // fail closed
}

async function completeViaClean(
  db: Database,
  site: SidecarSite,
  route: SidecarSiteRoute,
  prompt: string,
  opts: { systemPrompt: string; timeoutSecs?: number },
): Promise<string> {
  return sidecarDeps.clean(
    directTransportFor(db, site, route, opts.systemPrompt, opts.timeoutSecs),
    prompt,
  );
}

export function remoteIneligible(
  view: RemoteHostView | undefined,
  target: { adapter: string; model: string },
  mode: OneShotMode,
): string | null {
  const avail = profileAvailableOnHost({ agentType: target.adapter, model: target.model }, view);
  if (!avail.ok) return avail.reason;
  const info = view!.hello.agents![target.adapter] as { methods: string[]; oneShotModes?: OneShotMode[] };
  if (!info.methods.includes('oneShot')) return 'no_one_shot_on_host';
  if (!(info.oneShotModes ?? ['none']).includes(mode)) return `mode_${mode}_unsupported_on_host`;
  return null;
}

export interface SidecarHostAdvisory {
  site: SidecarSite;
  adapter: string;
  model: string;
  reason: string;
}

function helloHasAgents(view: RemoteHostView): boolean {
  const agents = view.hello.agents;
  return !!agents && Object.keys(agents).length > 0;
}

/** Advisory-only: which cwd-aware sidecar sites would skip this host and
 *  run tools-off on the hub. Evaluates the view as connected so offline
 *  hosts still report agent/model gaps; empty hello → nothing to compare. */
export function sidecarHostAdvisories(db: Database, view: RemoteHostView): SidecarHostAdvisory[] {
  if (!helloHasAgents(view)) return [];
  const connected: RemoteHostView = { ...view, state: 'connected' };
  const settings = getSidecarLlmSettings(db);
  const out: SidecarHostAdvisory[] = [];

  const push = (site: SidecarSite, adapter: string, model: string, reason: string | null) => {
    if (!reason || reason === 'host_disconnected') return;
    if (out.some((a) => a.site === site && a.adapter === adapter && a.model === model && a.reason === reason)) {
      return;
    }
    out.push({ site, adapter, model, reason });
  };

  for (const site of SIDECAR_SITES_WITH_CWD) {
    const route = settings[site];
    if (route.enabled === false) continue;
    if (isSidecarAgentBackend(route.backend) && sidecarAgentConfigured(route)) {
      push(
        site,
        route.adapter!,
        route.model!,
        remoteIneligible(connected, { adapter: route.adapter!, model: route.model! }, sidecarOneShotMode(route.backend)),
      );
    }
    if (site === 'enhance') {
      const { adapter, model } = readOnlyTarget(route);
      if (adapter && model) {
        push(site, adapter, model, remoteIneligible(connected, { adapter, model }, 'read_only'));
      }
    }
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Hub-side cwd: never chdir into a missing path. Relative read_only keeps the
 *  existing "requires an absolute working directory" error (S5). */
export function safeLocalCwd(
  cwd: string | undefined,
  mode: OneShotMode,
  site: SidecarSite,
): string | undefined {
  const t = cwd?.trim();
  if (!t) {
    if (mode === 'read_only') {
      throw new Error(`sidecar ${site}: read-only backend requires an absolute working directory`);
    }
    return undefined;
  }
  if (!isAbsolute(t)) {
    if (mode === 'read_only') {
      throw new Error(`sidecar ${site}: read-only backend requires an absolute working directory`);
    }
    return undefined;
  }
  if (!existsSync(t)) {
    if (mode === 'read_only') {
      throw new Error(`sidecar ${site}: working directory ${t} does not exist on this host`);
    }
    console.warn('[sidecar %s] working directory %s is missing; dropping cwd', site, t);
    return undefined;
  }
  return t;
}

async function runOneShot(
  site: SidecarSite,
  target: { adapter: string; model: string },
  mode: SidecarOneShotMode,
  checkModes: boolean,
  prompt: string,
  opts: { systemPrompt: string; timeoutSecs?: number; cwd?: string; trustRepoConfig?: boolean },
  factoryOpts?: AdapterFactoryOpts,
): Promise<string> {
  const cwd = opts.cwd?.trim();
  if (mode === 'read_only' && (!cwd || !isAbsolute(cwd))) {
    throw new Error(`sidecar ${site}: read-only backend requires an absolute working directory`);
  }
  const emptyMsg = `sidecar ${site}: one-shot returned empty text`;
  try {
    const adapter = factoryOpts
      ? sidecarDeps.createAdapter(target.adapter, factoryOpts)
      : sidecarDeps.createAdapter(target.adapter);
    if (typeof adapter.oneShot !== 'function') {
      throw new Error(`sidecar ${site}: adapter ${target.adapter} does not support one-shot`);
    }
    // ponytail: only checked on a per-call override, so existing callers keep
    // today's path. Adapters re-check inside oneShot(); this gives a uniform error.
    // Remote legs always check: the proxy's oneShotModes is the host's.
    if (checkModes && !(adapter.oneShotModes ?? ['none']).includes(mode)) {
      throw new Error(`sidecar ${site}: adapter ${target.adapter} cannot run a ${mode === 'read_only' ? 'read-only' : 'tools-off'} one-shot`);
    }
    const result = await adapter.oneShot(prompt, {
      systemPrompt: opts.systemPrompt,
      timeoutSecs: opts.timeoutSecs ?? (mode === 'read_only' ? READ_ONLY_TIMEOUT_FLOOR_SECS : 60),
      mode,
      ...(cwd ? { cwd } : {}),
      ...(opts.trustRepoConfig !== undefined ? { trustRepoConfig: opts.trustRepoConfig } : {}),
      model: target.model,
    });
    if (!result.text.trim()) {
      console.warn('[sidecar %s] agent %s %s: %s', site, target.adapter, target.model, 'one-shot returned empty text');
      throw new Error(emptyMsg);
    }
    return result.text.trim();
  } catch (err) {
    if (err instanceof Error && err.message === emptyMsg) throw err;
    const message = errMsg(err);
    console.warn('[sidecar %s] agent %s %s: %s', site, target.adapter, target.model, message);
    throw err;
  }
}

async function completeViaAgent(
  site: SidecarSite,
  target: { adapter: string; model: string },
  mode: SidecarOneShotMode,
  checkModes: boolean,
  prompt: string,
  opts: { systemPrompt: string; timeoutSecs?: number; cwd?: string; remoteHostId?: string | null; trustRepoConfig?: boolean },
): Promise<string> {
  const hostId = opts.remoteHostId?.trim() || undefined;
  if (hostId) {
    let why = remoteIneligible(sidecarDeps.hostView(hostId), target, mode);
    if (!why) {
      try {
        return await runOneShot(site, target, mode, true, prompt, opts, { remoteHostId: hostId });
      } catch (e) {
        why = `remote_failed: ${errMsg(e)}`;
      }
    }
    console.warn('[sidecar %s] remote host %s unavailable (%s); falling back to hub tools-off', site, hostId, why);
    try {
      return await runOneShot(site, target, 'none', false, prompt, { ...opts, cwd: undefined });
    } catch (e) {
      throw new Error(`sidecar ${site}: remote ${why}; hub fallback failed: ${errMsg(e)}`);
    }
  }
  return runOneShot(site, target, mode, checkModes, prompt, {
    ...opts, cwd: safeLocalCwd(opts.cwd, mode, site),
  });
}

export function resolveSidecarPrompt(
  db: Database,
  site: SidecarSite,
  subMode?: 'quick' | 'context' | 'project' | 'code' | 'diff',
  explicitPromptId?: string,
): string {
  // getSidecarLlmSettings already applies the spec §5.2 legacy fallback, so steps
  // 2 and 3 of spec §3.1 are one lookup here.
  const route = getSidecarLlmSettings(db)[site];
  const project = site === 'enhance' && subMode === 'project';
  const context = site === 'enhance' && subMode === 'context';
  const code = site === 'tts' && subMode === 'code';
  const diff = site === 'tts' && subMode === 'diff';
  const builtins = project ? BUILTIN_ENHANCE_PROJECT_PROMPTS
    : context ? SIDECAR_BUILTIN_CONTEXT_PROMPTS
    : code ? SIDECAR_BUILTIN_TTS_CODE_PROMPTS
    : diff ? SIDECAR_BUILTIN_TTS_DIFF_PROMPTS
    : SIDECAR_BUILTIN_PROMPTS[site];
  const customs = project ? route.projectPrompts
    : context ? route.contextPrompts : code ? route.codePrompts : diff ? route.diffPrompts : route.prompts;
  const selected = project ? route.projectSelectedPromptId
    : context ? route.contextSelectedPromptId
    : code ? route.codeSelectedPromptId
    : diff ? route.diffSelectedPromptId
    : route.selectedPromptId;
  return pickSidecarPrompt(builtins, customs, explicitPromptId ?? selected);
}

export async function sidecarComplete(
  db: Database,
  site: SidecarSite,
  prompt: string,
  opts: {
    systemPrompt?: string;
    promptId?: string;
    subMode?: 'quick' | 'context' | 'project' | 'code' | 'diff';
    timeoutSecs?: number;
    cwd?: string;
    oneShotMode?: SidecarOneShotMode;
    remoteHostId?: string | null;
    trustRepoConfig?: boolean;
  } = {},
): Promise<string> {
  const route = getSidecarLlmSettings(db)[site];
  if (route.enabled === false) throw new Error(`sidecar site ${site} is disabled`);
  const systemPrompt = opts.systemPrompt?.trim()
    ? opts.systemPrompt
    : resolveSidecarPrompt(db, site, opts.subMode, opts.promptId);
  const override = opts.oneShotMode;
  // ponytail: override only — undefined keeps the existing call-site → profile →
  // agent-floor chain. Read-only overrides floor at 120s (project enhance).
  const timeoutSecs = override === 'read_only'
    ? Math.max(route.timeoutSecs ?? READ_ONLY_TIMEOUT_FLOOR_SECS, READ_ONLY_TIMEOUT_FLOOR_SECS)
    : route.timeoutSecs ?? opts.timeoutSecs;
  const callOpts = { systemPrompt, timeoutSecs, cwd: opts.cwd, remoteHostId: opts.remoteHostId, trustRepoConfig: opts.trustRepoConfig };
  if (override === 'read_only') {
    const { adapter, model } = readOnlyTarget(route);
    if (!adapter || !model) throw new Error(`sidecar ${site}: read-only one-shot needs an adapter and model`);
    return completeViaAgent(site, { adapter, model }, 'read_only', true, prompt, callOpts);
  }
  if (isSidecarAgentBackend(route.backend)) {
    if (!sidecarAgentConfigured(route)) {
      throw new Error(`sidecar ${site}: adapter and model required when backend=agent`);
    }
    const mode = override ?? sidecarOneShotMode(route.backend as SidecarBackend);
    return completeViaAgent(
      site, { adapter: route.adapter!, model: route.model! }, mode, override !== undefined, prompt, callOpts,
    );
  }
  return completeViaClean(db, site, route, prompt, callOpts);
}
