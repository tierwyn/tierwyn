import type { OneShotMode } from './adapter.js';
import type { NormalisedEvent } from './events.js';
import type { McpNativeWriteScope, McpTransport, McpVar } from './mcp.js';
import type { SchedulePackFile } from './packs.js';
import type { AgentProfile } from './profiles.js';
import type { SidecarSite } from './domain.js';
import type { NodeSandboxPathsAllow, NodeSandboxPolicy } from './sandbox.js';

export const NODE_PROTOCOL = 1;
export const NODE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const TUNNEL_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const NODE_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
export const NODE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** Streaming tunnel: wire chunk size and per-stream credit window (bytes). */
export const TUNNEL_STREAM_CHUNK_BYTES = 256 * 1024;
export const TUNNEL_STREAM_WINDOW_BYTES = 1024 * 1024;
/** Streaming tunnel: hard request-body ceiling (same as file upload cap). */
export const TUNNEL_STREAM_MAX_REQ_BYTES = NODE_FILE_MAX_BYTES;
/** Streaming tunnel: abort after this long with no bytes either way. */
export const TUNNEL_STREAM_IDLE_MS = 15 * 60_000;
/** Streaming tunnel: max concurrent streams per host connection. */
export const TUNNEL_STREAM_MAX_PER_HOST = 32;

export type RpcErr = { code: string; message: string };

export type NodeFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'auth'; hostId: string; sig: string }
  | { t: 'hello'; hello: NodeHello }
  | { t: 'req'; id: number; m: string; p?: unknown }
  | { t: 'res'; id: number; ok: true; r?: unknown }
  | { t: 'res'; id: number; ok: false; e: RpcErr }
  | { t: 'ev'; sid: string; seq: number; ev: NormalisedEvent }
  | { t: 'err'; sid: string; seq: number; message: string }
  | { t: 'end'; sid: string; seq: number; reason?: string }
  | { t: 'ctx'; sid: string; contextWindowPct?: number; contextWindowSize?: number; nativeSessionId?: string }
  /** Node → hub: request head. Hub → node: response head. */
  | { t: 'http.head'; rid: number; method?: string; path?: string; status?: number; headers: Record<string, string> }
  /** Body bytes in whichever direction the sender owns. */
  | { t: 'http.chunk'; rid: number; b64: string }
  /** Node → hub: request body complete / aborted. Hub → node: response complete. */
  | { t: 'http.end'; rid: number; error?: string }
  /** Receiver → sender: bytes consumed, window refilled. */
  | { t: 'http.credit'; rid: number; bytes: number };

const FRAME_TYPES = new Set([
  'challenge', 'auth', 'hello', 'req', 'res', 'ev', 'err', 'end', 'ctx',
  'http.head', 'http.chunk', 'http.end', 'http.credit',
]);

export interface NodeAgentInfo {
  installed: boolean;
  methods: string[];
  oneShotModes?: OneShotMode[];
  /** Agent is permitted on this host (node-side allow-list). */
  allowed?: boolean;
  /** The node knows an install command for this agent (`agents.install` can run). */
  installable?: boolean;
  /** Credential-presence heuristic; `undefined` when the probe has no entry. */
  loggedIn?: boolean;
  /** Node-populated by `agents.version`-capable builds: installed CLI version (`<bin> --version`). */
  version?: string;
  /** Hub-decorated (never populated by the node): latest published version from the hub's version cache. */
  latestVersion?: string;
  /** Hub-decorated (never populated by the node): installed version is behind latest. */
  behind?: boolean;
}

/** Capabilities a node build advertises; hubs gate new RPCs on these (old nodes → 501). */
export const NODE_FEATURES = [
  'tunnel.stream',
  'mcp.native',
  'files.write',
  'artifacts.sweep',
  'git.worktree',
  'git.shadow',
  'node.selfUpdate',
  'agents.version',
  'fs.mkdir',
  'fs.move',
  'trust_repo_config',
  'sandbox',
  'sandbox_paths',
  'schedule.packFiles',
  'agent_env',
  'agents.login',
  'agents.login.claude',
  'agents.login.copilot',
  'agents.login.grok',
  'agents.login.cursor',
  'agents.loginStatus',
] as const;
export type NodeFeature = (typeof NODE_FEATURES)[number];

