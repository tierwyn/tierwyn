import { EventEmitter } from 'events';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { promisify } from 'util';
import { randomUUID, createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor,
  EffortLevel, PromptOptions,
} from '@tierwyn/shared';
import { contextWindowOccupancy, computeContextWindowPct } from '@tierwyn/shared';
import { withImagePathRefs } from '../../imageHelper.js';
import { capForArgvSpawn } from '../../compaction/primingCap.js';
import { safeNativeSessionId } from '../sessionId.js';

const execFileDefault = promisify(execFile);

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;
// ponytail: injectable for tests; matches promisify(execFile) return shape
type ExecFileFn = (bin: string, args: string[], opts: { timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr?: string }>;

// `openclaw agent`'s `--cwd`/`--dir` flag does not exist — spawning the CLI
// with { cwd } only changes the *subprocess's* directory; the embedded agent's
// file/exec tools are scoped to its configured *agent workspace* (`openclaw
// agents list --json` → .workspace), which defaults to the global 'main'
// agent regardless of subprocess cwd (verified empirically: `pwd` inside a
// run always reported ~/.openclaw/workspace). Fix: register one isolated
// OpenClaw agent per Tierwyn project cwd (`openclaw agents add <id> --workspace
// <cwd>`) and pass `--agent <id>` so the run's tools operate on the right
// directory. Id is a deterministic hash of the cwd so repeat turns/sessions
// for the same project reuse the same isolated agent.
const _ensuredAgentIds = new Set<string>(); // ponytail: per-process cache, skips a redundant `agents add` spawn every turn; a restart just re-probes once per cwd (idempotent — "already exists" is treated as success)

// Changing the prefix orphans existing per-project OpenClaw agents (config and memory).
function agentIdForCwd(cwd: string): string {
  return `tierwyn-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`;
}

const OPENCLAW_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'max']);
const OPENCLAW_TIMEOUT = new Set(['120', '300', '600', '1800']);

/** Append per-turn OpenClaw prompt-option flags after `-m` and before `--agent`/`--model`. */
export function appendOpenClawPromptOptionArgs(args: string[], options?: PromptOptions | null): void {
  if (!options) return;
  const thinking = options['thinking'];
  if (typeof thinking === 'string' && OPENCLAW_THINKING.has(thinking)) {
    args.push('--thinking', thinking);
  }
  const timeout = options['timeout'];
  if (typeof timeout === 'string' && OPENCLAW_TIMEOUT.has(timeout)) {
    args.push('--timeout', timeout);
  }
}

