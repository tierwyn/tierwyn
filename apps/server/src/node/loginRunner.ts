import { spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { stripVTControlCharacters } from 'node:util';
import type { AgentsLoginEvent } from '@tierwyn/shared';
import { escalateKill } from '../adapters/escalateKill.js';
import { buildChildEnv } from '../childEnv.js';
import { AGENT_BINARIES, binaryOnPath } from '../discovery.js';
import { RpcError } from './rpc.js';
import { CODEX_DEVICE_PARSE_MS, CODEX_LOGIN_WAIT_MS, parseCodexDeviceAuth } from './codexDeviceAuth.js';
import {
  copilotLoginAbort,
  deviceLoginError,
  parseCopilotDevice,
  parseCursorLogin,
  parseGrokDevice,
} from './agentLogin.js';
import {
  CLAUDE_LOGIN_ARGV, CLAUDE_LOGIN_WAIT_MS, CLAUDE_URL_PARSE_MS,
  claudeLoginError, isClaudePasteCode, parseClaudeAuthUrl,
} from './claudeAuth.js';

export type LoginAgentType = 'codex' | 'claude-code' | 'copilot' | 'grok-build' | 'cursor';

export function defaultSpawnLogin(argv: string[], agentType: string): ChildProcess {
  const spec = isLoginAgent(agentType) ? LOGIN_SPECS[agentType] : undefined;
  const bin = AGENT_BINARIES[agentType]?.bin ?? 'codex';
  const extra = spec?.env;
  return spawn(bin, argv, {
    cwd: homedir(),
    env: buildChildEnv(extra),
    stdio: [spec?.stdin ?? 'ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

function killLoginChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
    escalateKill(child, { group: true });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* gone */ }
}

export function isLoginAgent(agentType: string): agentType is LoginAgentType {
  return Object.prototype.hasOwnProperty.call(LOGIN_SPECS, agentType);
}

interface LoginSpec {
  argv: string[];
  env?: Record<string, string>;
  stdin?: 'pipe' | 'ignore';
  parseMs: number;
  waitMs: number;
  parse(buf: string): AgentsLoginEvent | null;
  abort?(buf: string): string | null;
  error(buf: string): string;
  parseTimeoutMessage: string;
  timeoutMessage: string;
}

export const LOGIN_SPECS: Record<LoginAgentType, LoginSpec> = {
  codex: {
    argv: ['login', '--device-auth'],
    stdin: 'ignore',
    parseMs: CODEX_DEVICE_PARSE_MS,
    waitMs: CODEX_LOGIN_WAIT_MS,
    parse(buf) {
      const parsed = parseCodexDeviceAuth(buf);
      if (!parsed) return null;
      return { agentType: 'codex', phase: 'device', url: parsed.url, userCode: parsed.userCode };
    },
    error(buf) {
      const lines = stripVTControlCharacters(buf).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const last = lines.at(-1) ?? '';
      if (!last) return 'codex login failed';
      return last.length > 300 ? last.slice(-300) : last;
    },
    parseTimeoutMessage: 'codex did not print a device code',
    timeoutMessage: 'codex login timed out',
  },
  'claude-code': {
    argv: CLAUDE_LOGIN_ARGV,
    stdin: 'pipe',
    env: { BROWSER: 'true' },
    parseMs: CLAUDE_URL_PARSE_MS,
    waitMs: CLAUDE_LOGIN_WAIT_MS,
    parse(buf) {
      const url = parseClaudeAuthUrl(buf);
      if (!url) return null;
      return { agentType: 'claude-code', phase: 'authorize', url };
    },
    error: claudeLoginError,
    parseTimeoutMessage: 'claude did not print a sign-in URL — update Claude Code on the host',
    timeoutMessage: 'claude login timed out',
  },
  copilot: {
    argv: ['login', '--device-code'],
    stdin: 'ignore',
    env: { BROWSER: 'true', COPILOT_AUTO_UPDATE: 'false' },
    parseMs: CODEX_DEVICE_PARSE_MS,
    waitMs: CODEX_LOGIN_WAIT_MS,
    parse(buf) {
      const parsed = parseCopilotDevice(buf);
      if (!parsed) return null;
      return { agentType: 'copilot', phase: 'device', url: parsed.url, userCode: parsed.userCode };
    },
    abort: copilotLoginAbort,
    error(buf) {
      const msg = deviceLoginError(buf);
      return msg === 'login failed' ? 'copilot login failed' : msg;
    },
    parseTimeoutMessage: 'copilot did not print a device code — update Copilot on the host',
    timeoutMessage: 'copilot login timed out',
  },
  'grok-build': {
    argv: ['login', '--device-auth'],
    stdin: 'ignore',
    env: { BROWSER: 'true' },
    parseMs: CODEX_DEVICE_PARSE_MS,
    waitMs: CODEX_LOGIN_WAIT_MS,
    parse(buf) {
      const parsed = parseGrokDevice(buf);
      if (!parsed) return null;
      return { agentType: 'grok-build', phase: 'device', url: parsed.url, userCode: parsed.userCode };
    },
    error(buf) {
      const msg = deviceLoginError(buf);
      return msg === 'login failed' ? 'grok login failed' : msg;
    },
    parseTimeoutMessage: 'grok did not print a device code — update Grok on the host',
    timeoutMessage: 'grok login timed out',
  },
  cursor: {
    argv: ['login'],
    stdin: 'ignore',
    env: { NO_OPEN_BROWSER: '1', BROWSER: 'true' },
    parseMs: CODEX_DEVICE_PARSE_MS,
    waitMs: CODEX_LOGIN_WAIT_MS,
    parse(buf) {
      const parsed = parseCursorLogin(buf);
      if (!parsed) return null;
      return { agentType: 'cursor', phase: 'authorize', url: parsed.url };
    },
    error(buf) {
      const msg = deviceLoginError(buf);
      return msg === 'login failed' ? 'cursor login failed' : msg;
    },
    parseTimeoutMessage: 'cursor-agent did not print a sign-in URL — update Cursor on the host',
    timeoutMessage: 'cursor login timed out',
  },
};

interface LoginChild {
  child: ChildProcess;
  buf: string;
  agentType: LoginAgentType;
  lastEvent?: AgentsLoginEvent;
  finished: boolean;
  parseTimer: ReturnType<typeof setTimeout>;
  waitTimer: ReturnType<typeof setTimeout>;
}

export class LoginRunner {
  private login: LoginChild | undefined;

  constructor(private readonly opts: {
    emit: (ev: AgentsLoginEvent) => void;
    spawn?: typeof defaultSpawnLogin;
  }) {}

  get current(): { agentType: LoginAgentType; finished: boolean } | undefined {
    if (!this.login) return undefined;
    return { agentType: this.login.agentType, finished: this.login.finished };
  }

  /** Throws RpcError('login_busy' | 'not_installed' | 'not_supported'). Re-emits lastEvent on same-agent restart. */
  start(agentType: LoginAgentType): void {
    if (this.login && !this.login.finished) {
      if (this.login.agentType !== agentType) throw new RpcError('login_busy', agentType);
      if (this.login.lastEvent) this.opts.emit(this.login.lastEvent);
      return;
    }
    const spec = LOGIN_SPECS[agentType];
    if (!spec) throw new RpcError('not_supported', agentType);
    const bin = AGENT_BINARIES[agentType]?.bin;
    if (!bin || !binaryOnPath(bin)) throw new RpcError('not_installed', bin ?? agentType);
    this.startLogin(agentType);
  }

  submit(agentType: string, code: string | undefined): { submitted: true } {
    if (agentType !== 'claude-code') throw new RpcError('bad_request', 'submit is only implemented for claude-code');
    if (typeof code !== 'string' || !isClaudePasteCode(code)) {
      throw new RpcError('bad_request', 'malformed code');
    }
    const state = this.login;
    if (!state || state.finished || !state.lastEvent) throw new RpcError('no_login', agentType);
    state.child.stdin?.write(code + '\n');
    return { submitted: true };
  }

  cancel(agentType: string): void {
    const state = this.login;
    if (!state || state.finished) return;
    if (state.agentType !== agentType) return;
    killLoginChild(state.child);
    this.finishLogin(state, 'error', 'cancelled');
  }

  /** Kill the current login child (hub SIGTERM / test teardown). */
  dispose(): void {
    const state = this.login;
    if (!state || state.finished) return;
    this.cancel(state.agentType);
  }

  private startLogin(agentType: LoginAgentType): void {
    const spec = LOGIN_SPECS[agentType];
    if (!spec) throw new RpcError('not_supported', agentType);
    const child = (this.opts.spawn ?? defaultSpawnLogin)(spec.argv, agentType);
    // Prevent an EPIPE on a closed stdin from crashing the node daemon.
    child.stdin?.on('error', () => {});
    const state: LoginChild = {
      child,
      buf: '',
      agentType,
      finished: false,
      parseTimer: setTimeout(() => {
        if (state.finished || state.lastEvent) return;
        killLoginChild(child);
        this.finishLogin(state, 'error', spec.parseTimeoutMessage);
      }, spec.parseMs),
      waitTimer: setTimeout(() => {
        if (state.finished) return;
        killLoginChild(child);
        this.finishLogin(state, 'error', spec.timeoutMessage);
      }, spec.waitMs),
    };
    state.parseTimer.unref();
    state.waitTimer.unref();
    this.login = state;

    const onData = (chunk: Buffer | string): void => {
      if (state.finished) return;
      state.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (state.lastEvent) return;
      const abort = spec.abort?.(state.buf);
      if (abort) {
        killLoginChild(child);
        this.finishLogin(state, 'error', abort);
        return;
      }
      const ev = spec.parse(state.buf);
      if (!ev) return;
      state.lastEvent = ev;
      clearTimeout(state.parseTimer);
      this.opts.emit(ev);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const bin = AGENT_BINARIES[agentType]?.bin ?? agentType;
      const msg = code === 'ENOENT' ? `${bin} not found on PATH` : (err.message || spec.error(''));
      this.finishLogin(state, 'error', msg);
    });
    child.on('close', (code) => {
      if (state.finished) return;
      if (code === 0) this.finishLogin(state, 'done');
      else this.finishLogin(state, 'error', spec.error(state.buf));
    });
  }

  private finishLogin(state: LoginChild, phase: 'done' | 'error', message?: string): void {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.parseTimer);
    clearTimeout(state.waitTimer);
    const ev: AgentsLoginEvent = phase === 'done'
      ? { agentType: state.agentType, phase: 'done' }
      : { agentType: state.agentType, phase: 'error', message: message ?? 'login failed' };
    this.opts.emit(ev);
    if (this.login === state) this.login = undefined;
  }
}