export interface NodeHello {
  protocol: number;
  gitSha: string;
  /** release semver (TIERWYN_VERSION); display only — identity is gitSha, compatibility is protocol */
  version?: string;
  /** Self-reported install source. Absent means git (old nodes). */
  installSource?: 'git' | 'package';
  hostname: string;
  os: string;
  arch: string;
  homedir: string;
  roots: string[];
  listenPort: number;
  artifactsRoot?: string;
  agents: Record<string, NodeAgentInfo>;
  models: Record<string, string[]>;
  sessions: string[];
  features?: NodeFeature[];
  sandbox?: { policy: NodeSandboxPolicy; available: boolean };
  sandboxPaths?: { allow: NodeSandboxPathsAllow };
}

export function hostHasFeature(hello: Pick<NodeHello, 'features'> | undefined, f: NodeFeature): boolean {
  return Array.isArray(hello?.features) && hello.features.includes(f);
}

/** Manual login command + optional vault env for Settings → Remote Hosts chip titles. */
export const AGENT_LOGIN_HINTS: Record<string, { cmd: string; env?: string }> = {
  'grok-build': { cmd: 'grok login', env: 'XAI_API_KEY' },
  cursor: { cmd: 'cursor-agent login', env: 'CURSOR_API_KEY' },
  kimi: { cmd: 'kimi login', env: 'KIMI_API_KEY' },
  copilot: { cmd: 'copilot login', env: 'COPILOT_GITHUB_TOKEN' },
  kiro: { cmd: 'kiro-cli login', env: 'KIRO_API_KEY' },
};

/** Agents the hub can start an interactive remote login for. Feature ids must be in NODE_FEATURES. */
export const REMOTE_LOGIN_AGENTS = {
  codex: { feature: 'agents.login', label: 'Codex', flow: 'device' },
  'claude-code': { feature: 'agents.login.claude', label: 'Claude', flow: 'authorize' },
  copilot: { feature: 'agents.login.copilot', label: 'Copilot', flow: 'device' },
  'grok-build': { feature: 'agents.login.grok', label: 'Grok', flow: 'device' },
  cursor: { feature: 'agents.login.cursor', label: 'Cursor', flow: 'url' },
} as const satisfies Record<string, { feature: NodeFeature; label: string; flow: 'device' | 'authorize' | 'url' }>;

export type RemoteLoginAgent = keyof typeof REMOTE_LOGIN_AGENTS;

export function isRemoteLoginAgent(agentType: string): agentType is RemoteLoginAgent {
  return Object.prototype.hasOwnProperty.call(REMOTE_LOGIN_AGENTS, agentType);
}

export function authPayload(nonce: string, hostId: string, hubOrigin: string): string {
  return `tierwyn-node-auth:v1\n${nonce}\n${hostId}\n${hubOrigin}`;
}

/** Distinct domain from WS authPayload so a package download sig cannot be replayed as auth. */
export function packageAuthPayload(hostId: string, hubOrigin: string, ts: number): string {
  return `tierwyn-node-package:v1\n${hostId}\n${hubOrigin}\n${ts}`;
}

export interface FilesListParams { root: string; path?: string }
export interface FilesReadParams { root: string; path: string; offset?: number; length?: number }
export interface FilesReadResult {
  path: string;      // node realpath of the file
  size: number;
  mtimeMs: number;
  data: string;      // base64 of bytes [offset, offset+length); '' when length is 0/omitted
}

/** Optimistic-concurrency save; `version` must match versionToken(stat) hub-side. */
export interface FilesWriteParams { root: string; path: string; content: string; version: string; workdirRoot?: string }
export type FilesWriteResult =
  | { ok: true; path: string; version: string }
  | { ok: false; code: 'conflict'; currentVersion: string };