export class OpenClawAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _child: ChildProcess | null = null;
  private _sessionId = '';
  private _nativeSessionId = '';   // openclaw --session-id (stable across turns)
  private _model = '';
  private _cwd = '';
  private _agentId = '';
  private _seq = 0;
  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private readonly _execFileFn: ExecFileFn;

  constructor(opts: { spawn?: SpawnFn; spawnFn?: SpawnFn; execFileFn?: ExecFileFn; bin?: string } = {}) {
    this._bin = opts.bin ?? 'openclaw';
    const inner = opts.spawn ?? opts.spawnFn ?? spawn;
    this._spawn = (c, a, o) => inner(c, a, { ...o, stdio: ['ignore', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'openclaw') });
    this._spawnFn = this._spawn;
    this._execFileFn = opts.execFileFn ?? execFileDefault;
  }

  streamEvents(): EventEmitter { return this._emitter; }

  private _emit(e: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    this._emitter.emit('event', {
      ...e,
      sessionId: this._sessionId,
      seq: ++this._seq,
      ts: Date.now(),
    } as NormalisedEvent);
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._model = config.model;
    this._cwd = config.cwd ?? '';
    this._seq = 0;
    // Reuse a provided native session id (resume path), else mint a new stable one.
    this._nativeSessionId = safeNativeSessionId(config.nativeSessionId) || `tierwyn-${randomUUID()}`;

    this._agentId = '';
    if (this._cwd) {
      const id = agentIdForCwd(this._cwd);
      if (_ensuredAgentIds.has(id) || (await this._ensureAgent(id, this._cwd))) {
        _ensuredAgentIds.add(id);
        this._agentId = id;
      }
      // else: leave _agentId unset — sendPrompt omits --agent and OpenClaw
      // falls back to its default 'main' workspace (old behaviour, not worse).
    }
  }

  private async _ensureAgent(id: string, cwd: string): Promise<boolean> {
    try {
      await this._execFileFn(
        this._bin,
        ['agents', 'add', id, '--workspace', cwd, '--non-interactive', '--json'],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return true;
    } catch (e) {
      // "already exists" (exit 1, no JSON) is the common case after the first
      // turn for a project — treat as success. Anything else (CLI missing,
      // timeout) is a soft failure, matching listModels/listSessions.
      const msg = (e as { stderr?: string; message?: string })?.stderr ?? (e as Error).message ?? '';
      return /already exists/i.test(msg);
    }
  }

  async sendPrompt(
    text: string,
    attachments: Attachment[] = [],
    model?: string,
    _effort?: EffortLevel,
    options?: PromptOptions,
  ): Promise<void> {
    // ponytail: no native image flag; @<tempPath> lets the model Read the file
    this._emit({ type: 'status', payload: { status: 'running' } });
    const activeModel = model ?? this._model;

    // One subprocess per turn. Same --session-id across turns → openclaw resumes
    // context from ~/.openclaw/agents/<agentId>/sessions/<id>.jsonl automatically
    // (agentId is 'main' unless _agentId below scopes it to this project's cwd).
    // Prompt options sit after base flags (-m) and before --agent/--model.
    const args = ['agent', '--local', '--json', '--session-id', this._nativeSessionId, '-m', capForArgvSpawn(withImagePathRefs(text, attachments))];
    appendOpenClawPromptOptionArgs(args, options);
    if (this._agentId) args.push('--agent', this._agentId);
    if (activeModel) args.push('--model', activeModel);

    const child = this._spawnFn(this._bin, args, { cwd: this._cwd || undefined });
    this._child = child;

    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d; });
    // openclaw writes config/plugin warnings to stderr — keep for fallback error text only
    child.stderr?.on('data', (d: Buffer) => { err += d; });

    return new Promise<void>((resolve) => {
      child.on('error', (e: Error) => { this._fail(e.message); resolve(); });
      child.on('close', (code: number | null) => {
        if (code !== 0 && code !== null) {
          const lastErr = err.trim().split('\n').pop() ?? '';
          this._fail(`openclaw exited with code ${code}${lastErr ? `: ${lastErr}` : ''}`);
          resolve();
          return;
        }
        this._consumeResult(out, err);
        resolve();
      });
    });
  }

  private _consumeResult(out: string, err: string): void {
    let json: unknown;
    try {
      json = JSON.parse(out.trim());
    } catch {
      const lastErr = err.trim().split('\n').pop() ?? '';
      this._fail(`openclaw returned non-JSON output${lastErr ? `: ${lastErr}` : ''}`);
      return;
    }

    const data = json as Record<string, unknown>;
    const meta = (data.meta ?? {}) as Record<string, unknown>;
    const am = (meta.agentMeta ?? {}) as Record<string, unknown>;

    if (meta.aborted) {
      this._fail('openclaw run aborted');
      return;
    }

    const textOut = (meta.finalAssistantVisibleText as string | undefined)
      ?? (Array.isArray(data.payloads)
        ? (data.payloads as { text?: string }[]).map((p) => p.text ?? '').join('')
        : '');

    const u = (am.usage ?? {}) as Record<string, number | undefined>;
    const occ = contextWindowOccupancy({ inputTokens: u.input, cacheReadTokens: u.cacheRead });
    const ctxPct = computeContextWindowPct(occ, am.contextTokens as number | undefined);
    const sid = safeNativeSessionId(am.sessionId);
    if (sid) this._nativeSessionId = sid;

    if (textOut) this._emit({ type: 'message', payload: { chunk: textOut, final: true } });
    this._emit({
      type: 'status',
      payload: {
        status: 'done',
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        contextWindowPct: ctxPct,
      },
    });
  }

  private _fail(message: string): void {
    this._emit({ type: 'error', payload: { message } });
    this._emit({ type: 'status', payload: { status: 'error' } });
  }

  async stop(): Promise<void> {
    try {
      this._child?.kill('SIGTERM');
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } finally {
      this._child = null;
      this._emitter.emit('end');
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const { stdout } = await this._execFileFn(
        this._bin, ['models', 'list', '--json'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const data = JSON.parse(stdout) as Record<string, unknown>;
      return ((data.models ?? []) as Record<string, unknown>[])
        .filter((m) => m.available !== false && m.missing !== true)
        .map((m) => ({
          name: m.key as string,
          label: `OpenClaw · ${(m.name as string | undefined) ?? (m.key as string)}`,
          provider: ((m.key as string | undefined) ?? '').split('/')[0] || undefined,
          vision: typeof m.input === 'string' ? (m.input as string).includes('image') : false,
          steer: false,
          contextWindow: m.contextWindow as number | undefined,
        }));
    } catch {
      return []; // ponytail: CLI missing/slow → empty; seed profiles cover the UI
    }
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    try {
      const { stdout } = await this._execFileFn(
        this._bin, ['sessions', '--json', '--limit', '100'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const data = JSON.parse(stdout) as Record<string, unknown>;
      return ((data.sessions ?? []) as Record<string, unknown>[]).map((s) => ({
        id: s.sessionId as string,
        summary: (s.key as string | undefined) ?? (s.sessionId as string),
        createdAt: s.updatedAt as number | undefined,
      }));
    } catch {
      return [];
    }
  }

  async loadSession(id: string): Promise<void> {
    this._nativeSessionId = safeNativeSessionId(id) ?? this._nativeSessionId;
  }

  // Same pattern as pi/antigravity: stat the on-disk session file so the UI's
  // "resumable" pill reflects reality instead of always reading false (the
  // default when this method is absent — see index.ts's `adapter.isNativeSessionAvailable?.()`).
  // Sessions live under a per-agent dir (~/.openclaw/agents/<agentId>/sessions/)
  // and this method is called on a fresh adapter with no cwd/_agentId context
  // (see GET /conversations/:id/active-agent), so scan every registered agent
  // rather than assuming 'main'.
  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    const agentsDir = join(homedir(), '.openclaw', 'agents');
    try {
      return readdirSync(agentsDir).some((agentId) =>
        existsSync(join(agentsDir, agentId, 'sessions', `${nativeSessionId}.jsonl`)));
    } catch {
      return false;
    }
  }

  get nativeSessionId(): string { return this._nativeSessionId; }
}
