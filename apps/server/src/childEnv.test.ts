import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  AGENT_ENV_DENIED_EXACT,
  AGENT_ENV_DENIED_PREFIXES,
  ALWAYS_SCRUB,
  applyListenPort,
  buildChildEnv,
  isAlwaysScrubbed,
  isDeniedAgentEnvName,
  setAgentEnvSource,
  setPluginScrubKeys,
} from './childEnv.js';

const here = dirname(fileURLToPath(import.meta.url));

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe('buildChildEnv', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    setPluginScrubKeys([]);
    setAgentEnvSource(() => ({ own: {}, managedNames: new Set() }));
    for (const [k, v] of Object.entries(saved)) restoreEnv(k, v);
    for (const k of Object.keys(saved)) delete saved[k];
  });

  function stash(key: string, value: string): void {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  it('strips PORT/HOST/SESSION_SECRET/OPERATOR_PASSWORD_HASH/plugin keys/deny-list and keeps PATH/HOME/TIERWYN_LISTEN_PORT/OPENAI_API_KEY; extra overlays', () => {
    stash('PORT', '8788');
    stash('HOST', '127.0.0.1');
    stash('TIERWYN_DB', '/srv/tierwyn/data/prod.db');
    stash('SESSION_SECRET', 'sess-secret-value');
    stash('OPERATOR_PASSWORD_HASH', '$argon2id$test');
    stash('TIERWYN_PLUGIN_VAULT_KEY', 'tierwyn-vault-key-value');
    stash('SPAWN_TOKEN', 'stale-spawn-token');
    stash('ZAI_API_KEY', 'zai-secret-key');
    stash('CUSTOM_DENY', 'nope');
    stash('TIERWYN_CHILD_ENV_DENY', 'CUSTOM_DENY');
    stash('PATH', '/usr/bin');
    stash('HOME', '/home/op');
    stash('TIERWYN_LISTEN_PORT', '8788');
    stash('OPENAI_API_KEY', 'sk-openai');
    setPluginScrubKeys(['ZAI_API_KEY']);

    const env = buildChildEnv({ EXTRA: 'yes' });
    expect(env.PORT).toBeUndefined();
    expect(env.HOST).toBeUndefined();
    // A child that boots its own Tierwyn (tests, dev server in a worktree) must not open the parent's DB.
    expect(env.TIERWYN_DB).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.OPERATOR_PASSWORD_HASH).toBeUndefined();
    expect(env.TIERWYN_PLUGIN_VAULT_KEY).toBeUndefined();
    expect(env.SPAWN_TOKEN).toBeUndefined();
    expect(env.ZAI_API_KEY).toBeUndefined();
    expect(env.CUSTOM_DENY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/op');
    expect(env.TIERWYN_LISTEN_PORT).toBe('8788');
    expect(env.OPENAI_API_KEY).toBe('sk-openai');
    expect(env.EXTRA).toBe('yes');
  });

  it('sets PWD to the resolved cwd when cwd is provided', () => {
    stash('PWD', '/server/repo');
    const env = buildChildEnv(undefined, '/tmp/project');
    expect(env.PWD).toBe('/tmp/project');
  });

  it('cwd PWD wins over inherited and extra PWD unless extra overrides after', () => {
    stash('PWD', '/server/repo');
    const env = buildChildEnv({ PWD: '/explicit' }, '/tmp/project');
    // extra overlays base first; cwd is applied last so session dir matches spawn cwd
    expect(env.PWD).toBe('/tmp/project');
  });

  it('injects own vault vars only for the matching agent type', () => {
    stash('OPENAI_API_KEY', 'sk-from-prod');
    setAgentEnvSource((agentType) => ({
      own: agentType === 'codex' ? { OPENAI_API_KEY: 'sk-vault-codex' } : {},
      managedNames: new Set(['OPENAI_API_KEY']),
    }));
    const own = buildChildEnv(undefined, undefined, 'codex');
    expect(own.OPENAI_API_KEY).toBe('sk-vault-codex');
    const other = buildChildEnv(undefined, undefined, 'claude-code');
    expect(other.OPENAI_API_KEY).toBeUndefined();
  });

  it('scrubs a managed name for other types even when it is in process.env', () => {
    stash('OPENAI_API_KEY', 'sk-from-prod');
    setAgentEnvSource((agentType) => ({
      own: agentType === 'codex' ? { OPENAI_API_KEY: 'sk-vault' } : {},
      managedNames: new Set(['OPENAI_API_KEY']),
    }));
    const env = buildChildEnv(undefined, undefined, 'claude-code');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('re-scrubs plugin and managed vault keys from extra; own vault is re-injected for the matching agent', () => {
    setPluginScrubKeys(['ZAI_API_KEY']);
    setAgentEnvSource(() => ({
      own: { OPENAI_API_KEY: 'sk-vault' },
      managedNames: new Set(['OPENAI_API_KEY']),
    }));
    const env = buildChildEnv(
      { OPENAI_API_KEY: 'sk-extra', ZAI_API_KEY: 'injected' },
      undefined,
      'codex',
    );
    expect(env.OPENAI_API_KEY).toBe('sk-vault');
    expect(env.ZAI_API_KEY).toBeUndefined();
  });

  it('re-scrubs SESSION_SECRET from extra and keeps TIERWYN_MCPV_ placeholders', () => {
    const env = buildChildEnv({
      SESSION_SECRET: 'x',
      TIERWYN_MCPV_1: 'y',
      TIERWYN_MCP_GITHUB_TOKEN: 'z',
      TIERWYN_MCP_GITHUB_TOKEN: 'w',
      TIERWYN_MCPV_0: 'v',
    });
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.TIERWYN_MCPV_1).toBe('y');
    expect(env.TIERWYN_MCPV_0).toBe('v');
    expect(env.TIERWYN_MCP_GITHUB_TOKEN).toBeUndefined();
  });

  it('applyListenPort writes TIERWYN_LISTEN_PORT', () => {
    const env: NodeJS.ProcessEnv = {};
    applyListenPort(env, 8788);
    expect(env.TIERWYN_LISTEN_PORT).toBe('8788');
  });

  it('scrubs managed names and does not inject own when agentType is omitted', () => {
    stash('OPENAI_API_KEY', 'sk-from-prod');
    setAgentEnvSource(() => ({
      own: { OPENAI_API_KEY: 'sk-vault' },
      managedNames: new Set(['OPENAI_API_KEY']),
    }));
    const env = buildChildEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('agent-env deny list', () => {
  it('covers PATH/HOME/PWD, ALWAYS_SCRUB names, and LD_/DYLD_/TIERWYN_/npm_config_ prefixes', () => {
    for (const name of ['PATH', 'HOME', 'PWD', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
      'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONSTARTUP',
      'PORT', 'HOST', 'TIERWYN_DB', 'TIERWYN_DB', 'SESSION_SECRET', 'OPERATOR_PASSWORD_HASH',
      'TIERWYN_PLUGIN_VAULT_KEY', 'TIERWYN_PLUGIN_VAULT_KEY', 'SPAWN_TOKEN']) {
      expect(AGENT_ENV_DENIED_EXACT.has(name)).toBe(true);
      expect(isDeniedAgentEnvName(name)).toBe(true);
    }
    expect(AGENT_ENV_DENIED_PREFIXES).toEqual(
      expect.arrayContaining(['TIERWYN_', 'TIERWYN_']),
    );
    expect(ALWAYS_SCRUB).toEqual(expect.arrayContaining([
      'TIERWYN_DB', 'TIERWYN_DB', 'TIERWYN_PLUGIN_VAULT_KEY', 'TIERWYN_PLUGIN_VAULT_KEY',
    ]));
    expect(isAlwaysScrubbed('TIERWYN_MCP_TOKEN')).toBe(true);
    expect(isAlwaysScrubbed('TIERWYN_MCPV_0')).toBe(false);
    expect(isDeniedAgentEnvName('TIERWYN_LISTEN_PORT')).toBe(true);
    expect(isDeniedAgentEnvName('LD_PRELOAD')).toBe(true);
    expect(isDeniedAgentEnvName('DYLD_LIBRARY_PATH')).toBe(true);
    expect(isDeniedAgentEnvName('npm_config_cache')).toBe(true);
    expect(isDeniedAgentEnvName('NPM_CONFIG_SCRIPT_SHELL')).toBe(true);
    expect(isDeniedAgentEnvName('NPM_CONFIG_NODE_OPTIONS')).toBe(true);
    expect(isDeniedAgentEnvName('GIT_SSH_COMMAND')).toBe(true);
    expect(isDeniedAgentEnvName('GIT_CONFIG_KEY_0')).toBe(true);
    expect(isDeniedAgentEnvName('GIT_SEQUENCE_EDITOR')).toBe(true);
    expect(isDeniedAgentEnvName('GIT_SSL_NO_VERIFY')).toBe(true);
    expect(isDeniedAgentEnvName('GIT_SSL_CAINFO')).toBe(true);
    expect(isDeniedAgentEnvName('LESSOPEN')).toBe(true);
    expect(isDeniedAgentEnvName('DOTNET_STARTUP_HOOKS')).toBe(true);
    expect(isDeniedAgentEnvName('GOFLAGS')).toBe(true);
    expect(isDeniedAgentEnvName('RUSTC_WRAPPER')).toBe(true);
    expect(isDeniedAgentEnvName('LUA_INIT')).toBe(true);
    expect(isDeniedAgentEnvName('PYTHONUSERBASE')).toBe(true);
    expect(isDeniedAgentEnvName('PHPRC')).toBe(true);
    expect(isDeniedAgentEnvName('PHP_INI_SCAN_DIR')).toBe(true);
    expect(isDeniedAgentEnvName('ELECTRON_RUN_AS_NODE')).toBe(true);
    expect(isDeniedAgentEnvName('BASH_FUNC_foo')).toBe(true);
    expect(isDeniedAgentEnvName('PERL5OPT')).toBe(true);
    expect(isDeniedAgentEnvName('PYTHONHOME')).toBe(true);
    expect(isDeniedAgentEnvName('HTTPS_PROXY')).toBe(true);
    expect(isDeniedAgentEnvName('NODE_EXTRA_CA_CERTS')).toBe(true);
    expect(isDeniedAgentEnvName('OPENAI_API_KEY')).toBe(false);
    expect(isDeniedAgentEnvName('ANTHROPIC_BASE_URL')).toBe(false);
    expect(isDeniedAgentEnvName('COPILOT_GITHUB_TOKEN')).toBe(false);
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function thirdArgLacksEnv(call: string): boolean {
  let i = call.indexOf('(') + 1;
  let depth = 1;
  const args: string[] = [];
  let current = '';
  let brace = 0;
  let bracket = 0;
  let quote: string | null = null;
  for (; i < call.length; i++) {
    const c = call[i]!;
    if (quote) {
      current += c;
      if (c === quote && call[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; current += c; continue; }
    if (c === '{') brace++;
    if (c === '}') brace--;
    if (c === '[') bracket++;
    if (c === ']') bracket--;
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) {
        args.push(current.trim());
        break;
      }
    }
    if (c === ',' && brace === 0 && bracket === 0 && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (args.length < 3) return true;
  const third = args[2] ?? '';
  if (!third.startsWith('{')) return true;
  return !/\benv\s*:/.test(third);
}

describe('source-grep guard over adapters/', () => {
  const adaptersDir = join(here, 'adapters');
  const files = walkTs(adaptersDir);

  it('has adapter sources to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no `{ ...process.env` and no spawn(-with-options lacking env:', () => {
    const failures: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const stripped = stripComments(src);
      if (/\{\s*\.\.\.\s*process\.env/.test(stripped)) {
        failures.push(`${file}: clones process.env`);
      }
      const re = /(?:^|[^\w])(?:node)?spawn\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped))) {
        const window = stripped.slice(m.index, m.index + 800);
        if (thirdArgLacksEnv(window)) {
          const line = stripped.slice(0, m.index).split('\n').length;
          failures.push(`${file}:${line}: spawn( without env:`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