export interface ArtifactReadParams {
  conversationId: string;
  path: string;      // absolute path inside the conversation shard
  offset?: number;   // default 0
  length?: number;   // default NODE_FILE_CHUNK_BYTES; clamped to chunk size
}
export interface ArtifactReadResult {
  path: string;      // node realpath of the artifact
  size: number;      // fstat size of the whole file
  sha256?: string;   // hex sha256 of the whole file; only when offset === 0
  data: string;      // base64 of bytes [offset, offset+returned); '' when 0 bytes
}
export interface ArtifactWriteParams {
  conversationId: string;
  name: string;      // basename inside the conversation shard
  uploadId: string;  // fresh per push; part file is `.<uploadId>.part`
  offset: number;    // must equal the part file's current size
  b64: string;       // base64 chunk payload ('' allowed only when final)
  final: boolean;    // true on the last chunk
  size: number;      // total expected size in bytes
  sha256: string;    // hex sha256 of the whole file (checked on final)
}
export type ArtifactWriteResult = { path: string } | { received: number };   // path only on final
export interface ArtifactPurgeParams {
  conversationId: string;
}

export const HUB_TO_NODE_METHODS = [
  'session.create',
  'session.call',
  'session.interrupt',
  'session.resume',
  'adapter.call',
  'fs.statPath',
  'files.list',
  'files.read',
  'files.write',
  'git.call',
  'artifact.read',
  'artifact.write',
  'artifact.purge',
  'ping',
  'node.hello',
  'fs.clone',
  'agents.install',
  'mcp.native.read',
  'mcp.native.write',
  'node.selfUpdate',
  'fs.mkdir',
  'fs.move',
  'schedule.packFiles',
  'agentEnv.sync',
  'agents.login',
  'agents.loginStatus',
] as const;

/**
 * Hub→node: push per-agent vault env values (`env.<agentType>.<NAME>` under
 * `tierwyn:agents`). The hub sends values only for agents the hello marks
 * `allowed`, plus the full list of vault-managed names so the node scrubs
 * same-named `node.env` entries from other agents' children. Values live in
 * node memory only — never on disk, argv, logs, or any response.
 */
export interface AgentEnvSyncParams {
  vars: Record<string, Record<string, string>>;
  managedNames: string[];
}

export interface AgentEnvSyncResult {
  ok: true;
  changed: boolean;
}

/** Hub→node: materialise or unlink schedule pack files under the project root. */
export interface SchedulePackFilesParams {
  op: 'write' | 'unlink';
  root: string;                          // project root on the node
  jobSlug: string;
  files: Array<{ kind: SchedulePackFile['kind']; body: string }>; // body already token-substituted for 'write'; ignored for 'unlink'
  overwrite?: boolean;
}
export type SchedulePackFilesResult =
  | { ok: true; written: string[] }      // rel paths, same as materialisePackFiles
  | { ok: false; code: 'conflict'; conflicts: string[] };

/** Registry-row projection the hub sends with `mcp.native.write` install. */
export interface McpNativeServerRow {
  id: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: McpVar[];
  headers: McpVar[];
  enabled: boolean;
}

export interface McpNativeReadParams { agentType: string; root?: string }

export type McpNativeWriteParams =
  | {
      op: 'install';
      agentType: string;
      scope: McpNativeWriteScope;
      root?: string;
      row: McpNativeServerRow;
      copySecrets?: boolean;
      secretValues: { env: Record<string, string | undefined>; headers: Record<string, string | undefined> };
    }
  | { op: 'remove'; agentType: string; scope: McpNativeWriteScope; root?: string; name: string };

export const GIT_READ_METHODS = [
  'readWorkingTree', 'listBranches', 'listCommits', 'commitDetail',
  'commitFileDiff', 'commitFileContent', 'branchDiff', 'branchFileDiff',
  'stagedDiff', 'stagedDiffStat', 'recentSubjects', 'listGitWorktrees',
  'listNestedGitRepos', 'headRef', 'refExists', 'fileHeadDiff',
] as const;
export type GitReadMethod = typeof GIT_READ_METHODS[number];
export const GIT_MUTATION_METHODS = [
  'stagePath', 'unstagePath', 'commitStaged', 'discardWorktreePath',
  'deleteUntrackedPath', 'stashPush', 'stashPop', 'switchBranch', 'createBranch',
  'fetchRemotes', 'pullFastForward', 'pushRemote', 'restoreFileToHead',
  'addOperatorWorktree', 'createSpawnWorktree',
] as const;
export type GitMutationMethod = typeof GIT_MUTATION_METHODS[number];
export type GitMethod = GitReadMethod | GitMutationMethod | GitShadowMethod;

