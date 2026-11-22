import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { termChildProcess } from '../../sandbox/bwrap.js';
import { createInterface } from 'readline';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;

export interface AcpClientOptions {
  spawn?: SpawnFn;
  spawnFn?: SpawnFn;
  bin?: string;
  /** Handle an inbound agent→client JSON-RPC request.
   *  Call `reply(result)` to send the response — may be called asynchronously
   *  to defer the answer (e.g. waiting for operator input). If omitted, replies
   *  with an empty object. Used to implement session/request_permission handling. */
  onRequest?: (method: string, params: Record<string, unknown>, reply: (result: unknown) => void) => void;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

/** Legal ACP `session/request_permission` result. `'cancel'` (single L) is a
 *  parse error on the agent side and hangs the turn. */
export const permissionSelected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
export const permissionCancelled = () => ({ outcome: { outcome: 'cancelled' } });

/**
 * Minimal Agent Client Protocol transport: JSON-RPC 2.0 over the child's
 * stdio, one JSON message per line. Mirrors kiro/acp.ts.
 *
 * Emits: 'notification' ({ method, params }), 'error' (Error), 'exit' (code),
 * 'stderr' (string). Inbound requests (message has both `id` and `method`) are
 * answered synchronously via opts.onRequest.
 */
export class AcpClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;

  constructor(private opts: AcpClientOptions = {}) { super(); }

  start(cfg: { cwd?: string; args?: string[] }): void {
    // Spawn detached into a new process group so kill() can process.kill(-pid)
    // the whole group — qwen's run_shell_command grandchildren must not outlive us.
    const inner = this.opts.spawn ?? this.opts.spawnFn ?? spawn;
    const spawnFn: SpawnFn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: buildChildEnv(undefined, undefined, 'qwen') });
    const child = spawnFn(this.opts.bin ?? 'qwen', ['--acp', ...(cfg.args ?? [])], { cwd: cfg.cwd, detached: true });
    this.child = child;
    child.stdin?.on('error', () => {}); // async EPIPE must not crash the server

    child.on('error', (err: Error) => { this.failAll(err); this.emit('error', err); });
    child.on('close', (code: number | null) => {
      this.exited = true;
      this.failAll(new Error(`qwen acp exited (code ${code})`));
      this.emit('exit', code);
      this.rl?.close(); this.rl = null; this.child = null;
    });

    if (child.stdout) {
      this.rl = createInterface({ input: child.stdout });
      this.rl.on('line', (raw) => this.onLine(raw.replace(/\r$/, '')));
    }
    if (child.stderr) child.stderr.on('data', (d: Buffer) => this.emit('stderr', d.toString()));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }

    const hasId = msg.id !== undefined && msg.id !== null;
    const isResult = msg.result !== undefined || msg.error !== undefined;

    // Response to one of our outbound requests.
    if (hasId && isResult) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        const e = msg.error as { message?: string };
        p.reject(new Error(e?.message ?? 'ACP error'));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Inbound request from the agent (id + method): answer via onRequest.
    if (hasId && typeof msg.method === 'string') {
      const reply = (result: unknown) => this.write({ jsonrpc: '2.0', id: msg.id, result });
      if (this.opts.onRequest) {
        this.opts.onRequest(msg.method, (msg.params ?? {}) as Record<string, unknown>, reply);
      } else {
        reply({});
      }
      return;
    }

    // Notification (method, no id).
    if (typeof msg.method === 'string') {
      this.emit('notification', { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
    }
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.exited) return Promise.reject(new Error('qwen acp exited'));
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
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  kill(): void {
    this.rl?.close();
    termChildProcess(this.child, { group: true });
  }
}
