import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { NodeHello } from '@tierwyn/shared';
import { probeAllLogins, probeLogin, withDeliveredLogin } from './loginProbe.js';

const homes: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-login-'));
  homes.push(d);
  return d;
}
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe('probeLogin', () => {
  it('codex: true when auth.json holds an access_token', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({
      tokens: { access_token: 'at-x', refresh_token: 'rt-x' },
    }));
    expect(probeLogin('codex', home, {}, 'linux')).toBe(true);
  });

  it('codex: true when auth.json holds openai_api_key', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ openai_api_key: 'sk-x' }));
    expect(probeLogin('codex', home, {}, 'linux')).toBe(true);
  });

  it('codex: false when tokens are nulled (logged out)', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({
      tokens: null,
      OPENAI_API_KEY: null,
    }));
    expect(probeLogin('codex', home, {}, 'linux')).toBe(false);
  });

  it('codex: false when auth.json is corrupt', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{not json');
    expect(probeLogin('codex', home, {}, 'linux')).toBe(false);
  });

  it('codex: false when nothing is present', () => {
    expect(probeLogin('codex', tmpHome(), {}, 'linux')).toBe(false);
  });

  it('codex: true when OPENAI_API_KEY is non-empty', () => {
    expect(probeLogin('codex', tmpHome(), { OPENAI_API_KEY: 'sk-x' }, 'linux')).toBe(true);
  });

  it('codex: env key still wins over a logged-out auth.json', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: null }));
    expect(probeLogin('codex', home, { OPENAI_API_KEY: 'sk-x' }, 'linux')).toBe(true);
  });

  it('empty env value does not count as logged in', () => {
    expect(probeLogin('codex', tmpHome(), { OPENAI_API_KEY: '' }, 'linux')).toBe(false);
  });

  it('claude-code: undefined on darwin (keychain → unknown, no chip)', () => {
    expect(probeLogin('claude-code', tmpHome(), {}, 'darwin')).toBeUndefined();
  });

  it('claude-code: credentials file with claudeAiOauth tokens on linux → true', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat-x', refreshToken: 'sk-ant-ort-x' },
    }));
    expect(probeLogin('claude-code', home, {}, 'linux')).toBe(true);
  });

  it('claude-code: false when credentials JSON has no oauth tokens', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    expect(probeLogin('claude-code', home, {}, 'linux')).toBe(false);
  });

  it('claude-code: false when only mcpOAuth metadata remains', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({
      mcpOAuth: { 'plugin:x': { serverName: 'x', accessToken: '' } },
    }));
    expect(probeLogin('claude-code', home, {}, 'linux')).toBe(false);
  });

  it('claude-code: false on linux with no artifacts', () => {
    expect(probeLogin('claude-code', tmpHome(), {}, 'linux')).toBe(false);
  });

  it('unknown type → undefined', () => {
    expect(probeLogin('pi', tmpHome(), {}, 'linux')).toBeUndefined();
  });

  it('kilocode has no probe entry', () => {
    expect(probeLogin('kilocode', tmpHome(), {}, 'linux')).toBeUndefined();
  });
});

describe('probeLogin grok-build', () => {
  it('false when auth.json is empty object', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), '{}');
    expect(probeLogin('grok-build', home, {}, 'linux')).toBe(false);
  });

  it('false when issuer entry is metadata-only', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
      'issuer.example::client': {},
    }));
    expect(probeLogin('grok-build', home, {}, 'linux')).toBe(false);
  });

  it('true when issuer entry has a key', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
      'issuer.example::client': { key: 'gk-x', expires_at: 1 },
    }));
    expect(probeLogin('grok-build', home, {}, 'linux')).toBe(true);
  });

  it('true when issuer entry has a refresh_token', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
      'issuer.example::client': { refresh_token: 'rt-x' },
    }));
    expect(probeLogin('grok-build', home, {}, 'linux')).toBe(true);
  });

  it('true when GROK_CODE_XAI_API_KEY is set', () => {
    expect(probeLogin('grok-build', tmpHome(), { GROK_CODE_XAI_API_KEY: 'gk-x' }, 'linux')).toBe(true);
  });

  it('true when XAI_API_KEY is set', () => {
    expect(probeLogin('grok-build', tmpHome(), { XAI_API_KEY: 'gk-x' }, 'linux')).toBe(true);
  });
});