/**
 * Shadow-checkpoint RPCs; hubs gate them on the `git.shadow` node feature
 * (old nodes → host falls back to codeRef-less checkpoints / 409 responses).
 */
export const GIT_SHADOW_METHODS = [
  'isGitRepo', 'snapshotCode', 'restoreCode', 'deleteShadowRef',
  'resolveShadowRef', 'codeDiff', 'isWorkingTreeClean', 'currentHead',
] as const;
export type GitShadowMethod = typeof GIT_SHADOW_METHODS[number];
export interface GitCallParams { method: GitMethod; cwd: string; args?: unknown[] }
export type GitCallResult =
  | { ok: true; r: unknown }
  | { ok: false; kind: 'git'; stderr: string; stdout: string; exitCode: number | null }
  | { ok: false; kind: 'error'; message: string };

export const NODE_TO_HUB_METHODS = [
  'steer.next',
  'http',
  'hub.features',
  'agents.loginEvent',
] as const;

export const SESSION_CALL_METHODS = [
  'start',
  'sendPrompt',
  'stop',
  'steer',
  'runCommand',
  'respondToInteraction',
  'setPermissionMode',
  'setModelLive',
  'setMcpServersLive',
  'mcpStatus',
  'mcpControl',
  'stopHelper',
  'loadSession',
  'listSessions',
] as const;

export interface FsCloneParams { url: string; root: string }
/** Node realpath of the new checkout. */
export interface FsCloneResult { path: string }

export interface FsMkdirParams { path: string }
export interface FsMkdirResult { path: string; created: boolean }

export interface FsMoveParams { from: string; to: string; dryRun?: boolean }
export interface FsMoveResult { path: string; moved: boolean; repairError?: string }

export interface AgentsInstallParams { agentType: string }
/** `code === null` → killed by timeout; `tail` ≤ 4 KiB of stdout+stderr. */
export interface AgentsInstallResult { code: number | null; tail: string }

export type AgentsLoginOp = 'start' | 'cancel' | 'submit';
export interface AgentsLoginParams { agentType: string; op: AgentsLoginOp; code?: string }
export type AgentsLoginResult = { started: true } | { cancelled: true } | { submitted: true };
/** Cheap fs-only re-probe of credential files. Values are the same as hello `loggedIn`. */
export interface AgentsLoginStatusResult { loggedIn: Record<string, boolean | undefined> };
export type AgentsLoginPhase = 'device' | 'done' | 'error' | 'authorize';
export interface AgentsLoginEvent {
  agentType: string;
  phase: AgentsLoginPhase;
  url?: string;
  userCode?: string;
  message?: string;
}

/** Hub-process-lifetime record of a Codex device-login run on a remote host. */
export interface RemoteHostLoginState {
  agentType: string;
  running: boolean;
  url?: string;
  userCode?: string;
  error?: string;
  codeSubmitted?: boolean;
}

/** Hub-process-lifetime record of an install run on a remote host. */
export interface RemoteHostInstallState {
  agentType: string;
  running: boolean;
  ok?: boolean;
  tail?: string;
  at: number;
}

/**
 * Accepts https://host/…, ssh://…, and scp-form user@host:path. Rejects userinfo on https,
 * leading '-', whitespace/control chars, file://, ext::, local paths, > 2048 chars.
 */
export function isCloneUrlAllowed(url: string): boolean {
  if (typeof url !== 'string') return false;
  if (url.length < 1 || url.length > 2048) return false;
  if (/[\s\x00-\x1f\x7f]/.test(url)) return false;
  if (url.startsWith('-')) return false;
  if (/^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/[^@\\]*$/.test(url)) return true;
  if (/^ssh:\/\/([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/[^\\]+$/.test(url)) return true;
  // scp form: user@host:path — host must be alphanumeric-start; path must start with
  // an alphanumeric/._~ (CVE-2017-1000117-class `-oProxyCommand` options rejected).
  const scp = /^[A-Za-z0-9][A-Za-z0-9._-]*@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9._~][^\\]*)$/;
  const m = scp.exec(url);
  return m !== null && /^[A-Za-z0-9]/.test(m[1]);
}

