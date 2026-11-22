import { spawn, type ChildProcess } from 'child_process';
import type {
  AgentAdapter,
  ArtifactPurgeParams,
  ArtifactReadParams,
  ArtifactReadResult,
  ArtifactWriteParams,
  ArtifactWriteResult,
  Attachment,
  AgentsInstallParams,
  AgentsInstallResult,
  AgentsLoginEvent,
  AgentsLoginParams,
  AgentsLoginResult,
  FilesListParams,
  FilesReadParams,
  FilesReadResult,
  FilesWriteParams,
  FilesWriteResult,
  McpNativeReadParams,
  McpNativeWriteParams,
  NodeFrame,
  NodeHello,
  FsCloneParams,
  FsMkdirParams,
  FsMoveParams,
  OneShotOpts,
  ResolvedMcpServer,
  SchedulePackFilesParams,
  SchedulePackFilesResult,
  SessionConfig,
} from '@tierwyn/shared';
import {
  ADAPTER_CALL_METHODS,
  FILE_KINDS,
  HUB_TO_NODE_METHODS,
  isOpenableExtension,
  isSecretPath,
  NODE_FILE_CHUNK_BYTES,
  NODE_FILE_MAX_BYTES,
  PACK_SLUG_RE,
  SESSION_CALL_METHODS,
} from '@tierwyn/shared';
import {
  materialisePackFiles,
  unlinkPackFiles,
  PackFileConflict,
  PackFilePathError,
} from '../schedules/packFiles.js';
import type { AdapterFactoryOpts } from '../registry.js';
import { writeTempAttachments, type TempFile } from '../imageHelper.js';
import { isGitRepo } from '../worktree.js';
import { listUnderRoot } from '../files/listing.js';
import { isWritePathAllowed, versionToken } from '../files/writePolicy.js';
import { isMcpKeyHeader } from './brandHeaders.js';
import { applyNodeSandboxPolicy, pathUnderRoots, type NodeConfig } from './policy.js';
import { applyNodeSandboxPaths, nodeHardDenyPaths } from './sandboxPaths.js';
import { type CustomPathCtx } from '../sandbox/customPaths.js';
import { hasSandboxProfile } from '../sandbox/profiles.js';
import { bwrapAvailable } from '../sandbox/bwrap.js';
import { fsClone, fsMkdir } from './clone.js';
import { fsMove } from './move.js';
import { encodeFrame, RpcError, type RpcHandler, type RpcPeer } from './rpc.js';
import { artifactPurge, artifactRead, artifactWrite } from './artifactStore.js';
import { gitCall } from './gitCall.js';
import { fileURLToPath } from 'url';
import { accessSync, constants as FS, existsSync, statSync, type Stats } from 'fs';
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from 'fs/promises';
import { randomBytes } from 'crypto';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { O_NONBLOCK, O_RDONLY, X_OK } from 'node:constants';
import { AGENT_BINARIES, binaryOnPath } from '../discovery.js';
import { probeAllLogins } from './loginProbe.js';
import { runInstall } from './install.js';
import { AgentEnvStore } from './agentEnvStore.js';
import { isLoginAgent, LoginRunner } from './loginRunner.js';
// DB-free helpers: mcp/native.ts only type-imports the registry row shape, and
// McpServerRow below is a type-only import (erased) — the isolation guard passes.
import { installNativeMcp, NativeWriteError, readNativeMcp, removeNativeMcp } from '../mcp/native.js';
import type { McpServerRow } from '../mcp/registry.js';

export { defaultSpawnLogin } from './loginRunner.js';

export interface NodeRuntimeDeps {
  create(type: string, opts?: AdapterFactoryOpts): AgentAdapter;
  has(type: string): boolean;
  policy: Pick<NodeConfig, 'roots' | 'allowedAgents' | 'maxSessions' | 'sandbox' | 'sandboxPaths'> & {
    allowSelfUpdate?: boolean;
    keyPath?: string;
  };
  sandboxAvailable?: () => boolean;
  artifactsRoot?: string;
  /** Node config directory (`TIERWYN_NODE_DIR`); extra hard-deny when set. */
  nodeDir?: string;
  /** Home dir used for native-MCP config files; test seam (default: real homedir). */
  nativeHome?: string;
  graceMs?: number;
  bufferMax?: { events: number; bytes: number };
  now?: () => number;
  /** Fresh hello builder (agent probes are expensive; injected by main.ts). Absent on old builds → no_method. */
  buildHello?: () => Promise<NodeHello>;
  /** Test seam for agents.install. */
  runInstall?: (cmd: string, opts?: { prereqs?: readonly string[] }) => Promise<AgentsInstallResult>;
  /** Checkout the updater runs in; defaults to the repo root above this file. */
  repoRoot?: string;
  /** Test seam for node.selfUpdate (avoids a real systemd-run). */
  spawnUpdate?: (argv: string[]) => void;
  /** Test seam for agents.login (avoids a real `codex login` / `claude auth login`). */
  spawnLogin?: (argv: string[], agentType: string) => ChildProcess;
  /** Hub-pushed vault env store (memory-only); wired by main.ts. Absent → agentEnv.sync answers no_method. */
  agentEnv?: AgentEnvStore;
}

/**
 * Open `real` read-only, confined to `jail` roots, closing on any failure.
 * Re-jails via /proc/self/fd (dev/ino fallback) to defeat post-realpath swaps,
 * and refuses non-regular files. Caller picks the RpcError codes.
 */