describe('probeLogin copilot', () => {
  function writeConfig(home: string, body: string, dir?: string) {
    const root = dir ?? join(home, '.copilot');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), body);
  }

  it('false when config.json is empty object', () => {
    const home = tmpHome();
    writeConfig(home, '{}');
    expect(probeLogin('copilot', home, {}, 'linux')).toBe(false);
  });

  it('false when config.json is malformed', () => {
    const home = tmpHome();
    writeConfig(home, '{not json');
    expect(probeLogin('copilot', home, {}, 'linux')).toBe(false);
  });

  it('false when only lastLoggedInUser metadata remains', () => {
    const home = tmpHome();
    writeConfig(home, JSON.stringify({ lastLoggedInUser: 'alice' }));
    expect(probeLogin('copilot', home, {}, 'linux')).toBe(false);
  });

  it('true when loggedInUsers is non-empty', () => {
    const home = tmpHome();
    writeConfig(home, JSON.stringify({
      loggedInUsers: [{ host: 'github.com', kind: 'github', login: 'alice' }],
    }));
    expect(probeLogin('copilot', home, {}, 'linux')).toBe(true);
  });

  it('true when a token field is present', () => {
    const home = tmpHome();
    writeConfig(home, JSON.stringify({ token: 'gho-x' }));
    expect(probeLogin('copilot', home, {}, 'linux')).toBe(true);
  });

  it('tolerates // comment lines before JSON', () => {
    const home = tmpHome();
    writeConfig(home, '// generated\n{"loggedInUsers":[{"login":"alice"}]}');
    expect(probeLogin('copilot', home, {}, 'linux')).toBe(true);
  });

  it('true when COPILOT_GITHUB_TOKEN is set', () => {
    expect(probeLogin('copilot', tmpHome(), { COPILOT_GITHUB_TOKEN: 'gho-x' }, 'linux')).toBe(true);
  });

  it('false when only GH_TOKEN or GITHUB_TOKEN is set', () => {
    expect(probeLogin('copilot', tmpHome(), { GH_TOKEN: 'gho-x' }, 'linux')).toBe(false);
    expect(probeLogin('copilot', tmpHome(), { GITHUB_TOKEN: 'gho-x' }, 'linux')).toBe(false);
  });

  it('reads config.json from COPILOT_HOME', () => {
    const home = tmpHome();
    const copilotHome = join(tmpHome(), 'custom-copilot');
    writeConfig(home, '{}', copilotHome);
    writeFileSync(join(copilotHome, 'config.json'), JSON.stringify({
      loggedInUsers: [{ login: 'alice' }],
    }));
    expect(probeLogin('copilot', home, { COPILOT_HOME: copilotHome }, 'linux')).toBe(true);
  });
});

describe('probeLogin cursor', () => {
  function writeAuth(home: string, json: unknown, configRoot?: string) {
    const dir = join(configRoot ?? join(home, '.config'), 'cursor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }

  it('false on darwin with no auth files', () => {
    expect(probeLogin('cursor', tmpHome(), {}, 'darwin')).toBe(false);
  });

  it('true on darwin when CURSOR_API_KEY is set', () => {
    expect(probeLogin('cursor', tmpHome(), { CURSOR_API_KEY: 'cur-x' }, 'darwin')).toBe(true);
  });

  it('true on darwin from Application Support auth.json', () => {
    const home = tmpHome();
    const dir = join(home, 'Library', 'Application Support', 'Cursor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ accessToken: 'at-mac' }));
    expect(probeLogin('cursor', home, {}, 'darwin')).toBe(true);
  });

  it('false when auth.json is empty object', () => {
    const home = tmpHome();
    writeAuth(home, {});
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(false);
  });

  it('false when auth.json is malformed', () => {
    const home = tmpHome();
    writeAuth(home, '{not json');
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(false);
  });

  it('false when only non-token metadata remains', () => {
    const home = tmpHome();
    writeAuth(home, { email: 'a@b.c' });
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(false);
  });

  it('true when accessToken is present', () => {
    const home = tmpHome();
    writeAuth(home, { accessToken: 'at-x' });
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(true);
  });

  it('true when refreshToken is present', () => {
    const home = tmpHome();
    writeAuth(home, { refreshToken: 'rt-x' });
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(true);
  });

  it('true when CURSOR_API_KEY is set', () => {
    expect(probeLogin('cursor', tmpHome(), { CURSOR_API_KEY: 'cur-x' }, 'linux')).toBe(true);
  });

  it('reads auth.json from XDG_CONFIG_HOME', () => {
    const home = tmpHome();
    const xdg = join(tmpHome(), 'xdg-config');
    writeAuth(home, { email: 'a@b.c' });
    writeAuth(home, { accessToken: 'at-x' }, xdg);
    expect(probeLogin('cursor', home, { XDG_CONFIG_HOME: xdg }, 'linux')).toBe(true);
  });

  it('false on empty HOME', () => {
    expect(probeLogin('cursor', tmpHome(), {}, 'linux')).toBe(false);
  });

  it('false when only ~/.cursor/cli-config.json is present', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'cli-config.json'), JSON.stringify({
      editor: { vimMode: false },
    }));
    writeFileSync(join(home, '.cursor', 'statsig-cache.json'), JSON.stringify({ data: {}, userID: '' }));
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(false);
  });

  it('true when ~/.cursor/auth.json holds tokens', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'auth.json'), JSON.stringify({ accessToken: 'at-dot-cursor' }));
    expect(probeLogin('cursor', home, {}, 'linux')).toBe(true);
  });
});