export const ADAPTER_CALL_METHODS = [
  'listModels',
  'listCommands',
  'isNativeSessionAvailable',
  'rewindNativeSession',
  'exciseNativeTurn',
  'deleteNativeSession',
  'oneShot',
] as const;

export const OPTIONAL_ADAPTER_METHODS = [
  'isNativeSessionAvailable',
  'rewindNativeSession',
  'exciseNativeTurn',
  'deleteNativeSession',
  'estimateTokenCount',
  'listCommands',
  'getLiveContextWindowUsage',
  'runCommand',
  'steer',
  'interruptTurn',
  'mcpStatus',
  'mcpControl',
  'respondToInteraction',
  'setPermissionMode',
  'setModelLive',
  'setMcpServersLive',
  'stopHelper',
  'oneShot',
  'oneShotModes',
] as const;

const TUNNEL_RULES: Array<{ method: RegExp; path: RegExp }> = [
  { method: /^POST$/, path: /^\/spawn$/ },
  { method: /^POST$/, path: /^\/spawn\/raw$/ },
  { method: /^POST$/, path: /^\/spawn\/[^/]+\/(message|stop)$/ },
  { method: /^GET$/, path: /^\/spawn\/[^/]+\/result$/ },
  { method: /^(GET|POST)$/, path: /^\/agent\/.+$/ },
  // MCP uninstalls go hub → node over the tunnel (P2a).
  { method: /^DELETE$/, path: /^\/agent\/mcp\/[^/]+$/ },
  { method: /^POST$/, path: /^\/projects\/[^/]+\/schedules\/agent$/ },
  { method: /^POST$/, path: /^\/conversations\/[^/]+\/timers\/agent$/ },
  { method: /^(GET|POST|PATCH)$/, path: /^\/tasks\/agent(\/[^/]+)?$/ },
  { method: /^(GET|POST|PATCH)$/, path: /^\/conversations\/[^/]+\/tasks\/agent(\/[^/]+)?$/ },
  // Bearer schedule callbacks (schedules/prompt.ts). Task 11 must replay these
  // with http.request and the raw path, never new URL() / fetch().
  { method: /^(GET|PUT|PATCH)$/, path: /^\/schedules\/[^/]+\/steps(\/[^/]+)?$/ },
  { method: /^POST$/, path: /^\/schedules\/[^/]+\/steps\/complete-all$/ },
  { method: /^POST$/, path: /^\/schedules\/[^/]+\/complete-job$/ },
];