export async function openConfined(
  real: string,
  jail: string[],
  label: string,
  codes: { outside: string; notAllowed?: string } = { outside: 'outside_shard' },
): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(real, O_RDONLY | O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (codes.notAllowed && (code === 'EACCES' || code === 'EPERM')) throw new RpcError(codes.notAllowed, label);
    throw new RpcError('not_found', label);
  }
  try {
    let openedReal: string | null = null;
    try {
      openedReal = await realpath(join('/proc/self/fd', String(fh.fd)));
    } catch {
      /* non-Linux */
    }
    if (openedReal !== null) {
      if (!pathUnderRoots(openedReal, jail)) throw new RpcError(codes.outside, label);
    } else {
      const before = await stat(real).catch(() => null);
      const fst = await fh.stat();
      if (!before || before.dev !== fst.dev || before.ino !== fst.ino) {
        throw new RpcError(codes.outside, label);
      }
    }
    const fst = await fh.stat();
    if (!fst.isFile()) throw new RpcError('not_found', label);
    return fh;
  } catch (err) {
    try {
      await fh.close();
    } catch {
      /* already closed */
    }
    throw err;
  }
}

interface Sess {
  sid: string;
  adapter: AgentAdapter;
  seq: number;
  buffer: Array<Extract<NodeFrame, { sid: string; seq: number }>>;
  bufferBytes: number;
  secrets: string[];
  temps: TempFile[];
  grace?: ReturnType<typeof setTimeout>;
  lastCtx?: string;
  paused: boolean;
  dead: boolean;
  mcpSkipped?: McpPreflightSkip[];
  agentType: string;
}

type StartWire = SessionConfig & { hasSteerSource?: boolean };

export interface McpPreflightSkip {
  id: string;
  reason: 'command_not_found_on_host' | 'cwd_outside_roots';
}

/**
 * Node-side stdio sanity check before a session starts: the hub resolves MCP
 * rows without knowing what exists on this host. Non-stdio servers pass through
 * (http/sse are dialled lazily; hub-placed ones never run here).
 */
export function preflightMcp(
  servers: ResolvedMcpServer[] | undefined,
  roots: string[],
): { kept: ResolvedMcpServer[] | undefined; skipped: McpPreflightSkip[] } {
  if (!servers) return { kept: servers, skipped: [] };
  const kept: ResolvedMcpServer[] = [];
  const skipped: McpPreflightSkip[] = [];
  for (const s of servers) {
    if (s.transport !== 'stdio') { kept.push(s); continue; }
    if (s.command) {
      if (isAbsolute(s.command)) {
        try {
          accessSync(s.command, X_OK);
        } catch {
          skipped.push({ id: s.id, reason: 'command_not_found_on_host' });
          continue;
        }
      } else if (!Object.keys(s.env).some((k) => k.toUpperCase() === 'PATH')) {
        // An explicit env PATH means the child resolves on its own PATH; we can't know it.
        if (!binaryOnPath(s.command)) {
          skipped.push({ id: s.id, reason: 'command_not_found_on_host' });
          continue;
        }
      }
    }
    if (s.cwd && !pathUnderRoots(s.cwd, roots)) {
      skipped.push({ id: s.id, reason: 'cwd_outside_roots' });
      continue;
    }
    kept.push(s);
  }
  return { kept, skipped };
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function defaultSpawnUpdate(argv: string[]): void {
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.warn('[node.selfUpdate] spawn failed:', err.message));
  child.unref();
}

export class NodeRuntime {
  private peer: RpcPeer | undefined;
  private readonly sessions = new Map<string, Sess>();
  private readonly tombstones = new Map<string, Sess>();
  private readonly installs = new Set<string>();
  private readonly loginRunner: LoginRunner;
  private emitLoginEvent?: (ev: AgentsLoginEvent) => void;
  private updating = false;
  private updatingAt = 0;
  private static readonly UPDATE_BUSY_MS = 15 * 60_000;
  private readonly graceMs: number;
  private readonly bufferMax: { events: number; bytes: number };
  private readonly now: () => number;

  constructor(private readonly deps: NodeRuntimeDeps) {
    this.graceMs = deps.graceMs ?? 120_000;
    this.bufferMax = deps.bufferMax ?? { events: 10_000, bytes: 8 * 1024 * 1024 };
    this.now = deps.now ?? Date.now;
    this.loginRunner = new LoginRunner({
      emit: (ev) => this.emitLoginEvent?.(ev),
      spawn: this.deps.spawnLogin,
    });
  }

  setLoginEmitter(fn: (ev: AgentsLoginEvent) => void): void {
    this.emitLoginEvent = fn;
  }

