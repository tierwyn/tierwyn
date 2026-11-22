import type { Database } from 'better-sqlite3';
import {
  BUILTIN_CAPABILITY_PROFILES,
  DEFAULT_CAPABILITY_PROFILE_ID,
  FALLBACK_CAPABILITY_PROFILE_ID,
  type CapabilityProfile,
  type ResolvedCapabilityProfile,
} from '@tierwyn/shared';

const PROFILES_KEY = 'capability_profiles';
const DEFAULT_PROFILE_KEY = 'default_capability_profile';

function isPlausibleProfile(v: unknown): v is CapabilityProfile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<CapabilityProfile>;
  return typeof o.id === 'string' && typeof o.label === 'string' && (o.plugins === '*' || Array.isArray(o.plugins));
}

/** Operator-defined profiles. Settings blob key `capability_profiles` = array.
 *  Missing/corrupt row ⇒ []. Defensive parse like listCustomDesignations. */
export function listCustomCapabilityProfiles(db: Database): CapabilityProfile[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PROFILES_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter(isPlausibleProfile) : [];
  } catch {
    return [];
  }
}

function persistCustomProfiles(db: Database, profiles: CapabilityProfile[]): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PROFILES_KEY, JSON.stringify(profiles));
}

/** Builtin profiles first (plan order), then customs sorted by id for a stable UI. */
export function listCapabilityProfiles(db: Database): CapabilityProfile[] {
  const custom = listCustomCapabilityProfiles(db)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...BUILTIN_CAPABILITY_PROFILES, ...custom];
}

export function getCapabilityProfile(db: Database, id: string): CapabilityProfile | undefined {
  return listCapabilityProfiles(db).find((p) => p.id === id);
}

/** Get the configured default profile id; falls back to DEFAULT_CAPABILITY_PROFILE_ID ('all')
 *  if unset, or fails closed to FALLBACK_CAPABILITY_PROFILE_ID ('minimal') if pointing to
 *  a profile that no longer exists (unknown grants must never widen). */
export function getDefaultCapabilityProfileId(db: Database): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEFAULT_PROFILE_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_CAPABILITY_PROFILE_ID;
  const id = row.value.trim();
  if (!id) return DEFAULT_CAPABILITY_PROFILE_ID;
  const exists = getCapabilityProfile(db, id);
  if (!exists) {
    console.warn(`[capability-profiles] configured default profile '${id}' not found → ${FALLBACK_CAPABILITY_PROFILE_ID}`);
    return FALLBACK_CAPABILITY_PROFILE_ID;
  }
  return exists.id;
}

/** Persist a new default capability profile. The id must exist in listCapabilityProfiles. */
export function setDefaultCapabilityProfileId(db: Database, id: string): boolean {
  const profile = getCapabilityProfile(db, id);
  if (!profile) return false;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DEFAULT_PROFILE_KEY, profile.id);
  return true;
}

/** Upsert a validated custom profile. Built-in ids must be rejected by the
 *  caller (route-level validator). */
export function saveCapabilityProfile(db: Database, profile: CapabilityProfile): CapabilityProfile[] {
  const custom = listCustomCapabilityProfiles(db).filter((p) => p.id !== profile.id);
  persistCustomProfiles(db, [...custom, profile]);
  return listCapabilityProfiles(db);
}

/** Delete a custom profile. Built-ins and the active default profile are undeletable;
 *  unknown ids return false. */
export function deleteCapabilityProfile(db: Database, id: string): boolean {
  if (BUILTIN_CAPABILITY_PROFILES.some((p) => p.id === id)) return false;
  if (getDefaultCapabilityProfileId(db) === id) return false;
  const custom = listCustomCapabilityProfiles(db);
  const next = custom.filter((p) => p.id !== id);
  if (next.length === custom.length) return false;
  persistCustomProfiles(db, next);
  return true;
}

export function countConversationsUsingProfile(db: Database, id: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE capability_profile = ?').get(id) as { n: number };
  return row.n;
}

/** Conversation ids currently assigned this profile (for revoke-on-edit). */
export function listConversationIdsUsingProfile(db: Database, id: string): string[] {
  return (db.prepare('SELECT id FROM conversations WHERE capability_profile = ?').all(id) as { id: string }[])
    .map((r) => r.id);
}

/** Conversation ids currently using the default profile (NULL capability_profile). */
export function listConversationIdsUsingDefaultProfile(db: Database): string[] {
  return (db.prepare('SELECT id FROM conversations WHERE capability_profile IS NULL').all() as { id: string }[])
    .map((r) => r.id);
}

/**
 * Resolve a conversation row's profile to the grant baked into its tokens.
 * NULL/'' ⇒ the default profile; an id that no longer exists (deleted custom
 * profile) fails **closed** to `minimal` — an unknown grant must never widen.
 */
export function resolveConversationProfile(
  db: Database,
  capabilityProfile: string | null | undefined,
): ResolvedCapabilityProfile {
  const id = capabilityProfile?.trim() ? capabilityProfile : getDefaultCapabilityProfileId(db);
  const found = getCapabilityProfile(db, id);
  if (!found) {
    console.warn(`[capability-profiles] unknown profile ${id} → ${FALLBACK_CAPABILITY_PROFILE_ID}`);
    return { id: FALLBACK_CAPABILITY_PROFILE_ID, plugins: [], usage: false, memory: false };
  }
  return {
    id: found.id,
    plugins: found.plugins === '*' ? '*' : [...found.plugins],
    usage: found.usage,
    memory: found.memory,
  };
}