export function isTunnelPathAllowed(method: string, rawPath: string): boolean {
  if (/%2f/i.test(rawPath) || /%5c/i.test(rawPath) || rawPath.includes('\\')) return false;
  if (rawPath.includes('//')) return false;
  const noQuery = rawPath.split('?')[0] ?? '';
  // No legitimate agent path uses percent-encoding (ids are UUIDs). Rejecting
  // `%` closes encoded-dot bypasses (`%2e%2e`, `.%2e`) that WHATWG URL would
  // normalise. Task 11 must still replay with http.request(rawPath).
  if (noQuery.includes('%')) return false;
  const segments = noQuery.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return false;
  return TUNNEL_RULES.some((r) => r.method.test(method) && r.path.test(noQuery));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isNodeFrame(value: unknown): value is NodeFrame {
  if (!isPlainObject(value)) return false;
  const t = value.t;
  if (typeof t !== 'string' || !FRAME_TYPES.has(t)) return false;
  switch (t) {
    case 'challenge':
      return typeof value.nonce === 'string';
    case 'auth':
      return typeof value.hostId === 'string' && typeof value.sig === 'string';
    case 'hello':
      return isPlainObject(value.hello);
    case 'req':
      return typeof value.id === 'number' && typeof value.m === 'string';
    case 'res': {
      if (typeof value.id !== 'number' || typeof value.ok !== 'boolean') return false;
      if (value.ok) return true;
      return isPlainObject(value.e)
        && typeof value.e.code === 'string'
        && typeof value.e.message === 'string';
    }
    case 'ev':
      return typeof value.sid === 'string'
        && typeof value.seq === 'number'
        && isPlainObject(value.ev)
        && typeof value.ev.type === 'string';
    case 'err':
      return typeof value.sid === 'string'
        && typeof value.seq === 'number'
        && typeof value.message === 'string';
    case 'end':
      return typeof value.sid === 'string'
        && typeof value.seq === 'number'
        && (value.reason === undefined || typeof value.reason === 'string');
    case 'ctx':
      return typeof value.sid === 'string';
    case 'http.head': {
      if (typeof value.rid !== 'number' || !isPlainObject(value.headers)) return false;
      for (const v of Object.values(value.headers)) {
        if (typeof v !== 'string') return false;
      }
      if (value.method !== undefined && typeof value.method !== 'string') return false;
      if (value.path !== undefined && typeof value.path !== 'string') return false;
      if (value.status !== undefined && typeof value.status !== 'number') return false;
      return true;
    }
    case 'http.chunk':
      return typeof value.rid === 'number' && typeof value.b64 === 'string';
    case 'http.end':
      return typeof value.rid === 'number'
        && (value.error === undefined || typeof value.error === 'string');
    case 'http.credit':
      return typeof value.rid === 'number'
        && typeof value.bytes === 'number'
        && Number.isInteger(value.bytes)
        && value.bytes >= 0;
    default:
      return false;
  }
}

export type RemoteHostState = 'pending' | 'untrusted' | 'connected' | 'disconnected' | 'disabled';

export interface SidecarHostAdvisory {
  site: SidecarSite;
  adapter: string;
  model: string;
  reason: string;
}

export interface RemoteHostView {
  id: string;
  name: string;
  state: RemoteHostState;
  lastError?: string;
  lastSeenAt?: number;
  hello: Partial<NodeHello>;
  fingerprint?: string;
  allowMcpSecrets: boolean;
  description?: string;
  /** Per-host gate for pushing per-agent vault env values via `agentEnv.sync`. */
  allowAgentEnvSecrets: boolean;
  createdAt: number;
  sidecarAdvisories?: SidecarHostAdvisory[];
  /** In-memory, hub process lifetime only. */
  installs?: RemoteHostInstallState[];
  /** In-memory self-update run for this host. */
  update?: { running: boolean; ok?: boolean; fromSha?: string; tail?: string };
  /** Present while a bulk install-all runs against this host. */
  installBatch?: { running: boolean; remaining: string[] };
  /** In-memory per-agent login runs for this host. Never share one agent's url/code/error with another. */
  logins?: RemoteHostLoginState[];
  /** Redeem-time source IP (hub process lifetime). Compare before Trust. */
  enrollIp?: string;
  /** Projects whose `remote_host_id` is this host. Delete 409s until they are unbound. */
  boundProjects?: { id: string; name: string }[];
}

export type ProfileHostUnavailableReason =
  | 'host_disconnected'
  | 'agent_not_installed'
  | 'model_not_on_host'
  | 'agent_not_remote';

export function profileAvailableOnHost(
  profile: Pick<AgentProfile, 'agentType' | 'model'>,
  host: Pick<RemoteHostView, 'state' | 'hello'> | undefined,
): { ok: true } | { ok: false; reason: ProfileHostUnavailableReason } {
  if (profile.agentType === 'grok-bot') return { ok: false, reason: 'agent_not_remote' };
  if (!host || host.state !== 'connected') return { ok: false, reason: 'host_disconnected' };
  if (!host.hello.agents?.[profile.agentType]?.installed) {
    return { ok: false, reason: 'agent_not_installed' };
  }
  const models = host.hello.models?.[profile.agentType];
  if (models && models.length > 0) {
    const want = profile.model.toLowerCase();
    if (!models.some((m) => m.toLowerCase() === want)) {
      return { ok: false, reason: 'model_not_on_host' };
    }
  }
  return { ok: true };
}
