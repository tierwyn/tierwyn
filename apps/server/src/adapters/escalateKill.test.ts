import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { escalateKill, KILL_ESCALATION_MS } from './escalateKill.js';

function fakeChild(pid?: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

describe('escalateKill', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends SIGKILL when the child is still alive after the delay', () => {
    vi.useFakeTimers();
    const child = fakeChild();
    escalateKill(child as unknown as ChildProcess, { group: false });
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(KILL_ESCALATION_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('sends no SIGKILL when the child has already exited', () => {
    vi.useFakeTimers();
    const child = fakeChild();
    escalateKill(child as unknown as ChildProcess, { group: false });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    vi.advanceTimersByTime(KILL_ESCALATION_MS);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses process.kill(-pid) on the group path', () => {
    vi.useFakeTimers();
    const child = fakeChild(4242);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    escalateKill(child as unknown as ChildProcess, { group: true });
    vi.advanceTimersByTime(KILL_ESCALATION_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('group path still SIGKILLs the process group after the leader exits', () => {
    vi.useFakeTimers();
    const child = fakeChild(4242);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    escalateKill(child as unknown as ChildProcess, { group: true });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0);
    vi.advanceTimersByTime(KILL_ESCALATION_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('group path swallows ESRCH when the group is already gone', () => {
    vi.useFakeTimers();
    const child = fakeChild(4242);
    const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw err; });
    escalateKill(child as unknown as ChildProcess, { group: true });
    expect(() => vi.advanceTimersByTime(KILL_ESCALATION_MS)).not.toThrow();
  });
});
