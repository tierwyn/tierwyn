import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { initVaultKey, vaultGet, vaultSet } from '../plugins/vault.js';
import { AGENT_VAULT_ID } from './mcpRedact.js';
import {
  agentEnvVaultKey,
  loadAgentEnv,
  loadAllAgentEnv,
  listAgentEnvVars,
  migrateCopilotTokenKey,
  parseAgentEnvVaultKey,
} from './agentEnv.js';

const SECRET32 = 'abcdefghijklmnopqrstuvwxyz012345';
/** A *different* valid (≥32 byte) key: the vault stays active, so rows sealed
 *  under SECRET32 fail decryption instead of being skipped as vault-off. */
const SECRET35 = 'a-different-33-byte-secret-xxxxx!!!';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

describe('agent env vault keys', () => {
  it('round-trips env.<agentType>.<NAME> including hyphenated types', () => {
    const key = agentEnvVaultKey('claude-code', 'OPENAI_API_KEY');
    expect(key).toBe('env.claude-code.OPENAI_API_KEY');
    expect(parseAgentEnvVaultKey(key)).toEqual({ agentType: 'claude-code', name: 'OPENAI_API_KEY' });
  });

  it('rejects the legacy copilot.token key and malformed rows', () => {
    expect(parseAgentEnvVaultKey('copilot.token')).toBeUndefined();
    expect(parseAgentEnvVaultKey('env.OPENAI_API_KEY')).toBeUndefined();
    expect(parseAgentEnvVaultKey('env.x.not-a-name')).toBeUndefined();
  });
});

describe('migrateCopilotTokenKey', () => {
  beforeEach(() => {
    initVaultKey({ sessionSecret: SECRET32 });
  });

  it('renames copilot.token to env.copilot.COPILOT_GITHUB_TOKEN and is idempotent', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, 'copilot.token', 'github_pat_abcdef123456');
    migrateCopilotTokenKey(d);
    expect(vaultGet(d, AGENT_VAULT_ID, 'copilot.token')).toBeUndefined();
    expect(vaultGet(d, AGENT_VAULT_ID, 'env.copilot.COPILOT_GITHUB_TOKEN')?.value).toBe('github_pat_abcdef123456');
    migrateCopilotTokenKey(d);
    expect(vaultGet(d, AGENT_VAULT_ID, 'env.copilot.COPILOT_GITHUB_TOKEN')?.value).toBe('github_pat_abcdef123456');
  });

  it('leaves copilot.token in place when the new key already exists', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, 'copilot.token', 'github_pat_old_token1');
    vaultSet(d, AGENT_VAULT_ID, 'env.copilot.COPILOT_GITHUB_TOKEN', 'github_pat_new_token2');
    migrateCopilotTokenKey(d);
    expect(vaultGet(d, AGENT_VAULT_ID, 'copilot.token')?.value).toBe('github_pat_old_token1');
    expect(vaultGet(d, AGENT_VAULT_ID, 'env.copilot.COPILOT_GITHUB_TOKEN')?.value).toBe('github_pat_new_token2');
  });
});

describe('loadAgentEnv', () => {
  beforeEach(() => {
    initVaultKey({ sessionSecret: SECRET32 });
  });

  it('returns own vars for the matching type and managed names for every env.* row', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('hermes', 'OPENAI_API_KEY'), 'sk-hermes-secret');
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-codex-secret');
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('hermes', 'ZAI_API_KEY'), 'sk-zai-secret1');
    const oc = loadAgentEnv(d, 'hermes');
    expect(oc.own).toEqual({ OPENAI_API_KEY: 'sk-hermes-secret', ZAI_API_KEY: 'sk-zai-secret1' });
    expect([...oc.managedNames].sort()).toEqual(['OPENAI_API_KEY', 'ZAI_API_KEY']);
    const other = loadAgentEnv(d, 'claude-code');
    expect(other.own).toEqual({});
    expect(other.managedNames.has('OPENAI_API_KEY')).toBe(true);
  });

  it('counts undecryptable and vault-off rows as managed without injecting them', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('hermes', 'OPENAI_API_KEY'), 'sk-hermes-secret');

    // Vault active under a different key: the row fails to decrypt, and the
    // variable name must survive as managed while no value is injected.
    initVaultKey({ sessionSecret: SECRET35 });
    const undecryptable = loadAgentEnv(d, 'hermes');
    expect(undecryptable.own).toEqual({});
    expect(undecryptable.managedNames.has('OPENAI_API_KEY')).toBe(true);

    // Vault entirely off: same outcome.
    initVaultKey({ sessionSecret: 'short' });
    const slice = loadAgentEnv(d, 'hermes');
    expect(slice.own).toEqual({});
    expect(slice.managedNames.has('OPENAI_API_KEY')).toBe(true);
  });
});

describe('loadAllAgentEnv', () => {
  beforeEach(() => {
    initVaultKey({ sessionSecret: SECRET32 });
  });

  it('groups values by agent and collects managed names across agents', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('hermes', 'OPENAI_API_KEY'), 'sk-hermes-secret');
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-codex-secret');
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('hermes', 'ZAI_API_KEY'), 'sk-zai-secret1');
    const all = loadAllAgentEnv(d);
    expect(all.vars).toEqual({
      hermes: { OPENAI_API_KEY: 'sk-hermes-secret', ZAI_API_KEY: 'sk-zai-secret1' },
      codex: { OPENAI_API_KEY: 'sk-codex-secret' },
    });
    expect([...all.managedNames].sort()).toEqual(['OPENAI_API_KEY', 'ZAI_API_KEY']);
  });

  it('keeps undecryptable and vault-off rows managed but valueless', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('hermes', 'OPENAI_API_KEY'), 'sk-hermes-secret');
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'ZAI_API_KEY'), 'sk-zai-secret2');

    // Corrupt the codex row by re-initialising the vault key: the vault stays
    // active, so the row still parses as env.<agent>.<NAME> but fails to
    // decrypt instead of being skipped as vault-off.
    initVaultKey({ sessionSecret: SECRET35 });
    let all = loadAllAgentEnv(d);
    expect(all.vars).toEqual({});
    expect([...all.managedNames].sort()).toEqual(['OPENAI_API_KEY', 'ZAI_API_KEY']);

    // Vault entirely off: rows stay managed, nothing decrypts.
    initVaultKey({ sessionSecret: 'short' });
    all = loadAllAgentEnv(d);
    expect(all.vars).toEqual({});
    expect([...all.managedNames].sort()).toEqual(['OPENAI_API_KEY', 'ZAI_API_KEY']);
  });
});

describe('denied agent-env rows', () => {
  beforeEach(() => {
    initVaultKey({ sessionSecret: SECRET32 });
  });

  it('does not inject a pre-seeded now-denied var and marks it denied in the list', () => {
    const d = db();
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('claude-code', 'HTTPS_PROXY'), 'http://evil.example:8080');
    vaultSet(d, AGENT_VAULT_ID, agentEnvVaultKey('claude-code', 'OPENAI_API_KEY'), 'sk-still-ok-secret');
    const slice = loadAgentEnv(d, 'claude-code');
    expect(slice.own.HTTPS_PROXY).toBeUndefined();
    expect(slice.own.OPENAI_API_KEY).toBe('sk-still-ok-secret');
    expect(slice.managedNames.has('HTTPS_PROXY')).toBe(false);
    const listed = listAgentEnvVars(d);
    expect(listed.find((r) => r.name === 'HTTPS_PROXY')?.denied).toBe(true);
    expect(listed.find((r) => r.name === 'OPENAI_API_KEY')?.denied).toBeUndefined();
  });
});
