import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DB_PATH,
  dbPathFromEnv,
  deletePluginVaultKeys,
  envName,
  envPrefFrom,
  pluginVaultKeyFromEnv,
} from './env.js';

describe('env helpers', () => {
  it('envName prefixes TIERWYN_', () => {
    expect(envName('DB')).toBe('TIERWYN_DB');
  });

  it('envPrefFrom reads TIERWYN_* only', () => {
    expect(envPrefFrom({ TIERWYN_X: 'a' }, 'X')).toBe('a');
    expect(envPrefFrom({}, 'X')).toBeUndefined();
  });

  it('dbPathFromEnv uses TIERWYN_DB, else the default', () => {
    expect(dbPathFromEnv({ TIERWYN_DB: '/x.db' })).toBe('/x.db');
    expect(dbPathFromEnv({})).toBe(DEFAULT_DB_PATH);
    expect(DEFAULT_DB_PATH).toBe('./data/tierwyn.db');
  });

  it('pluginVaultKeyFromEnv ignores empty values', () => {
    expect(pluginVaultKeyFromEnv({ TIERWYN_PLUGIN_VAULT_KEY: 'k' })).toBe('k');
    expect(pluginVaultKeyFromEnv({ TIERWYN_PLUGIN_VAULT_KEY: '' })).toBeUndefined();
  });

  it('deletePluginVaultKeys removes the key', () => {
    const env: NodeJS.ProcessEnv = { TIERWYN_PLUGIN_VAULT_KEY: 'k' };
    deletePluginVaultKeys(env);
    expect(env.TIERWYN_PLUGIN_VAULT_KEY).toBeUndefined();
  });
});
