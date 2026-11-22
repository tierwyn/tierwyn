import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { buildChildEnv } from './childEnv.js';

export interface ProcessHandle {
  pid: number;
  process: ChildProcess;
  sessionId: string;
}

export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ProcessHandle>();

  spawn(sessionId: string, cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; agentType?: string } = {}): ChildProcess {
    // Never let children inherit listen PORT/HOST, auth secrets, or plugin keys.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts.env, undefined, opts.agentType),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.pid !== undefined) {
      this.processes.set(sessionId, { pid: child.pid, process: child, sessionId });
    }

    child.on('error', (err) => {
      this.emit('process-error', { sessionId, error: err });
      this.processes.delete(sessionId);
    });

    child.on('exit', (code, signal) => {
      this.emit('process-exit', { sessionId, code, signal });
      this.processes.delete(sessionId);
    });

    child.on('close', (code, signal) => {
      this.emit('process-close', { sessionId, code, signal });
    });

    return child;
  }

  kill(sessionId: string): boolean {
    const handle = this.processes.get(sessionId);
    if (!handle) return false;
    try {
      handle.process.kill('SIGTERM');
      this.processes.delete(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  killAll(): void {
    for (const [sessionId] of this.processes) {
      this.kill(sessionId);
    }
  }

  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }
}

export const processManager = new ProcessManager();
