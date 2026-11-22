import { createRequire } from 'module';
import { createHash, createPrivateKey, generateKeyPairSync } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { arch, homedir, hostname, platform } from 'os';
import { delimiter, dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { AgentAdapter } from '@tierwyn/shared';
import { NODE_FEATURES, NODE_PROTOCOL, OPTIONAL_ADAPTER_METHODS, TIERWYN_VERSION, type NodeHello } from '@tierwyn/shared';
import { registerStdioAdapters } from '../adapters/registerAll.js';
import { AGENT_BINARIES, binaryOnPath } from '../discovery.js';
import type { AdapterFactoryOpts } from '../registry.js';
import { startNodeClient } from './client.js';
import { artifactSweep } from './artifactStore.js';
import { AgentEnvStore } from './agentEnvStore.js';
import { COPILOT_ENV_NAME, setAgentEnvSource } from '../childEnv.js';
import { setCopilotTokenSource } from '../adapters/copilot/index.js';
import { defaultNodeRoot, ensureAgentPath, loadNodeConfig, nodeConfigDir, writeNodeConfigFile, type NodeConfig } from './policy.js';
import { probeLogin } from './loginProbe.js';
import { NodeRuntime } from './runtime.js';
import { firstFreeLoopbackPort, startTunnelListener } from './tunnel.js';
import { hardenGitEnv } from './gitCall.js';
import { AgentsCliError, defaultExec, dirValue, NODE_AGENT_TYPES, parseAgentList, resolveNodeUnit, runAgentsCommand, validateAgents, type Exec } from './agentsCli.js';
import { probeInstalledVersion } from '../versions.js';
import { bwrapAvailable } from '../sandbox/bwrap.js';
import { readBuildIdentity } from './buildIdentity.js';
import { readProfiles } from '../profiles.js';
import { packageFetch, PackageFetchError } from './packageFetch.js';

function optional<T>(name: string, value: T | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [name]: value };
}

const USAGE = `Usage:
  node dist/node/main.js enroll --hub <url> --token <token> [--dir <path>] [--all-agents | --agents a,b] [--allow-http]
  node dist/node/main.js allow <agent>... | --all [--no-restart] [--dir <path>]
  node dist/node/main.js disallow <agent>... | --all [--no-restart] [--dir <path>]
  node dist/node/main.js status [--json] [--dir <path>]
  node dist/node/main.js run
  node dist/node/main.js self-check
  node dist/node/main.js package-fetch --out <file> [--dir <path>] [--allow-http]
  node dist/node/main.js --help
`;

type LocalReg = {
  create(type: string, opts?: AdapterFactoryOpts): AgentAdapter;
  has(type: string): boolean;
  registeredTypes(): Set<string>;
  register(type: string, f: (opts?: AdapterFactoryOpts) => AgentAdapter, label?: string): void;
};

function makeLocalRegistry(): LocalReg {
  const entries = new Map<string, (opts?: AdapterFactoryOpts) => AgentAdapter>();
  return {
    register(type, f) { entries.set(type, f); },
    create(type, opts) {
      const f = entries.get(type);
      if (!f) throw new Error(`No adapter registered for agentType: ${type}`);
      return f(opts);
    },
    has(type) { return entries.has(type); },
    registeredTypes() { return new Set(entries.keys()); },
  };
}

