/**
 * Capability profiles — a conversation-scoped grant over plugin capabilities
 * and the usage-telemetry surface. Pure module: no I/O, shared by server and
 * web. See docs/architecture/plugins.md ("Capability profiles").
 */

export interface CapabilityProfile {
  /** Slug, /^[a-z0-9][a-z0-9-]{0,39}$/. Builtin ids are reserved. */
  id: string;
  /** Human label, ≤ 60 chars. */
  label: string;
  /** '*' = every enabled agent-callable plugin (resolved at call time), or an
   *  explicit allow-list of plugin ids. */
  plugins: '*' | string[];
  /** Grants GET /agent/usage, GET /agent/usage/:target, and every
   *  usageProvider capability without listing plugin ids. */
  usage: boolean;
  /** Grants /agent/memory. Absent on stored profiles means allowed. */
  memory?: boolean;
  /** Shipped profile — read-only, undeletable. */
  builtin?: true;
}

/** What gets baked into a spawn token at mint time (label/builtin dropped). */
export type ResolvedCapabilityProfile = Pick<CapabilityProfile, 'id' | 'plugins' | 'usage' | 'memory'>;

export const CAPABILITY_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CAPABILITY_PROFILE_LABEL_MAX = 60;

export const DEFAULT_CAPABILITY_PROFILE_ID = 'all';
export const FALLBACK_CAPABILITY_PROFILE_ID = 'minimal';

function freezeProfile(p: CapabilityProfile): CapabilityProfile {
  return Object.freeze({
    ...p,
    plugins: p.plugins === '*' ? '*' : Object.freeze([...p.plugins]),
  }) as CapabilityProfile;
}

/** Frozen so a process-wide `p.plugins.push(...)` cannot widen a builtin. */
export const BUILTIN_CAPABILITY_PROFILES: readonly CapabilityProfile[] = Object.freeze([
  freezeProfile({ id: 'all', label: 'All', plugins: '*', usage: true, builtin: true }),
]);

const BUILTIN_IDS = new Set(BUILTIN_CAPABILITY_PROFILES.map((p) => p.id));

/**
 * Single grant rule used by every enforcement point: a capability is allowed
 * when the profile is '*', lists the plugin id, or carries `usage` and the
 * capability is a usage provider.
 */
export function profileAllowsCapability(
  p: ResolvedCapabilityProfile,
  pluginId: string,
  cap?: { usageProvider?: boolean },
): boolean {
  return p.plugins === '*' || p.plugins.includes(pluginId) || (p.usage && !!cap?.usageProvider);
}

/**
 * Usage telemetry (`GET /agent/usage[/:target]`) uses the same grant rule:
 * the `usage` flag, or `plugins: '*'` which already admits every capability
 * including usage providers.
 */
export function profileAllowsUsage(p: ResolvedCapabilityProfile): boolean {
  return profileAllowsCapability(p, '', { usageProvider: true });
}

/** Absent `memory` on an already-stored profile means allowed. */
export function profileAllowsMemory(p: ResolvedCapabilityProfile): boolean {
  return p.memory !== false;
}

/** NULL / '' / default profile id are the same default grant (null). */
export function canonicalCapabilityProfileId(
  id: string | null | undefined,
  defaultProfileId: string = DEFAULT_CAPABILITY_PROFILE_ID,
): string | null {
  const v = typeof id === 'string' ? id.trim() : '';
  if (!v || v === defaultProfileId) return null;
  return v;
}

/** Stable fingerprint of the grant surface (label changes must not re-mint). */
export function capabilityProfileFp(p: ResolvedCapabilityProfile): string {
  return `${p.id}:${p.plugins === '*' ? '*' : [...p.plugins].sort().join(',')}:${p.usage ? 1 : 0}:${p.memory === false ? 0 : 1}`;
}

export type ValidateCapabilityProfileResult =
  | { ok: true; profile: CapabilityProfile }
  | { ok: false; error: string };

/**
 * Validate a custom-profile payload from the operator API. `knownPluginIds`
 * is the enabled plugin catalogue; unknown ids are rejected (400) so typos
 * surface instead of silently granting nothing.
 */
export function validateCapabilityProfileInput(
  raw: unknown,
  knownPluginIds: string[],
): ValidateCapabilityProfileResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const body = raw as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== 'string' || !CAPABILITY_PROFILE_ID_RE.test(id)) {
    return { ok: false, error: `id must match ${CAPABILITY_PROFILE_ID_RE.source}` };
  }
  if (BUILTIN_IDS.has(id)) {
    return { ok: false, error: `id '${id}' is a built-in profile` };
  }
  const label = body.label;
  if (typeof label !== 'string' || label.length === 0 || label.length > CAPABILITY_PROFILE_LABEL_MAX) {
    return { ok: false, error: `label must be a non-empty string of at most ${CAPABILITY_PROFILE_LABEL_MAX} characters` };
  }
  const known = new Set(knownPluginIds);
  if (body.plugins === '*') {
    // fine
  } else if (Array.isArray(body.plugins)) {
    for (const pluginId of body.plugins) {
      if (typeof pluginId !== 'string') {
        return { ok: false, error: 'plugins must be "*" or an array of plugin id strings' };
      }
      if (!known.has(pluginId)) {
        return { ok: false, error: `unknown plugin id: ${pluginId}` };
      }
    }
  } else {
    return { ok: false, error: 'plugins must be "*" or an array of plugin id strings' };
  }
  if (typeof body.usage !== 'boolean') {
    return { ok: false, error: 'usage (boolean) is required' };
  }
  if (body.memory !== undefined && typeof body.memory !== 'boolean') {
    return { ok: false, error: 'memory must be a boolean' };
  }
  const plugins = body.plugins === '*' ? '*' : [...new Set(body.plugins as string[])];
  return {
    ok: true,
    profile: {
      id,
      label,
      plugins,
      usage: body.usage,
      ...(typeof body.memory === 'boolean' ? { memory: body.memory } : {}),
    },
  };
}
