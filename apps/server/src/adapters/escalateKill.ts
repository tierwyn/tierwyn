import type { ChildProcess } from 'child_process';

export const KILL_ESCALATION_MS = 5_000;

function isEsrch(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ESRCH';
}

/** After SIGTERM: SIGKILL if the child has not exited within afterMs.
 *  Non-group: checks the ChildProcess object (exitCode/signalCode), never a
 *  bare pid, so a recycled pid is never signalled. Timer is unref'd and
 *  cleared on exit/close.
 *  Group: the deadline is NOT cancelled when the leader exits — grandchildren
 *  in the same process group can ignore SIGTERM after the leader is gone.
 *  Always `process.kill(-pid, 'SIGKILL')` at the deadline; ESRCH is ignored. */
export function escalateKill(
  child: ChildProcess | null | undefined,
  opts: { group: boolean; afterMs?: number },
): void {
  if (!child) return;
  const pid = child.pid;
  const t = setTimeout(() => {
    if (opts.group && pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (err) {
        if (!isEsrch(err)) {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
      }
      return;
    }
    if (child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }, opts.afterMs ?? KILL_ESCALATION_MS);
  t.unref();
  if (!opts.group) {
    const clear = () => clearTimeout(t);
    child.once('exit', clear);
    child.once('close', clear);
  }
}