  handlers(): Record<string, RpcHandler> {
    const h: Record<string, RpcHandler> = {
      'session.create': (p) => this.sessionCreate(p),
      'session.call': (p) => this.sessionCall(p),
      'session.interrupt': (p) => this.sessionInterrupt(p),
      'session.resume': (p) => this.sessionResume(p),
      'adapter.call': (p) => this.adapterCall(p),
      'fs.statPath': (p) => this.fsStatPath(p),
      'files.list': (p) => this.filesList(p),
      'files.read': (p) => this.filesRead(p),
      'files.write': (p) => this.filesWrite(p),
      'mcp.native.read': async (p) => this.nativeRead(p),
      'mcp.native.write': (p) => this.nativeWrite(p),
      'git.call': (p) => gitCall(this.deps.policy.roots, p),
      'artifact.read': (p) => {
        const root = this.deps.artifactsRoot;
        if (!root) throw new RpcError('no_method', 'artifact.read');
        return artifactRead(root, p as ArtifactReadParams);
      },
      'artifact.write': (p) => {
        const root = this.deps.artifactsRoot;
        if (!root) throw new RpcError('no_method', 'artifact.write');
        return artifactWrite(root, p as ArtifactWriteParams);
      },
      'artifact.purge': (p) => {
        const root = this.deps.artifactsRoot;
        if (!root) throw new RpcError('no_method', 'artifact.purge');
        return artifactPurge(root, p as ArtifactPurgeParams);
      },
      ping: async () => ({ ok: true }),
      // P2c: hub Refresh re-fetches a fresh hello over the live link. Probes are
      // expensive (binary lookups + listModels), so the builder is injected.
      'node.hello': async () => {
        if (!this.deps.buildHello) throw new RpcError('no_method', 'node.hello');
        const hello = await this.deps.buildHello();
        hello.sessions = this.sessionIds();
        return hello;
      },
      'fs.clone': (p) => fsClone(this.deps.policy.roots, p as FsCloneParams),
      'fs.mkdir': async (p) => fsMkdir(this.deps.policy.roots, p as FsMkdirParams),
      'fs.move': async (p) => fsMove(this.deps.policy.roots, p as FsMoveParams),
      'agents.login': (p) => Promise.resolve(this.agentsLogin(p)),
      'agents.loginStatus': async () => ({ loggedIn: probeAllLogins() }),
      'agents.install': async (p) => {
        const { agentType } = (p ?? {}) as AgentsInstallParams;
        this.assertAgentAllowed(agentType);
        // The command is always our own fixed entry — never anything the hub sends.
        const known = AGENT_BINARIES[agentType];
        const cmd = known?.install;
        if (!cmd) throw new RpcError('not_installable', agentType);
        if ([...this.sessions.values()].some((s) => s.agentType === agentType)) {
          throw new RpcError('agent_busy', agentType);
        }
        if (this.installs.has(agentType)) throw new RpcError('busy', 'install already running');
        this.installs.add(agentType);
        try {
          const opts = known?.prereqs?.length ? { prereqs: known.prereqs } : undefined;
          return await (this.deps.runInstall
            ? (opts ? this.deps.runInstall(cmd, opts) : this.deps.runInstall(cmd))
            : runInstall(cmd, opts));
        } finally {
          this.installs.delete(agentType);
        }
      },
      'node.selfUpdate': () => this.selfUpdate(),
      'schedule.packFiles': async (p) => this.schedulePackFiles(p),
      'agentEnv.sync': async (p) => this.agentEnvSync(p),
    };
    for (const m of HUB_TO_NODE_METHODS) {
      if (!h[m]) h[m] = async () => { throw new RpcError('no_method', m); };
    }
    return h;
  }

  attach(peer: RpcPeer): void {
    this.peer = peer;
    // Only the MCP bridge header is exempt from redaction on tunnel http frames
    // (buffered `req http` and streaming `http.head`) — the hub route validates
    // it. Bodies and every other string in the frame stay redacted, so an agent
    // cannot smuggle an MCP secret into the hub through any other channel.
    peer.redact = (f) => {
      const secrets = this.allSecrets();
      if (secrets.length === 0) return redactFrame(f, secrets);
      const mcpKeys = (headers: Record<string, string> | undefined): [string, string][] =>
        Object.entries(headers ?? {}).filter(([k]) => isMcpKeyHeader(k));
      if (f.t === 'req' && f.m === 'http') {
        const keys = mcpKeys((f.p as { headers?: Record<string, string> }).headers);
        const out = redactFrame(f, secrets) as typeof f;
        const restored = (out.p as { headers?: Record<string, string> }).headers;
        if (restored) for (const [k, v] of keys) restored[k] = v;
        return out;
      }
      if (f.t === 'http.head') {
        const keys = mcpKeys(f.headers);
        const out = redactFrame(f, secrets) as Extract<NodeFrame, { t: 'http.head' }>;
        for (const [k, v] of keys) out.headers[k] = v;
        return out;
      }
      return redactFrame(f, secrets);
    };
    for (const s of this.sessions.values()) {
      if (s.grace) clearTimeout(s.grace);
      s.grace = setTimeout(() => { void this.dropSession(s.sid); }, this.graceMs);
      s.paused = true;
    }
  }

