import { resolve } from 'path';
import { envName, envPref } from './config/env.js';

/**
 * Single child-env scrub helper. Adopted at every adapter spawn site (incl. the
 * SDK `query({ options: { env } })` path) so agent subprocesses never inherit
 * listen-port vars, the DB path, auth secrets, or plugin-declared credential keys.
 *
 * `TIERWYN_LISTEN_PORT` is intentionally NOT in ALWAYS_SCRUB —
 * preamble curls depend on it — but the `TIERWYN_` vault deny-prefix
 * still block operators from *storing* them as a per-agent secret.
 *
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `PATH` / `HOME` survive unless the name is
 * vault-managed for any agent (then it is deleted for everyone and re-injected only
 * for the matching `agentType`).
 *
 * When `cwd` is set, `PWD` is forced to that directory so CLIs that key session
 * state by `$PWD` (e.g. opencode) see the same directory sandboxed (`bwrap
 * --chdir`) and unsandboxed.
 */

export const ALWAYS_SCRUB = [
  'PORT',
  'HOST',
  // A child that boots its own hub (tests, dev server in a worktree) would otherwise open this
  // server's live DB — dotenv never overrides an inherited var.
  envName('DB'),
  'SESSION_SECRET',
  'OPERATOR_PASSWORD_HASH',
  envName('PLUGIN_VAULT_KEY'),
  'SPAWN_TOKEN',
  'TIERWYN_AA_API_KEY',
] as const;

function isMcpSecretEnv(name: string): boolean {
  return name.startsWith('TIERWYN_MCP_');
}

/** Hub secrets plus `TIERWYN_MCP_*` fallbacks. `*_MCPV_*` placeholders are not scrubbed. */
export function isAlwaysScrubbed(name: string): boolean {
  if ((ALWAYS_SCRUB as readonly string[]).includes(name)) return true;
  return isMcpSecretEnv(name);
}

/** Write the listen port onto an env object. */
export function applyListenPort(env: NodeJS.ProcessEnv, port: number | string): void {
  env.TIERWYN_LISTEN_PORT = String(port);
}

/** Names operators may not store in the per-agent env vault. */
export const AGENT_ENV_DENIED_EXACT: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'PWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_TEMPLATE_DIR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSL_NO_VERIFY',
  'GIT_SSL_CAINFO',
  'LESSOPEN',
  'DOTNET_STARTUP_HOOKS',
  'GOFLAGS',
  'RUSTC_WRAPPER',
  'LUA_INIT',
  'PYTHONUSERBASE',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'ELECTRON_RUN_AS_NODE',
  'PAGER',
  'EDITOR',
  'VISUAL',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
  'RUBYOPT',
  'RUBYLIB',
  'PYTHONHOME',
  'PYTHONWARNINGS',
  'PYTHONBREAKPOINT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  'IFS',
  'GCONV_PATH',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  ...ALWAYS_SCRUB,
]);

export const AGENT_ENV_DENIED_PREFIXES = ['LD_', 'DYLD_', 'TIERWYN_', 'NPM_CONFIG_', 'GIT_CONFIG', 'BASH_FUNC_'] as const;

export const AGENT_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** The vault-managed Copilot token env name, shared by the hub vault loader and the node store. */
export const COPILOT_ENV_NAME = 'COPILOT_GITHUB_TOKEN';

export function isDeniedAgentEnvName(name: string): boolean {
  if (AGENT_ENV_DENIED_EXACT.has(name)) return true;
  const upper = name.toUpperCase();
  return AGENT_ENV_DENIED_PREFIXES.some((p) => upper.startsWith(p.toUpperCase()));
}

export function isValidAgentEnvName(name: string): boolean {
  return AGENT_ENV_NAME_RE.test(name) && !isDeniedAgentEnvName(name);
}

let pluginScrubKeys = new Set<string>();

/** Replace the plugin-declared scrub set. Called synchronously at boot from scanManifests. */
export function setPluginScrubKeys(keys: string[]): void {
  pluginScrubKeys = new Set(keys);
}

export type AgentEnvSlice = { own: Record<string, string>; managedNames: Set<string> };

let agentEnvSource: (agentType: string) => AgentEnvSlice =
  () => ({ own: {}, managedNames: new Set() });

/** Boot seam: vault lookup lives in index.ts so this module stays free of DB imports. */
export function setAgentEnvSource(fn: (agentType: string) => AgentEnvSlice): void {
  agentEnvSource = fn;
}

export function buildChildEnv(
  extra?: NodeJS.ProcessEnv,
  cwd?: string,
  agentType?: string,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ALWAYS_SCRUB) delete base[key];
  for (const key of pluginScrubKeys) delete base[key];
  // MCP secret env fallback (captured + deleted at boot; belt-and-braces). The
  // per-child `*_MCPV_<n>` placeholders arrive via `extra`, after this scrub.
  for (const key of Object.keys(base)) if (isMcpSecretEnv(key)) delete base[key];
  const deny = envPref('CHILD_ENV_DENY') ?? '';
  for (const token of deny.split(',')) {
    const key = token.trim();
    if (key) delete base[key];
  }
  const slice = agentEnvSource(agentType ?? '');
  for (const name of slice.managedNames) delete base[name];
  if (agentType) Object.assign(base, slice.own);
  const env: NodeJS.ProcessEnv = extra ? { ...base, ...extra } : base;
  for (const key of ALWAYS_SCRUB) delete env[key];
  for (const key of pluginScrubKeys) delete env[key];
  for (const key of Object.keys(env)) if (isMcpSecretEnv(key)) delete env[key];
  for (const name of slice.managedNames) delete env[name];
  if (agentType) Object.assign(env, slice.own);
  if (cwd) env.PWD = resolve(cwd);
  return env;
}
