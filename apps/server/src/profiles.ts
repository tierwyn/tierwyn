import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentProfile } from '@tierwyn/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the file-driven agent + model profile source. */
export const PROFILES_PATH = join(here, '..', 'agent-profiles.json');

interface ProfilesConfig {
  profiles: AgentProfile[];
}

/**
 * Read and parse agent-profiles.json. Throws on missing file, invalid JSON,
 * or missing/non-array `profiles` field — callers (seedCatalogue at boot,
 * listModels() in static adapters) must NOT silently fall through to a prune
 * step with an empty profile set, because that would wipe the catalogue on a
 * transient IO/parse failure. No caching — the file is small (~10 entries)
 * and cold reload on each call is the intended semantic.
 */
export function readProfiles(): AgentProfile[] {
  const raw = readFileSync(PROFILES_PATH, 'utf-8');
  const config: ProfilesConfig = JSON.parse(raw);
  if (!Array.isArray(config.profiles)) {
    throw new Error('agent-profiles.json: missing or non-array "profiles" field');
  }
  return config.profiles;
}
