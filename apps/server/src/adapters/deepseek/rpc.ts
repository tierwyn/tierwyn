import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { buildChildEnv } from '../../childEnv.js';
import { createInterface } from 'readline';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

const BOOTSTRAP_NAMES = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'SHELL', 'NODE_OPTIONS', 'NODE_PATH',
  'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PERL5OPT', 'PERL5LIB',
  'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'PYTHONHOME', 'GIT_SSH',
  'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT', 'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'PORT', 'HOST', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP',
]);

const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_'];

/**
 * Determine a safe cwd for spawning `dsh --profile sdk`.
 *
 * dsh-app-boot loads `.env` from `process.cwd()` before plugin/SDK init and
 * throws fatal Error if any bootstrap-only variable is set (e.g. PATH, HOST,
 * PORT in Tierwyn repo .env). When targetCwd contains a .env with bootstrap
 * names, fall back to homedir (or DSH_HOME) for the process launch.
 * The target project directory is still delivered cleanly via `initialize({ cwd })`.
 */
export function safeDshSpawnCwd(targetCwd?: string): string | undefined {
  if (!targetCwd) return undefined;
  const envFile = join(targetCwd, '.env');
  if (existsSync(envFile)) {
    try {
      const content = readFileSync(envFile, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim().toUpperCase();
        if (BOOTSTRAP_NAMES.has(key) || BOOTSTRAP_PREFIXES.some((p) => key.startsWith(p))) {
          return process.env.DSH_HOME ?? homedir();
        }
      }
    } catch {
      // ignore read errors
    }
  }
  return targetCwd;
}

export interface DeepSeekRpcOptions {
  spawn?: SpawnFn;
  spawnFn?: SpawnFn;
  bin?: string;
  /** Handle an inbound server→client JSON-RPC request.
   *  Call `reply(result)` to send the response — may be called asynchronously.
   *  If omitted, replies with `{}`. Seam for a future permission round-trip. */
  onRequest?: (method: string, params: Record<string, unknown>, reply: (result: unknown) => void) => void;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

// ponytail: third copy of the JSON-RPC-over-stdio client (see hermes/acp.ts,
// kiro/acp.ts). Deliberate — extracting a shared transport would mean editing
// two live adapters. Extract when a fourth adapter needs it, or the first time
// a bug is fixed in one copy and not the others.

/**
 * JSON-RPC 2.0 over newline-delimited stdio to `dsh --profile sdk`.
 *
 * Emits: 'notification' ({ method, params }), 'error' (Error), 'exit' (code),
 * 'stderr' (string). Inbound requests (message has both `id` and `method`) are
 * answered via opts.onRequest (default: empty result).
 */
export class DeepSeekRpc extends EventEmitter {
  private child: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  private stderrBuf: string[] = [];

  constructor(private opts: DeepSeekRpcOptions = {}) {
    super();
    this.readyPromise = new Promise((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
  }

  start(cfg: { cwd?: string; args?: string[]; env?: Record<string, string> }): void {
    // Overlay after scrub: zai-usage captures ZAI_API_KEY into the plugin
    // scrub set, so the child would otherwise lose the key dsh needs for z.ai.
    const extraEnv: NodeJS.ProcessEnv = { ...(cfg.env ?? {}) };
    if (process.env.ZAI_API_KEY) extraEnv.ZAI_API_KEY = process.env.ZAI_API_KEY;
    const inner = this.opts.spawn ?? this.opts.spawnFn ?? spawn;
    const spawnFn: SpawnFn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(extraEnv, undefined, 'deepseek') });
    const spawnCwd = safeDshSpawnCwd(cfg.cwd);
    const child = spawnFn(this.opts.bin ?? 'dsh', ['--profile', 'sdk', ...(cfg.args ?? [])], { cwd: spawnCwd });
    this.child = child;
    child.stdin?.on('error', () => {}); // async EPIPE must not crash the server

    child.on('spawn', () => this.settleReady());

    child.on('error', (err: Error) => { this.failAll(err); this.emit('error', err); });
    child.on('close', (code: number | null) => {
      this.exited = true;
      const detail = this.stderrBuf.join('').trim();
      const exitMsg = code === 0
        ? 'dsh exited'
        : `dsh exited (code ${code})${detail ? `: ${detail}` : ''}`;
      this.failAll(new Error(exitMsg));
      this.emit('exit', code);
      this.rl?.close(); this.rl = null; this.child = null;
    });

    if (child.stdout) {
      this.rl = createInterface({ input: child.stdout });
      this.rl.on('line', (raw) => this.onLine(raw.replace(/\r$/, '')));
    }
    if (child.stderr) {
      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        this.stderrBuf.push(text);
        if (this.stderrBuf.length > 20) this.stderrBuf.shift();
        this.emit('stderr', text);
      });
    }
  }

  ready(): Promise<void> { return this.readyPromise; }

  private settleReady(): void {
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }

    const hasId = msg.id !== undefined && msg.id !== null;
    const isResult = msg.result !== undefined || msg.error !== undefined;

    if (hasId && isResult) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        const e = msg.error as { message?: string };
        p.reject(new Error(e?.message ?? 'dsh error'));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (hasId && typeof msg.method === 'string') {
      const reply = (result: unknown) => this.write({ jsonrpc: '2.0', id: msg.id, result });
      if (this.opts.onRequest) {
        this.opts.onRequest(msg.method, (msg.params ?? {}) as Record<string, unknown>, reply);
      } else {
        reply({});
      }
      return;
    }

    if (typeof msg.method === 'string') {
      this.emit('notification', { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
    }
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.exited) return Promise.reject(new Error('dsh exited'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  private write(obj: Record<string, unknown>): void {
    this.child?.stdin?.write(JSON.stringify(obj) + '\n');
  }

  private failAll(err: Error): void {
    this.readyReject?.(err);
    this.readyResolve = null;
    this.readyReject = null;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  kill(): void {
    this.rl?.close();
    try { this.child?.kill('SIGTERM'); } catch { /* already gone */ }
  }
}