  detach(): void {
    this.peer = undefined;
    for (const s of this.sessions.values()) {
      if (s.grace) clearTimeout(s.grace);
      s.grace = setTimeout(() => { void this.dropSession(s.sid); }, this.graceMs);
    }
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  private async selfUpdate(): Promise<{ started: true; fromSha: string }> {
    if (this.deps.policy.allowSelfUpdate === false) {
      throw new RpcError('disabled', 'self-update disabled');
    }
    if (this.sessions.size > 0) throw new RpcError('sessions_live', 'host has live sessions');
    const repoRoot = this.deps.repoRoot ?? defaultRepoRoot();
    if (!existsSync(join(repoRoot, '.git')) && !existsSync(join(repoRoot, 'BUILD_ID'))) {
      throw new RpcError('not_git_checkout', 'not a git checkout');
    }
    if (!this.deps.spawnUpdate && !binaryOnPath('systemd-run')) {
      throw new RpcError('no_systemd', 'systemd-run not on PATH');
    }
    if (this.updating && this.now() - this.updatingAt < NodeRuntime.UPDATE_BUSY_MS) {
      throw new RpcError('busy', 'update already running');
    }
    let fromSha = 'unknown';
    if (this.deps.buildHello) {
      fromSha = (await this.deps.buildHello()).gitSha || fromSha;
    }
    const argv = [
      'systemd-run', '--user', '--collect', '--quiet',
      `--unit=tierwyn-node-update-${this.now()}`,
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      `--setenv=HOME=${process.env.HOME ?? ''}`,
      '--', 'bash', join(repoRoot, 'scripts/install.sh'), 'node', 'update',
    ];
    this.updating = true;
    this.updatingAt = this.now();
    try {
      (this.deps.spawnUpdate ?? defaultSpawnUpdate)(argv);
    } catch (err) {
      this.updating = false;
      this.updatingAt = 0;
      throw err;
    }
    return { started: true, fromSha };
  }

  private async sessionCreate(p: unknown): Promise<unknown> {
    const { sid, agentType, factoryOpts } = p as {
      sid: string; agentType: string; factoryOpts?: AdapterFactoryOpts;
    };
    this.assertAgentAllowed(agentType);
    if (this.sessions.size >= this.deps.policy.maxSessions) {
      throw new RpcError('max_sessions', 'max sessions reached');
    }
    if (this.sessions.has(sid)) {
      throw new RpcError('session_exists', sid);
    }
    if (this.tombstones.has(sid)) this.dropTombstone(sid);
    const avail = this.deps.sandboxAvailable ?? bwrapAvailable;
    const sandbox = applyNodeSandboxPolicy(
      factoryOpts?.sandbox === true,
      this.deps.policy.sandbox ?? 'allow',
      avail(),
    );
    if (sandbox && !hasSandboxProfile(agentType)) {
      throw new RpcError('sandbox_unsupported_agent', 'sandbox_unsupported_agent');
    }
    const home = this.deps.nativeHome ?? homedir();
    const roots = this.deps.policy.roots;
    const extraDeny = nodeHardDenyPaths({
      nodeDir: this.deps.nodeDir,
      keyPath: this.deps.policy.keyPath,
      artifactsRoot: this.deps.artifactsRoot,
    });
    const pathCtx: CustomPathCtx = {
      home,
      cwd: roots[0] ?? home,
      repoRoot: this.deps.repoRoot ?? defaultRepoRoot(),
      agentType,
      roots,
      pathEnv: process.env.PATH,
      ...(extraDeny.length ? { extraDeny } : {}),
    };
    const sandboxPaths = applyNodeSandboxPaths(
      factoryOpts?.sandboxPaths,
      this.deps.policy.sandboxPaths?.allow ?? 'ro',
      pathCtx,
    );
    const adapter = this.deps.create(agentType, {
      ...factoryOpts,
      sandbox,
      sandboxPaths,
      sandboxRoots: roots,
      sandboxDeny: extraDeny.length ? extraDeny : undefined,
    });
    const sess: Sess = {
      sid,
      adapter,
      seq: 0,
      buffer: [],
      bufferBytes: 0,
      secrets: [],
      temps: [],
      paused: false,
      dead: false,
      agentType,
    };
    this.wire(sess);
    this.sessions.set(sid, sess);
    return { ok: true };
  }

  private wire(sess: Sess): void {
    const em = sess.adapter.streamEvents();
    em.on('event', (ev) => {
      this.push(sess, { t: 'ev', sid: sess.sid, seq: ++sess.seq, ev });
      this.maybeCtx(sess);
    });
    em.on('error', (err: Error) => {
      this.push(sess, {
        t: 'err',
        sid: sess.sid,
        seq: ++sess.seq,
        message: err instanceof Error ? err.message : String(err),
      });
      this.maybeCtx(sess);
    });
    em.on('end', () => {
      if (sess.dead) return;
      this.maybeCtx(sess);
      this.push(sess, { t: 'end', sid: sess.sid, seq: ++sess.seq });
      this.release(sess, true);
    });
  }

  private maybeCtx(sess: Sess): void {
    const usage = sess.adapter.getLiveContextWindowUsage?.();
    const native = (sess.adapter as unknown as { nativeSessionId?: string }).nativeSessionId;
    if (!usage && !native) return;
    const key = JSON.stringify({ usage, native });
    if (key === sess.lastCtx) return;
    sess.lastCtx = key;
    this.sendOut(sess, {
      t: 'ctx',
      sid: sess.sid,
      ...(usage?.contextWindowPct !== undefined ? { contextWindowPct: usage.contextWindowPct } : {}),
      ...(usage?.contextWindowSize !== undefined ? { contextWindowSize: usage.contextWindowSize } : {}),
      ...(native ? { nativeSessionId: native } : {}),
    }, false);
  }

  private async sessionCall(p: unknown): Promise<unknown> {
    const { sid, method, args = [] } = p as { sid: string; method: string; args?: unknown[] };
    const sess = this.requireSession(sid);
    if (!(SESSION_CALL_METHODS as readonly string[]).includes(method)) {
      throw new RpcError('no_method', method);
    }
    const adapter = sess.adapter as unknown as Record<string, unknown>;
    const fn = adapter[method];
    if (typeof fn !== 'function') throw new RpcError('no_method', method);

    let callArgs = coerceArgs(args);
    try {
      if (method === 'start') {
        callArgs = [this.prepareStart(sess, callArgs[0] as StartWire)];
      } else if (method === 'sendPrompt' || method === 'steer') {
        callArgs = this.materialiseArgs(sess, callArgs);
      } else if (method === 'setMcpServersLive') {
        const pre = preflightMcp(callArgs[0] as ResolvedMcpServer[] | undefined, this.deps.policy.roots);
        callArgs = [pre.kept];
        sess.secrets.push(...collectSecrets(pre.kept));
      }
      const result = await (fn as (...a: unknown[]) => unknown).apply(sess.adapter, callArgs);
      this.maybeCtx(sess);
      if (method === 'stop') this.release(sess, false);
      if (method === 'start' && sess.mcpSkipped?.length) {
        return { mcpSkipped: sess.mcpSkipped, ...(typeof result === 'object' && result !== null ? result : {}) };
      }
      return result;
    } catch (err) {
      if (method === 'start') {
        // Redact before release: throwing from this async fn rejects as a
        // microtask, and a queued release would empty allSecrets() before
        // handleReq sends the error res.
        if (err instanceof Error) {
          const secrets = this.allSecrets();
          if (secrets.length) err.message = redactString(err.message, sortedSecrets(secrets));
        }
        this.release(sess, false);
      }
      throw err;
    }
  }

  private prepareStart(sess: Sess, wire: StartWire): SessionConfig {
    const real = pathUnderRoots(wire.cwd, this.deps.policy.roots);
    if (!real) throw new RpcError('cwd_outside_roots', wire.cwd);
    const pre = preflightMcp(wire.mcpServers, this.deps.policy.roots);
    sess.mcpSkipped = pre.skipped;
    const config: SessionConfig = { ...wire, cwd: real, mcpServers: pre.kept };
    delete (config as StartWire).hasSteerSource;
    if (wire.hasSteerSource) {
      config.getNextSteer = async () => {
        if (!this.peer) return null;
        // timeoutMs 0: park with no timer. Hub pullNextSteer parks indefinitely.
        const got = await this.peer.request<{
          text: string; attachments?: Attachment[];
        } | null>('steer.next', { sid: sess.sid }, 0);
        if (!got) return null;
        if (!got.attachments?.length) return got;
        const materialised = this.materialiseArgs(sess, ['', got.attachments]);
        return { ...got, attachments: materialised[1] as Attachment[] };
      };
    }
    sess.secrets = collectSecrets(pre.kept);
    return config;
  }

  private materialiseArgs(sess: Sess, args: unknown[]): unknown[] {
    const out = args.slice();
    const attachments = out[1] as Attachment[] | undefined;
    if (!Array.isArray(attachments)) return out;
    out[1] = attachments.map((a) => {
      const [tf] = writeTempAttachments([{ base64: a.base64, mediaType: a.mediaType }]);
      sess.temps.push(tf);
      return { ...a, tempPath: tf.path };
    });
    return out;
  }

  private async sessionInterrupt(p: unknown): Promise<unknown> {
    const { sid } = p as { sid: string };
    const sess = this.sessions.get(sid);
    sess?.adapter.interruptTurn?.();
    return { ok: true };
  }

  private async sessionResume(p: unknown): Promise<unknown> {
    const { sid, lastSeq } = p as { sid: string; lastSeq: number };
    const sess = this.sessions.get(sid) ?? this.tombstones.get(sid);
    if (!sess) throw new RpcError('unknown_session', sid);
    const oldest = sess.buffer[0];
    if (oldest && oldest.seq > lastSeq + 1) {
      throw new RpcError('gap', `oldest seq ${oldest.seq} > ${lastSeq + 1}`);
    }
    const replay = sess.buffer.filter((f) => f.seq > lastSeq);
    for (const f of replay) this.sendOut(sess, f, false, true);
    if (!sess.dead && sess.grace) {
      clearTimeout(sess.grace);
      sess.grace = undefined;
    }
    sess.paused = false;
    return { replayed: replay.length };
  }

  private async adapterCall(p: unknown): Promise<unknown> {
    const { agentType, method, args = [] } = p as {
      agentType: string; method: string; args?: unknown[];
    };
    this.assertAgentAllowed(agentType);
    if (!(ADAPTER_CALL_METHODS as readonly string[]).includes(method)) {
      throw new RpcError('no_method', method);
    }
    const avail = this.deps.sandboxAvailable ?? bwrapAvailable;
    const policy = this.deps.policy.sandbox ?? 'allow';
    let adapter = this.deps.create(agentType);
    if (method === 'oneShot' && policy === 'require') {
      const sandbox = applyNodeSandboxPolicy(false, policy, avail());
      if (sandbox && !hasSandboxProfile(agentType)) {
        throw new RpcError('sandbox_unsupported_agent', 'sandbox_unsupported_agent');
      }
      adapter = this.deps.create(agentType, { sandbox });
    }
    const fn = (adapter as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') throw new RpcError('no_method', method);
    try {
      let callArgs = args;
      if (method === 'oneShot') {
        const o = args[1] as OneShotOpts | undefined;
        if (o?.cwd) {
          const real = pathUnderRoots(o.cwd, this.deps.policy.roots);
          if (!real) throw new RpcError('path_outside_roots', o.cwd);
          callArgs = [args[0], { ...o, cwd: real }];
        }
      }
      return await (fn as (...a: unknown[]) => unknown).apply(adapter, coerceArgs(callArgs));
    } finally {
      try { await adapter.stop(); } catch { /* throwaway */ }
    }
  }

  private async filesList(p: unknown): Promise<unknown> {
    const { root, path } = p as FilesListParams;
    // Advertised but missing root: realpath fails inside pathUnderRoots and
    // used to look like "outside" → hub 403. Prefer a clear 404 for browse.
    if (typeof root === 'string' && this.deps.policy.roots.includes(root) && !existsSync(root)) {
      return { status: 404, body: { error: 'root not found' } };
    }
    const real = pathUnderRoots(root, this.deps.policy.roots);
    if (!real) throw new RpcError('path_outside_roots', root);
    return listUnderRoot(real, path);
  }

  /** Native-MCP roots must stay inside the node's allow-list (same as files.*). */
  private nativeRoot(root: unknown): string | undefined {
    if (root === undefined) return undefined;
    if (typeof root !== 'string' || root === '' || root.includes('\0')) {
      throw new RpcError('bad_request', 'root must be a non-empty string');
    }
    if (!pathUnderRoots(root, this.deps.policy.roots)) throw new RpcError('path_outside_roots', root);
    return root;
  }

  private nativeRead(p: unknown): unknown {
    const req = (p ?? {}) as McpNativeReadParams;
    if (typeof req.agentType !== 'string' || !req.agentType) throw new RpcError('bad_request', 'agentType required');
    const root = this.nativeRoot(req.root);
    return readNativeMcp(req.agentType, root, { home: this.deps.nativeHome });
  }

  private async nativeWrite(p: unknown): Promise<unknown> {
    const req = p as McpNativeWriteParams;
    if (!req || (req.op !== 'install' && req.op !== 'remove')) throw new RpcError('bad_request', 'op must be install or remove');
    const root = this.nativeRoot(req.root);
    const opts = { scope: req.scope, root, home: this.deps.nativeHome };
    try {
      if (req.op === 'install') {
        if (!req.row || typeof req.row !== 'object') throw new RpcError('bad_request', 'row required');
        return await installNativeMcp(req.agentType, req.row as unknown as McpServerRow, {
          env: req.secretValues?.env ?? {},
          headers: req.secretValues?.headers ?? {},
        }, { ...opts, copySecrets: req.copySecrets === true });
      }
      return await removeNativeMcp(req.agentType, req.name, opts);
    } catch (err) {
      // NativeWriteError status crosses the wire as `native_<status>` so the hub
      // can rebuild the HTTP status for the browser.
      if (err instanceof NativeWriteError) throw new RpcError(`native_${err.status}`, err.message);
      throw err;
    }
  }

  private async filesRead(p: unknown): Promise<FilesReadResult> {
    const req = p as FilesReadParams;
    const { root, path } = req;
    if (typeof path !== 'string' || !path || path.includes('\0')) {
      throw new RpcError('bad_path', 'path');
    }
    const realRoot = pathUnderRoots(root, this.deps.policy.roots);
    if (!realRoot) throw new RpcError('path_outside_roots', root);
    const requested = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    const target = isAbsolute(requested) ? requested : resolve(realRoot, requested);
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new RpcError('not_found', path);
    }
    const jail = this.readJailRoots();
    if (!pathUnderRoots(real, jail)) throw new RpcError('path_outside_roots', path);
    const inArtifacts = this.deps.artifactsRoot
      ? pathUnderRoots(real, [this.deps.artifactsRoot]) !== null
      : false;
    if (isSecretPath(real) || isSecretPath(path) || real.split(sep).includes('.git')) {
      throw new RpcError('path_not_allowed', path);
    }
    const fh = await openConfined(real, jail, path, {
      outside: 'path_outside_roots',
      notAllowed: 'path_not_allowed',
    });
    try {
      const fst = await fh.stat();
      if (!inArtifacts && !isOpenableExtension(extname(real).slice(1).toLowerCase())) {
        throw new RpcError('path_not_allowed', path);
      }
      if (fst.size > NODE_FILE_MAX_BYTES) throw new RpcError('too_large', 'file too large');
      const offset = req.offset;
      const length = req.length;
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
        throw new RpcError('bad_path', 'offset');
      }
      if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
        throw new RpcError('bad_path', 'length');
      }
      const off = offset ?? 0;
      if (off > fst.size) throw new RpcError('bad_path', 'offset');
      if (length !== undefined && length > NODE_FILE_CHUNK_BYTES) throw new RpcError('bad_path', 'length');
      const want = length === undefined ? 0 : Math.min(length, fst.size - off);
      let data = '';
      if (want > 0) {
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, off);
        data = buf.subarray(0, bytesRead).toString('base64');
      }
      return { path: real, size: fst.size, mtimeMs: fst.mtimeMs, data };
    } finally {
      try { await fh.close(); } catch { /* already closed */ }
    }
  }

  private readJailRoots(): string[] {
    const roots = [...this.deps.policy.roots];
    if (this.deps.artifactsRoot) roots.push(this.deps.artifactsRoot);
    return roots;
  }

  /** Optimistic-concurrency save; mirrors the hub's local PUT /files policy. */
  private async filesWrite(p: unknown): Promise<FilesWriteResult> {
    const req = p as FilesWriteParams;
    const { root, path, content, version, workdirRoot } = req;
    if (typeof path !== 'string' || !path || path.includes('\0')) {
      throw new RpcError('bad_path', 'path');
    }
    if (typeof content !== 'string') throw new RpcError('bad_request', 'content');
    if (typeof version !== 'string' || !version) throw new RpcError('bad_request', 'version');
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
      throw new RpcError('too_large', 'file too large');
    }
    const realRoot = pathUnderRoots(root, this.deps.policy.roots);
    if (!realRoot) throw new RpcError('path_outside_roots', root);
    let realWorkdirRoot: string | undefined;
    if (workdirRoot !== undefined) {
      const rw = pathUnderRoots(workdirRoot, this.deps.policy.roots);
      if (!rw) throw new RpcError('path_outside_roots', workdirRoot);
      realWorkdirRoot = rw;
    }
    const requested = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    const candidate = isAbsolute(requested) ? requested : resolve(realWorkdirRoot ?? realRoot, requested);
    const allowOpts = { projectRoots: [realRoot], workdirRoot: realWorkdirRoot };
    if (!isWritePathAllowed(candidate, allowOpts)) {
      throw new RpcError('not_allowed', path);
    }
    let st: Stats;
    try {
      st = await stat(candidate);
    } catch {
      throw new RpcError('not_found', path);
    }
    if (!st.isFile()) throw new RpcError('not_found', path);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new RpcError('not_found', path);
    }
    // The lexical pass used the pre-realpath path; re-check the resolved path
    // so a symlink inside the root pointing outside can't slip through.
    if (!pathUnderRoots(real, this.deps.policy.roots)
      || !isWritePathAllowed(real, allowOpts)) {
      throw new RpcError('not_allowed', path);
    }
    if (versionToken(st) !== version) {
      return { ok: false, code: 'conflict', currentVersion: versionToken(st) };
    }

    // Atomic save: tmp file in the target's directory (same filesystem),
    // original mode preserved, rename over the target.
    const tmp = join(dirname(real), `.tierwyn-save-${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, st.mode & 0o777);
      try { await fh.writeFile(content); } finally { await fh.close(); }
      if (await realpath(dirname(real)) !== dirname(real)) {
        await unlink(tmp).catch(() => {});
        throw new RpcError('not_allowed', path);
      }
      const pre = await lstat(real).catch(() => null);
      if (pre && (pre.isSymbolicLink() || pre.ino !== st.ino)) {
        await unlink(tmp).catch(() => {});
        return { ok: false, code: 'conflict', currentVersion: pre ? versionToken(pre) : '' };
      }
      await rename(tmp, real);
    } catch (e) {
      try { await unlink(tmp); } catch { /* best effort */ }
      throw e;
    }
    try {
      const post = await realpath(real);
      if (!pathUnderRoots(post, this.deps.policy.roots)) {
        console.error('[node.files.write] post-write escape detected', real);
      }
    } catch { /* ignore */ }
    const fresh = await stat(real);
    return { ok: true, path: real, version: versionToken(fresh) };
  }

  private async fsStatPath(p: unknown): Promise<unknown> {
    const { path } = p as { path: string };
    const underRoots = pathUnderRoots(path, this.deps.policy.roots) !== null;
    if (!existsSync(path)) {
      return { exists: false, isDir: false, isGitRepo: false, underRoots };
    }
    try {
      const st = statSync(path);
      return {
        exists: true,
        isDir: st.isDirectory(),
        isGitRepo: isGitRepo(path),
        underRoots,
      };
    } catch {
      return { exists: false, isDir: false, isGitRepo: false, underRoots };
    }
  }

  private assertAgentAllowed(agentType: string): void {
    if (agentType === 'grok-bot' || !this.deps.policy.allowedAgents.includes(agentType)) {
      throw new RpcError('agent_not_allowed', agentType);
    }
  }

  private agentsLogin(p: unknown): AgentsLoginResult {
    const { agentType, op, code } = (typeof p === 'object' && p !== null ? p : {}) as AgentsLoginParams;
    if (!isLoginAgent(agentType)) throw new RpcError('not_supported', agentType ?? '');
    this.assertAgentAllowed(agentType);
    if (op !== 'start' && op !== 'cancel' && op !== 'submit') {
      throw new RpcError('bad_request', 'op must be start, cancel, or submit');
    }
    if (op === 'submit') return this.loginRunner.submit(agentType, code);
    if (op === 'cancel') {
      this.loginRunner.cancel(agentType);
      return { cancelled: true };
    }
    this.loginRunner.start(agentType);
    return { started: true };
  }

  private requireSession(sid: string): Sess {
    const sess = this.sessions.get(sid);
    if (!sess) throw new RpcError('unknown_session', sid);
    return sess;
  }

  private push(sess: Sess, frame: Extract<NodeFrame, { sid: string; seq: number }>): void {
    this.sendOut(sess, frame, true);
  }

  private sendOut(sess: Sess, frame: NodeFrame, buffer: boolean, force = false): void {
    if (buffer && 'seq' in frame) {
      sess.buffer.push(frame as Extract<NodeFrame, { sid: string; seq: number }>);
      sess.bufferBytes += Buffer.byteLength(encodeFrame(frame), 'utf8');
      this.trim(sess);
    }
    if (!force && sess.paused) return;
    if (!this.peer) return;
    // Combined set, not sess.secrets: an MCP secret that is a prefix of a
    // longer agent-env value would replace just its own span here, mangling
    // the value before peer.redact's pass can match it and leaking the suffix.
    this.peer.send(redactFrame(frame, this.allSecrets()));
  }

  /** Hub → node: replace the in-memory vault env snapshot. The payload is
   *  untrusted — AgentEnvStore.replace drops malformed/reserved entries. */
  private agentEnvSync(p: unknown): { ok: true; changed: boolean } {
    if (!this.deps.agentEnv) throw new RpcError('no_method', 'agentEnv.sync');
    const wire = (typeof p === 'object' && p !== null ? p : {}) as { vars?: unknown; managedNames?: unknown };
    return { ok: true, changed: this.deps.agentEnv.replace(wire.vars, wire.managedNames).changed };
  }

  private allSecrets(): string[] {
    const out: string[] = [];
    for (const s of this.sessions.values()) out.push(...s.secrets);
    for (const s of this.tombstones.values()) out.push(...s.secrets);
    out.push(...(this.deps.agentEnv?.secrets() ?? []));
    return out;
  }

  private trim(sess: Sess): void {
    while (
      sess.buffer.length > this.bufferMax.events
      || sess.bufferBytes > this.bufferMax.bytes
    ) {
      const dropped = sess.buffer.shift();
      if (!dropped) break;
      sess.bufferBytes -= Buffer.byteLength(encodeFrame(dropped), 'utf8');
      if (sess.bufferBytes < 0) sess.bufferBytes = 0;
    }
  }

  private cleanupTemps(sess: Sess): void {
    for (const t of sess.temps) {
      try { t.cleanup(); } catch { /* already gone */ }
    }
    sess.temps = [];
  }

  private release(sess: Sess, tombstone: boolean): void {
    if (sess.dead) {
      if (!tombstone && this.tombstones.has(sess.sid)) this.dropTombstone(sess.sid);
      return;
    }
    sess.dead = true;
    this.sessions.delete(sess.sid);
    this.cleanupTemps(sess);
    if (sess.grace) {
      clearTimeout(sess.grace);
      sess.grace = undefined;
    }
    if (tombstone) {
      this.tombstones.set(sess.sid, sess);
      sess.grace = setTimeout(() => this.dropTombstone(sess.sid), this.graceMs);
      return;
    }
    void this.stopAdapter(sess);
  }

  private dropTombstone(sid: string): void {
    const sess = this.tombstones.get(sid);
    if (!sess) return;
    this.tombstones.delete(sid);
    if (sess.grace) {
      clearTimeout(sess.grace);
      sess.grace = undefined;
    }
    void this.stopAdapter(sess);
  }

  private async stopAdapter(sess: Sess): Promise<void> {
    try { await sess.adapter.stop(); } catch { /* ignore */ }
  }

  private async dropSession(sid: string): Promise<void> {
    const sess = this.sessions.get(sid) ?? this.tombstones.get(sid);
    if (!sess) return;
    this.release(sess, false);
  }

  /**
   * Materialise or unlink schedule pack files under a policy root.
   * Names are derived from a regex-checked slug + closed kind enum only.
   */
  private schedulePackFiles(raw: unknown): SchedulePackFilesResult {
    const p = (raw ?? {}) as Partial<SchedulePackFilesParams>;
    if (p.op !== 'write' && p.op !== 'unlink') {
      throw new RpcError('bad_request', 'op');
    }
    if (typeof p.root !== 'string' || !p.root) {
      throw new RpcError('bad_path', 'root');
    }
    if (typeof p.jobSlug !== 'string' || !PACK_SLUG_RE.test(p.jobSlug)) {
      throw new RpcError('bad_path', 'jobSlug');
    }
    if (!Array.isArray(p.files)) {
      throw new RpcError('bad_request', 'files');
    }
    const kindSet = new Set<string>(FILE_KINDS);
    let totalBytes = 0;
    const files: SchedulePackFilesParams['files'] = [];
    for (const f of p.files) {
      if (!f || typeof f !== 'object' || !kindSet.has((f as { kind?: string }).kind ?? '')) {
        throw new RpcError('bad_request', 'files.kind');
      }
      const kind = (f as { kind: (typeof FILE_KINDS)[number] }).kind;
      const body = typeof (f as { body?: unknown }).body === 'string'
        ? (f as { body: string }).body
        : '';
      totalBytes += Buffer.byteLength(body, 'utf8');
      files.push({ kind, body });
    }
    if (totalBytes > 2 * 1024 * 1024) {
      throw new RpcError('too_large', 'pack files exceed 2 MiB');
    }

    const realRoot = pathUnderRoots(p.root, this.deps.policy.roots);
    if (!realRoot) throw new RpcError('path_outside_roots', p.root);

    if (p.op === 'unlink') {
      unlinkPackFiles(realRoot, p.jobSlug, files.map((f) => f.kind));
      return { ok: true, written: [] };
    }

    try {
      // Hub already substituted tokens — pass empty vars.
      const { written } = materialisePackFiles(
        realRoot,
        p.jobSlug,
        files,
        {},
        { overwrite: p.overwrite },
      );
      return { ok: true, written };
    } catch (e) {
      if (e instanceof PackFileConflict) {
        return { ok: false, code: 'conflict', conflicts: e.conflicts };
      }
      if (e instanceof PackFilePathError) {
        throw new RpcError('bad_path', e.message);
      }
      throw e;
    }
  }
}

function coerceArgs(args: unknown[]): unknown[] {
  return args.map((a) => (a === null ? undefined : a));
}

function redactString(value: string, secrets: string[]): string {
  let out = value;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

function collectSecrets(servers?: ResolvedMcpServer[]): string[] {
  if (!servers) return [];
  const out: string[] = [];
  for (const s of servers) {
    for (const k of s.secretEnvKeys ?? []) {
      const v = s.env?.[k];
      if (v) out.push(v);
    }
    for (const k of s.secretHeaderKeys ?? []) {
      const v = s.headers?.[k];
      if (v) out.push(v);
    }
  }
  return out;
}

/** Dedup + longest first. A shorter secret that is a prefix of a longer one
 *  must be applied after it, or it redacts just its own span and leaves the
 *  longer value's suffix in the clear. */
function sortedSecrets(secrets: string[]): string[] {
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

function redactFrame(frame: NodeFrame, secrets: string[]): NodeFrame {
  if (secrets.length === 0) return frame;
  // Normalise here rather than trusting call sites: sendOut and peer.redact
  // hand in raw allSecrets() output.
  return redactValue(frame, sortedSecrets(secrets)) as NodeFrame;
}

function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = redactValue(v, secrets);
    return o;
  }
  return value;
}
