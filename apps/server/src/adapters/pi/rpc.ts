import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';

export interface RpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export interface PiRpcOptions {
  /** Override for tests. Defaults to spawning the real `pi` binary. */
  spawn?: SpawnFn;
  spawnFn?: SpawnFn;
  /** Binary name/path. Defaults to "pi". */
  bin?: string;
}

/**
 * Low-level Pi RPC transport: JSONL over stdin/stdout.
 * Emits 'event' (id-less frames), 'error' (Error), 'exit' (code).
 */
export class PiRpc extends EventEmitter {
  private child: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  private exited = false;

  constructor(private opts: PiRpcOptions = {}) {
    super();
    this.readyPromise = new Promise((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
  }

  start(cfg: { cwd?: string; args: string[] }): void {
    const inner = this.opts.spawn ?? this.opts.spawnFn ?? spawn;
    const spawnFn: SpawnFn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'pi') });
    const child = spawnFn(this.opts.bin ?? 'pi', ['--mode', 'rpc', ...cfg.args], { cwd: cfg.cwd });
    this.child = child;
    child.stdin?.on('error', () => {}); // async EPIPE must not crash the server

    // The real `pi --mode rpc` does not emit a {"type":"ready"} frame — it spawns and
    // accepts commands immediately. So a successful spawn is our readiness signal. We
    // still honour a "ready" frame (see onLine) for forward/backward compatibility.
    child.on('spawn', () => this.settleReady());

    child.on('error', (err: Error) => {
      this.failAll(err);
      this.emit('error', err);
    });
    child.on('close', (code: number | null) => {
      this.exited = true;
      this.failAll(new Error(`pi rpc process exited (code ${code})`));
      this.emit('exit', code);
      this.rl?.close();
      this.rl = null;
      this.child = null;
    });

    if (child.stdout) {
      this.rl = createInterface({ input: child.stdout });
      this.rl.on('line', (raw) => this.onLine(raw.replace(/\r$/, '')));
    }
    if (child.stderr) {
      child.stderr.on('data', (d: Buffer) => this.emit('stderr', d.toString()));
    }
  }

  ready(): Promise<void> { return this.readyPromise; }

  /** Resolve the ready promise exactly once; subsequent calls are no-ops. */
  private settleReady(): void {
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }

    if (frame.type === 'ready') { this.settleReady(); return; }

    if (frame.type === 'response') {
      const res = frame as unknown as RpcResponse;
      if (res.id && this.pending.has(res.id)) {
        this.pending.get(res.id)!.resolve(res);
        this.pending.delete(res.id);
      }
      return;
    }
    // Everything else is an agent/session/extension event.
    this.emit('event', frame);
  }

  /** Fire-and-forget write (no response expected), e.g. abort. */
  notify(cmd: Record<string, unknown>): void {
    this.write(cmd);
  }

  /** Send a command and await its correlated response. */
  request(cmd: Record<string, unknown>): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new Error('pi rpc process exited'));
    const id = randomUUID();
    return new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ ...cmd, id });
    });
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
    try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
  }
}
