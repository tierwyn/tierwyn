export const DEFAULT_DB_PATH = './data/tierwyn.db';

/** Env var name for a Tierwyn setting suffix. */
export function envName(suffix: string): string {
  return `TIERWYN_${suffix}`;
}

/** Read `TIERWYN_<suffix>` from an env object. */
export function envPrefFrom(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[envName(suffix)];
}

export function envPref(suffix: string): string | undefined {
  return envPrefFrom(process.env, suffix);
}

export function envPrefOr(suffix: string, fallback: string): string {
  return envPref(suffix) ?? fallback;
}

export function dbPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return envPrefFrom(env, 'DB') ?? DEFAULT_DB_PATH;
}

export function pluginVaultKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const v = env[envName('PLUGIN_VAULT_KEY')];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function deletePluginVaultKeys(env: NodeJS.ProcessEnv): void {
  delete env[envName('PLUGIN_VAULT_KEY')];
}