export async function enroll(
  args: { hub: string; token: string; name?: string; dir?: string; agents?: string[]; allAgents?: boolean; allowHttp?: boolean },
  fetchFn: typeof fetch = fetch,
  exec: Exec = defaultExec,
): Promise<void> {
  // Validate before any key write / network call so a typo never burns the single-use token.
  let preset: string[] | undefined;
  if (args.allAgents) preset = [...NODE_AGENT_TYPES];
  else if (args.agents) {
    preset = parseAgentList(args.agents);
    validateAgents(preset, 'enroll');
  }
  const dir = args.dir ?? nodeConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'key');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(keyPath, pem, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const hubOrigin = new URL(args.hub).origin;
  const url = `${args.hub.replace(/\/+$/, '')}/node/enroll`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: args.token,
      publicKey: publicKeyB64,
      hubOrigin,
      hello: { hostname: hostname(), os: platform(), arch: arch() },
    }),
  });
  if (!res.ok) {
    throw new Error(`enroll failed: HTTP ${res.status}`);
  }
  const body = await res.json() as { hostId?: string; trusted?: boolean };
  if (!body.hostId) throw new Error('enroll failed: missing hostId');

  let prev: Record<string, unknown> = {};
  const cfgPath = join(dir, 'node.json');
  if (existsSync(cfgPath)) {
    try {
      const p = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (p && typeof p === 'object' && !Array.isArray(p)) prev = p as Record<string, unknown>;
    } catch { /* rewrite defaults */ }
  }
  const prevRoots = Array.isArray(prev.roots) && prev.roots.length ? prev.roots.map(String) : undefined;
  const prevAllowed = Array.isArray(prev.allowedAgents) ? prev.allowedAgents.map(String) : undefined;
  const allowedAgents = preset ?? prevAllowed ?? [];
  // Default root only — never mkdir operator-chosen roots (may be an unmounted volume).
  const defaultRoot = defaultNodeRoot();
  const roots = prevRoots ?? [defaultRoot];
  if (!prevRoots) mkdirSync(defaultRoot, { recursive: true });
  writeNodeConfigFile(dir, {
    ...prev,
    hubUrl: args.hub,
    hostId: body.hostId,
    roots,
    allowedAgents,
    listenPort: prev.listenPort ?? await firstFreeLoopbackPort(8788),
    maxSessions: prev.maxSessions ?? 8,
    ...(args.allowHttp ? { allowHttpPackage: true } : {}),
  });
  // Start (or restart) the daemon either way: `restart` so a re-enroll drops the
  // stale hostId/key a running unit holds in memory (`enable --now` is a no-op on
  // a running unit). Untrusted: the client retries the hub's 4403 until Trust lands.
  const unit = resolveNodeUnit(exec);
  const en = exec('systemctl', ['--user', 'enable', unit]);
  const r = en === 'enoent' || en.status !== 0 ? en : exec('systemctl', ['--user', 'restart', unit]);
  const started = r !== 'enoent' && r.status === 0;
  // Same digest as the hub's keyFingerprint() so the operator can match the host card.
  const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('base64').replace(/=+$/, '')}`;
  const lines = [
    `Enrolled as ${body.hostId} with hub ${hubOrigin}`,
    `  Fingerprint:    ${fingerprint}`,
    allowedAgents.length
      ? `  Allowed agents: ${allowedAgents.join(', ')}`
      : `  Allowed agents: none yet. Run: tierwyn node allow <agent>… (or edit ${dir}/node.json)`,
    started ? `  Service:        ${unit} started` : `  Service:        could not start ${unit}. Run: tierwyn node start`,
    body.trusted
      ? `  Trust:          Trusted by hub (auto-trust)${started ? '; connecting now' : ''}`
      : `  Trust:          waiting. Open ${hubOrigin} → ⚙ Settings → Remote Hosts, check the fingerprint matches, then click Trust.${started ? ' The node connects within ~10s once the operator clicks Trust.' : ''}`,
    `  Watch:          tierwyn node logs   (prints "connected to hub" when up)`,
  ];
  (started ? console.log : console.error)(lines.join('\n'));
}

export async function buildHello(
  config: NodeConfig,
  reg: { create: (type: string, opts?: AdapterFactoryOpts) => AgentAdapter; has: (type: string) => boolean; registeredTypes(): Set<string> },
  artifactsRoot?: string,
  versionDeadlineMs = 15_000,
  sandboxAvailable = false,
): Promise<NodeHello> {
  const agents: NodeHello['agents'] = {};
  const models: NodeHello['models'] = {};
  const allowed = new Set(config.allowedAgents);
  const modelProbes: Array<Promise<void>> = [];
  const versionProbes: Array<Promise<void>> = [];
  // Blocks late-resolving probes from mutating the hello after the batch gave up.
  let batchSettled = false;

  for (const type of reg.registeredTypes()) {
    const adapter = reg.create(type);
    const methods = OPTIONAL_ADAPTER_METHODS.filter(
      (m) => typeof (adapter as unknown as Record<string, unknown>)[m] === 'function',
    );
    const bin = AGENT_BINARIES[type]?.bin;
    const onPath = bin ? binaryOnPath(bin) : false;
    const installed = allowed.has(type) && onPath;
    agents[type] = {
      installed,
      allowed: allowed.has(type),
      installable: Boolean(AGENT_BINARIES[type]?.install),
      methods: [...methods],
      ...(installed ? optional('loggedIn', probeLogin(type)) : {}),
      ...(adapter.oneShotModes ? { oneShotModes: [...adapter.oneShotModes] } : {}),
    };
    if (installed && bin) {
      versionProbes.push(
        probeInstalledVersion(bin).then((v) => {
          if (v !== undefined && !batchSettled) agents[type].version = v;
        }),
      );
    }
    if (!installed) continue;
    modelProbes.push(
      listModelNames(adapter).then((names) => {
        models[type] = names;
      }),
    );
  }
  // The hub 4408s a node when auth+hello exceed 30s: bound the whole probe
  // batch (a hung `--version` CLI can burn ~42s with the retry) so the hello
  // can never stall past it. Agents still probing just ship without a version.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([...modelProbes, ...versionProbes]),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, versionDeadlineMs);
        deadline.unref?.();
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  batchSettled = true;

  const ident = readBuildIdentity(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
  return {
    protocol: NODE_PROTOCOL,
    gitSha: ident.id,
    version: TIERWYN_VERSION,
    installSource: ident.source,
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    homedir: homedir(),
    roots: config.roots,
    listenPort: config.listenPort,
    agents,
    models,
    sessions: [],
    features: [...NODE_FEATURES],
    sandbox: { policy: config.sandbox, available: sandboxAvailable },
    sandboxPaths: { allow: config.sandboxPaths?.allow ?? 'ro' },
    ...(artifactsRoot ? { artifactsRoot: realpathSync(artifactsRoot) } : {}),
  };
}

async function listModelNames(adapter: AgentAdapter): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      adapter.listModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('listModels timeout')), 12_000);
      }),
    ]);
    return models.map((m) => m.name);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { ensureAgentPath };

export type SelfCheckResult = {
  buildId: string;
  source: 'git' | 'package';
  sqlite: true;
  profiles: number;
};

export function selfCheck(opts?: {
  readProfiles?: () => unknown[];
  repoRoot?: string;
  log?: (line: string) => void;
}): SelfCheckResult {
  const root = opts?.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const ident = readBuildIdentity(root);
  const profiles = (opts?.readProfiles ?? readProfiles)();
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error('profiles unavailable');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (id INTEGER)');
  } finally {
    db.close();
  }
  const out: SelfCheckResult = {
    buildId: ident.id,
    source: ident.source,
    sqlite: true,
    profiles: profiles.length,
  };
  (opts?.log ?? console.log)(JSON.stringify(out));
  return out;
}

export async function runNode(dir?: string): Promise<void> {
  hardenGitEnv(process.env);
  ensureAgentPath(process.env);
  const d = dir ?? nodeConfigDir();
  let config: NodeConfig;
  try {
    config = loadNodeConfig(d);
  } catch {
    console.error('not enrolled');
    process.exit(2);
    return;
  }
  if (!config.hostId || !existsSync(config.keyPath)) {
    console.error('not enrolled');
    process.exit(2);
    return;
  }
  const privateKey = createPrivateKey(readFileSync(config.keyPath));
  const hubOrigin = new URL(config.hubUrl).origin;

  const localRegistry = makeLocalRegistry();
  registerStdioAdapters(localRegistry, () => 'bypass');
  // Memory-only holder of hub-pushed vault env values. Installed before the
  // first spawn/computeHello so every child env sees the scrub seam from boot.
  const agentEnvStore = new AgentEnvStore(() => config.allowedAgents);
  setAgentEnvSource((t) => agentEnvStore.slice(t));
  setCopilotTokenSource(() => agentEnvStore.slice('copilot').own[COPILOT_ENV_NAME]);
  const sandboxAvailable = bwrapAvailable();
  const artifactsRoot = join(nodeConfigDir(), 'artifacts');
  mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  let cachedHello: NodeHello | undefined;
  let refreshPromise: Promise<NodeHello> | undefined;
  const runtime = new NodeRuntime({
    create: (type, opts) => localRegistry.create(type, opts),
    has: (type) => localRegistry.has(type),
    policy: config,
    nodeDir: d,
    agentEnv: agentEnvStore,
    artifactsRoot,
    buildHello: async (): Promise<NodeHello> => {
      const hello = await buildHello(config, localRegistry, artifactsRoot, 15_000, sandboxAvailable);
      hello.sessions = runtime.sessionIds();
      cachedHello = hello;
      return hello;
    },
    sandboxAvailable: () => sandboxAvailable,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
  });
  const computeHello = async (): Promise<NodeHello> => {
    // Generation guard: a background compute that straddles an agentEnv.sync
    // probed agents without the freshly delivered env keys. Discard it instead
    // of clobbering the env-aware hello that sync's refresh produced, and
    // recompute against the newer snapshot (bounded, so we always terminate).
    for (let attempt = 1; ; attempt++) {
      const gen = agentEnvStore.revision;
      const hello = await buildHello(config, localRegistry, artifactsRoot, 15_000, sandboxAvailable);
      if (agentEnvStore.revision === gen || attempt >= 3) {
        if (agentEnvStore.revision !== gen) console.warn('[node] hello kept racing agent env sync; caching latest');
        hello.sessions = runtime.sessionIds();
        cachedHello = hello;
        return hello;
      }
    }
  };
  // Prime the hello cache before dialing so the WebSocket challenge→hello
  // round-trip is instant and never races a 10s hub handshakeTimer.
  await computeHello().catch(() => undefined);
  const buildHelloPayload = async (): Promise<NodeHello> => {
    if (cachedHello) {
      if (!refreshPromise) {
        refreshPromise = computeHello().finally(() => { refreshPromise = undefined; });
      }
      return { ...cachedHello, sessions: runtime.sessionIds() };
    }
    return computeHello();
  };
  const client = startNodeClient({
    config,
    privateKey,
    hubOrigin,
    buildHello: buildHelloPayload,
    runtime,
  });
  startArtifactSweep(config, artifactsRoot);
  const tunnel = await startTunnelListener({
    port: config.listenPort,
    peer: () => client.peer(),
    canStream: () => client.features().has('tunnel.stream'),
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      tunnel.close();
      client.stop();
      const stop = runtime.handlers()['session.call'];
      const stops = runtime.sessionIds().map((sid) =>
        stop ? stop({ sid, method: 'stop', args: [] }).catch(() => undefined) : Promise.resolve(),
      );
      void Promise.all(stops).finally(() => resolve());
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

/** Sweep old artifacts 60 s after start, then daily. Never throws. */
function startArtifactSweep(config: NodeConfig, artifactsRoot: string): void {
  const maxAgeDays = config.artifactsMaxAgeDays;
  if (!(maxAgeDays > 0)) return;
  const run = async (): Promise<void> => {
    try {
      const { removed } = await artifactSweep(artifactsRoot, maxAgeDays, Date.now());
      if (removed > 0) console.log(`artifact sweep: removed ${removed}`);
    } catch (err) {
      console.error(`artifact sweep failed: ${(err as Error).message}`);
    }
  };
  setTimeout(() => { void run(); }, 60_000).unref();
  setInterval(() => { void run(); }, 24 * 3_600_000).unref();
}

export function parseEnroll(argv: string[]): { hub: string; token: string; dir?: string; agents?: string[]; allAgents?: boolean; allowHttp?: boolean } {
  let hub = '';
  let token = '';
  let dir: string | undefined;
  let agents: string[] | undefined;
  let allAgents = false;
  let allowHttp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hub') hub = argv[++i] ?? '';
    else if (a === '--token') token = argv[++i] ?? '';
    else if (a === '--dir') dir = dirValue(argv[++i]);
    else if (a === '--all-agents') allAgents = true;
    else if (a === '--allow-http') allowHttp = true;
    else if (a === '--agents' || a.startsWith('--agents=')) {
      const v = a === '--agents' ? (argv[++i] ?? '') : a.slice('--agents='.length);
      const list = parseAgentList([v]);
      if (!list.length) throw new AgentsCliError(2, '--agents needs at least one agent; omit the flag to keep the current list');
      agents = [...(agents ?? []), ...list];
    } else if (a.startsWith('--')) throw new AgentsCliError(2, `unknown option ${a}`);
  }
  if (allAgents && agents) throw new AgentsCliError(2, '--all-agents and --agents are mutually exclusive');
  if (!hub || !token) throw new AgentsCliError(2, USAGE);
  return {
    hub, token, dir,
    ...(agents ? { agents: parseAgentList(agents) } : {}),
    ...(allAgents ? { allAgents } : {}),
    ...(allowHttp ? { allowHttp } : {}),
  };
}

export function parsePackageFetch(argv: string[]): { out: string; dir?: string; allowHttp?: boolean } {
  let out = '';
  let dir: string | undefined;
  let allowHttp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i] ?? '';
    else if (a === '--dir') dir = dirValue(argv[++i]);
    else if (a === '--allow-http') allowHttp = true;
    else if (a.startsWith('--')) throw new AgentsCliError(2, `unknown option ${a}`);
  }
  if (!out) throw new AgentsCliError(2, USAGE);
  return { out, ...(dir ? { dir } : {}), ...(allowHttp ? { allowHttp } : {}) };
}

export async function cli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help' || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  if (argv[0] === 'enroll') {
    try {
      await enroll(parseEnroll(argv.slice(1)));
    } catch (err) {
      if (err instanceof AgentsCliError) {
        console.error(err.message);
        process.exit(err.code);
      }
      throw err;
    }
    return;
  }
  if (argv[0] === 'allow' || argv[0] === 'disallow' || argv[0] === 'status') {
    process.exitCode = await runAgentsCommand(argv[0], argv.slice(1));
    return;
  }
  if (argv[0] === 'self-check') {
    try {
      selfCheck();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }
  if (argv[0] === 'package-fetch') {
    try {
      const parsed = parsePackageFetch(argv.slice(1));
      const { buildId } = await packageFetch(parsed);
      process.stdout.write(`${buildId}\n`);
    } catch (err) {
      if (err instanceof AgentsCliError) {
        console.error(err.message);
        process.exit(err.code);
      }
      if (err instanceof PackageFetchError && err.code === 'not_enrolled') {
        console.error(err.message);
        process.exit(2);
      }
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }
  if (argv[0] === 'run' || argv.length === 0) {
    await runNode();
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

function isEntrypoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(resolve(arg)).href === import.meta.url
      || fileURLToPath(import.meta.url) === resolve(arg);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  cli().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