describe('probeLogin kimi', () => {
  function kimiRoot(home: string, env: NodeJS.ProcessEnv = {}) {
    const override = env.KIMI_CODE_HOME;
    return typeof override === 'string' && override.length > 0 ? override : join(home, '.kimi-code');
  }

  it('false when nothing is present', () => {
    expect(probeLogin('kimi', tmpHome(), {}, 'linux')).toBe(false);
  });

  it('false when credentials file has no refreshToken', () => {
    const home = tmpHome();
    const dir = join(kimiRoot(home), 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess.json'), JSON.stringify({ user: 'alice' }));
    expect(probeLogin('kimi', home, {}, 'linux')).toBe(false);
  });

  it('true when a credentials file holds refreshToken', () => {
    const home = tmpHome();
    const dir = join(kimiRoot(home), 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess.json'), JSON.stringify({ refreshToken: 'rt-x' }));
    expect(probeLogin('kimi', home, {}, 'linux')).toBe(true);
  });

  it('true when config.toml has api_key under [providers.*]', () => {
    const home = tmpHome();
    mkdirSync(kimiRoot(home), { recursive: true });
    writeFileSync(join(kimiRoot(home), 'config.toml'), '[providers.kimi]\napi_key = "sk-x"\n');
    expect(probeLogin('kimi', home, {}, 'linux')).toBe(true);
  });

  it('false when api_key is empty or outside [providers.*]', () => {
    const home = tmpHome();
    mkdirSync(kimiRoot(home), { recursive: true });
    writeFileSync(join(kimiRoot(home), 'config.toml'), '[providers.kimi]\napi_key = ""\n[misc]\napi_key = "sk-x"\n');
    expect(probeLogin('kimi', home, {}, 'linux')).toBe(false);
  });

  it('true when KIMI_API_KEY is set', () => {
    expect(probeLogin('kimi', tmpHome(), { KIMI_API_KEY: 'sk-x' }, 'linux')).toBe(true);
  });

  it('reads credentials from KIMI_CODE_HOME', () => {
    const home = tmpHome();
    const custom = join(tmpHome(), 'kimi-home');
    const dir = join(custom, 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess.json'), JSON.stringify({ refreshToken: 'rt-x' }));
    expect(probeLogin('kimi', home, { KIMI_CODE_HOME: custom }, 'linux')).toBe(true);
  });
});

describe('probeLogin kiro', () => {
  function dbPath(home: string, env: NodeJS.ProcessEnv = {}) {
    const xdg = env.XDG_DATA_HOME;
    const data = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(home, '.local', 'share');
    return join(data, 'kiro-cli', 'data.sqlite3');
  }

  function writeKv(home: string, rows: Array<[string, string]>, env: NodeJS.ProcessEnv = {}) {
    const path = dbPath(home, env);
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    const ins = db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)');
    for (const [k, v] of rows) ins.run(k, v);
    db.close();
    return path;
  }

  it('false when the db is missing', () => {
    expect(() => probeLogin('kiro', tmpHome(), {}, 'linux')).not.toThrow();
    expect(probeLogin('kiro', tmpHome(), {}, 'linux')).toBe(false);
  });

  it('false when auth_kv is missing', () => {
    const home = tmpHome();
    const path = dbPath(home);
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.exec('CREATE TABLE other (k TEXT)');
    db.close();
    expect(() => probeLogin('kiro', home, {}, 'linux')).not.toThrow();
    expect(probeLogin('kiro', home, {}, 'linux')).toBe(false);
  });

  it('false when a locked db cannot be read, without a 5s busy wait', { timeout: 5_000 }, () => {
    const home = tmpHome();
    const path = dbPath(home);
    mkdirSync(join(path, '..'), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = DELETE');
    writer.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    writer.exec('BEGIN EXCLUSIVE');
    let result: boolean | undefined;
    const t0 = Date.now();
    try {
      expect(() => { result = probeLogin('kiro', home, {}, 'linux'); }).not.toThrow();
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
    expect(result).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('false when the kv row has no token', () => {
    const home = tmpHome();
    writeKv(home, [['kirocli:social:token', JSON.stringify({ provider: 'google' })]]);
    expect(probeLogin('kiro', home, {}, 'linux')).toBe(false);
  });

  it('true when auth_kv holds an access_token', () => {
    const home = tmpHome();
    writeKv(home, [['kirocli:social:token', JSON.stringify({
      access_token: 'at-x', refresh_token: 'rt-x',
    })]]);
    expect(probeLogin('kiro', home, {}, 'linux')).toBe(true);
  });

  it('true when KIRO_API_KEY is set', () => {
    expect(probeLogin('kiro', tmpHome(), { KIRO_API_KEY: 'kr-x' }, 'linux')).toBe(true);
  });

  it('does not throw a message containing the token value', () => {
    const home = tmpHome();
    const secret = 'SECRETVALUE_kiro_probe_x';
    writeKv(home, [['kirocli:social:token', JSON.stringify({ access_token: secret })]]);
    try {
      expect(probeLogin('kiro', home, {}, 'linux')).toBe(true);
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      throw err;
    }
  });
});

describe('probeAllLogins timing', () => {
  it('answers well inside a 5s window with a real kiro sqlite read', () => {
    const home = tmpHome();
    const path = join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
      'kirocli:social:token',
      JSON.stringify({ access_token: 'at-x' }),
    );
    db.close();
    const t0 = Date.now();
    const map = probeAllLogins(home, {}, 'linux');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(map.kiro).toBe(true);
    expect(map.copilot).toBe(false);
    expect(map.kilocode).toBeUndefined();
  });
});

describe('withDeliveredLogin', () => {
  function hello(over: Partial<NodeHello> = {}): Partial<NodeHello> {
    return {
      features: ['agent_env'],
      agents: {
        'claude-code': { installed: true, methods: [] },
        pi: { installed: true, methods: [] },
      },
      ...over,
    };
  }

  it('marks claude-code logged in for CLAUDE_CODE_OAUTH_TOKEN', () => {
    const out = withDeliveredLogin(hello(), [{ agentType: 'claude-code', name: 'CLAUDE_CODE_OAUTH_TOKEN' }]);
    expect(out.agents?.['claude-code']?.loggedIn).toBe(true);
  });

  it('ignores a name not in the agent probe', () => {
    const out = withDeliveredLogin(hello(), [{ agentType: 'claude-code', name: 'ZAI_API_KEY' }]);
    expect(out.agents?.['claude-code']?.loggedIn).toBeUndefined();
  });

  it('ignores a var saved for a different agent type', () => {
    const out = withDeliveredLogin(hello(), [{ agentType: 'codex', name: 'OPENAI_API_KEY' }]);
    expect(out.agents?.['claude-code']?.loggedIn).toBeUndefined();
    expect(out.agents?.codex).toBeUndefined();
  });

  it('ignores an agent that is not installed', () => {
    const out = withDeliveredLogin(
      hello({ agents: { 'claude-code': { installed: false, methods: [] } } }),
      [{ agentType: 'claude-code', name: 'CLAUDE_CODE_OAUTH_TOKEN' }],
    );
    expect(out.agents?.['claude-code']?.loggedIn).toBeUndefined();
  });

  it('ignores a hello without agent_env', () => {
    const out = withDeliveredLogin(
      hello({ features: ['node.selfUpdate'] }),
      [{ agentType: 'claude-code', name: 'CLAUDE_CODE_OAUTH_TOKEN' }],
    );
    expect(out.agents?.['claude-code']?.loggedIn).toBeUndefined();
  });

  it('leaves an agent with no probe entry unchanged (pi)', () => {
    const out = withDeliveredLogin(hello(), [{ agentType: 'pi', name: 'ZAI_API_KEY' }]);
    expect(out.agents?.pi?.loggedIn).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const h = hello();
    const before = JSON.stringify(h);
    withDeliveredLogin(h, [{ agentType: 'claude-code', name: 'CLAUDE_CODE_OAUTH_TOKEN' }]);
    expect(JSON.stringify(h)).toBe(before);
  });

  it.each([
    ['copilot', 'COPILOT_GITHUB_TOKEN'],
    ['cursor', 'CURSOR_API_KEY'],
    ['kimi', 'KIMI_API_KEY'],
    ['kiro', 'KIRO_API_KEY'],
  ] as const)('badges a delivered %s %s', (type, name) => {
    const out = withDeliveredLogin(
      hello({ agents: { [type]: { installed: true, methods: [] } } }),
      [{ agentType: type, name }],
    );
    expect(out.agents?.[type]?.loggedIn).toBe(true);
  });
});
