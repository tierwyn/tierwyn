/**
 * Lifecycle tests for CopilotAdapter. Injected spawnFn — never the real binary.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import type { NormalisedEvent } from '@tierwyn/shared';
import {
  CopilotAdapter,
  DENY_TOOLS,
  appendCopilotPromptOptionArgs,
  copilotSandboxAuthEnv,
  copilotAuthEnv,
} from './index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_UUID = '11111111-2222-4333-8444-555555555555';

function makeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const killed: string[] = [];
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null,
    pid: 4242,
    kill: (sig?: string) => { killed.push(sig ?? ''); },
    killed,
  });
}

type FakeChild = ReturnType<typeof makeChild>;

function makeAdapter(preloaded?: FakeChild, copilotHome?: string) {
  let child = preloaded ?? makeChild();
  const capturedArgs: string[][] = [];
  const capturedOpts: { cwd?: string }[] = [];
  const spawnFn = (_bin: string, args: string[], opts: { cwd?: string }) => {
    capturedArgs.push(args);
    capturedOpts.push(opts);
    return child as unknown as import('child_process').ChildProcess;
  };
  const adapter = new CopilotAdapter({ bin: 'copilot', copilotHome, spawnFn: spawnFn as never });
  return {
    adapter,
    get child() { return child; },
    capturedArgs,
    capturedOpts,
    replaceChild: (c: FakeChild) => { child = c; },
  };
}

/** Temp copilot home with a session-store.db that knows exactly `registered`. */
function makeCopilotHome(registered: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
  const db = new Database(join(home, 'session-store.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  for (const id of registered) db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
  db.close();
  return home;
}

function collect(adapter: CopilotAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

async function runTurn(
  adapter: CopilotAdapter,
  child: FakeChild,
  opts: { stdout?: string; stderr?: string; exitCode?: number } = {},
): Promise<NormalisedEvent[]> {
  const events = collect(adapter);
  const done = adapter.sendPrompt('ping');
  setImmediate(() => {
    if (opts.stdout) child.stdout.write(opts.stdout);
    if (opts.stderr) child.stderr.write(opts.stderr);
    child.stdout.end();
    child.emit('close', opts.exitCode ?? 0);
  });
  await done;
  return events;
}

function textTurnJsonl(): string {
  return readFileSync(join(FIXTURES, 'text-turn.v1.0.82.jsonl'), 'utf8');
}

describe('appendCopilotPromptOptionArgs', () => {
  // Order: mode → effort → tools policy → assisted-approval, after stream/model
  // flags and before invariant --no-ask-user (see sendPrompt).

  it('adds --mode plan', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(args, { mode: 'plan' }, { hasConcreteModel: true });
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
  });

  it('adds --effort high when hasConcreteModel', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(args, { effort: 'high' }, { hasConcreteModel: true });
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort when !hasConcreteModel', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(args, { effort: 'high' }, { hasConcreteModel: false });
    expect(args).not.toContain('--effort');
  });

  it('toolsPolicy readOnly omits --allow-all and adds view/grep/glob plus shell/write denies', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(args, { toolsPolicy: 'readOnly' }, { hasConcreteModel: true });
    expect(args).not.toContain('--allow-all');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).toContain('--available-tools');
    expect(args[args.indexOf('--available-tools') + 1]).toBe('view,grep,glob');
    expect(args).toContain('--deny-tool=shell(*)');
    expect(args).toContain('--deny-tool=write');
    for (const deny of DENY_TOOLS) {
      expect(args).toContain(`--deny-tool=${deny}`);
    }
  });

  it('toolsPolicy default (or absent) keeps --allow-all', () => {
    const absent: string[] = [];
    appendCopilotPromptOptionArgs(absent, undefined, { hasConcreteModel: true });
    expect(absent).toContain('--allow-all');
    expect(absent).not.toContain('--allow-all-tools');
    const explicit: string[] = [];
    appendCopilotPromptOptionArgs(explicit, { toolsPolicy: 'default' }, { hasConcreteModel: true });
    expect(explicit).toContain('--allow-all');
    expect(explicit).not.toContain('--allow-all-tools');
  });

  it('copilotSandboxAuthEnv passes the dedicated token and aliases GH_TOKEN', () => {
    expect(() => copilotSandboxAuthEnv('')).toThrow(/Copilot token/);
    expect(copilotSandboxAuthEnv(' tok ')).toEqual({
      COPILOT_GITHUB_TOKEN: 'tok', GH_TOKEN: 'tok', GITHUB_TOKEN: undefined,
    });
  });

  it('copilotAuthEnv aliases token to GH_TOKEN when present and returns undefined when absent', () => {
    expect(copilotAuthEnv(undefined)).toBeUndefined();
    expect(copilotAuthEnv('')).toBeUndefined();
    expect(copilotAuthEnv('  tok  ')).toEqual({
      COPILOT_GITHUB_TOKEN: 'tok', GH_TOKEN: 'tok',
    });
  });

  it('widens to --allow-all but keeps denies; readOnly stays read-only', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(args, undefined, { hasConcreteModel: true });
    expect(args).toContain('--allow-all');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).toContain('--deny-tool=shell(git push)');
    const ro: string[] = [];
    appendCopilotPromptOptionArgs(ro, { toolsPolicy: 'readOnly' }, { hasConcreteModel: true });
    expect(ro).not.toContain('--allow-all');
  });

  it('adds --assisted-approval when assistedApproval is true', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(args, { assistedApproval: true }, { hasConcreteModel: true });
    expect(args).toContain('--assisted-approval');
  });

  it('options.effort overrides ctx.activeEffort for this turn', () => {
    const args: string[] = [];
    appendCopilotPromptOptionArgs(
      args,
      { effort: 'low' },
      { hasConcreteModel: true, activeEffort: 'high' },
    );
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });
});

describe('CopilotAdapter — argv', () => {
  it('turn 1 uses --session-id <uuid> and not --resume', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    await runTurn(adapter, child, { stdout: textTurnJsonl() });
    const args = capturedArgs[0];
    const idx = args.indexOf('--session-id');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toMatch(UUID_RE);
    expect(args.some((a) => a === '--resume' || a.startsWith('--resume='))).toBe(false);
  });

  it('turn 2 uses --resume=<same uuid> and not --session-id', async () => {
    const { adapter, capturedArgs, replaceChild } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    const first = makeChild();
    replaceChild(first);
    await runTurn(adapter, first, { stdout: textTurnJsonl() });
    // Copilot echoes the session id on `result`; subsequent turns resume that id.
    const sid = adapter.nativeSessionId;
    expect(sid).toMatch(UUID_RE);

    const second = makeChild();
    replaceChild(second);
    await runTurn(adapter, second, { stdout: textTurnJsonl() });
    const args2 = capturedArgs[1];
    expect(args2).toContain(`--resume=${sid}`);
    expect(args2).not.toContain('--session-id');
  });

  it('always includes the security/stream flags and every DENY_TOOLS entry', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    await runTurn(adapter, child, { stdout: textTurnJsonl() });
    const args = capturedArgs[0];
    expect(args).toContain('--no-remote-export');
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--no-ask-user');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).toContain('--log-level');
    expect(args[args.indexOf('--log-level') + 1]).toBe('none');
    expect(args).toContain('--allow-all');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).toContain('--disable-builtin-mcps');
    expect(args).toContain('--stream');
    expect(args[args.indexOf('--stream') + 1]).toBe('on');
    for (const deny of DENY_TOOLS) {
      expect(args).toContain(`--deny-tool=${deny}`);
    }
  });

  it('passes -C <cwd> when cwd is set', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    await runTurn(adapter, child, { stdout: textTurnJsonl() });
    const args = capturedArgs[0];
    expect(args).toContain('-C');
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/fixture');
  });

  it('omits --model when model is auto or empty', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'auto' });
    await runTurn(adapter, child, { stdout: textTurnJsonl() });
    expect(capturedArgs[0]).not.toContain('--model');
  });

  it('passes --effort when provided', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    const done = adapter.sendPrompt('ping', [], undefined, 'high');
    setImmediate(() => {
      child.stdout.write(textTurnJsonl());
      child.stdout.end();
      child.emit('close', 0);
    });
    await done;
    expect(capturedArgs[0]).toContain('--effort');
    expect(capturedArgs[0][capturedArgs[0].indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort when the model is auto (auto router rejects effort config)', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'auto' });
    const done = adapter.sendPrompt('ping', [], undefined, 'high');
    setImmediate(() => {
      child.stdout.write(textTurnJsonl());
      child.stdout.end();
      child.emit('close', 0);
    });
    await done;
    expect(capturedArgs[0]).not.toContain('--effort');
    expect(capturedArgs[0]).not.toContain('--model');
  });

  it('passes --attachment and @path refs for image tempPath', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    const tempPath = '/tmp/fixture/shot.png';
    const done = adapter.sendPrompt('what is this', [{ mediaType: 'image/png', base64: 'iVBOR', tempPath }]);
    setImmediate(() => {
      child.stdout.end();
      child.emit('close', 0);
    });
    await done;
    const args = capturedArgs[0];
    expect(args).toContain('--attachment');
    expect(args[args.indexOf('--attachment') + 1]).toBe(tempPath);
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toContain(`@${tempPath}`);
  });

  it("sendPrompt captures --mode plan from prompt options after stream flags", async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'gpt-4.1' });
    const done = adapter.sendPrompt('hi', [], 'gpt-4.1', undefined, { mode: 'plan' });
    setImmediate(() => {
      child.stdout.write(textTurnJsonl());
      child.stdout.end();
      child.emit('close', 0);
    });
    await done;
    const args = capturedArgs[0];
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    const streamOnIdx = args.indexOf('--stream') >= 0 ? args.indexOf('--stream') + 1 : -1;
    const modeIdx = args.indexOf('--mode');
    const noAskIdx = args.indexOf('--no-ask-user');
    expect(streamOnIdx).toBeGreaterThan(-1);
    expect(args[streamOnIdx]).toBe('on');
    expect(modeIdx).toBeGreaterThan(streamOnIdx);
    expect(modeIdx).toBeLessThan(noAskIdx);
  });
});

describe('CopilotAdapter — session id', () => {
  it('replaces a non-UUID nativeSessionId with a fresh UUID (no --resume)', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({
      sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5',
      nativeSessionId: 'tierwyn-not-a-uuid',
    });
    await runTurn(adapter, child, { stdout: textTurnJsonl() });
    expect(adapter.nativeSessionId).toMatch(UUID_RE);
    expect(adapter.nativeSessionId).not.toBe('tierwyn-not-a-uuid');
    expect(capturedArgs[0]).toContain('--session-id');
    expect(capturedArgs[0].some((a) => a.startsWith('--resume='))).toBe(false);
  });

  it('uses --resume= on turn 1 only when the uuid is registered in session-store.db', async () => {
    const home = makeCopilotHome([KNOWN_UUID]);
    try {
      const { adapter, child, capturedArgs } = makeAdapter(undefined, home);
      await adapter.start({
        sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5',
        nativeSessionId: KNOWN_UUID,
      });
      await runTurn(adapter, child, { stdout: textTurnJsonl() });
      expect(capturedArgs[0]).toContain(`--resume=${KNOWN_UUID}`);
      expect(capturedArgs[0]).not.toContain('--session-id');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('mints a fresh --session-id when the uuid is valid but NOT registered (crashed-turn persistence)', async () => {
    const home = makeCopilotHome([]); // store exists, row does not
    try {
      const { adapter, child, capturedArgs } = makeAdapter(undefined, home);
      await adapter.start({
        sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5',
        nativeSessionId: KNOWN_UUID,
      });
      await runTurn(adapter, child, { stdout: textTurnJsonl() });
      expect(capturedArgs[0]).toContain('--session-id');
      expect(capturedArgs[0].some((a) => a.startsWith('--resume='))).toBe(false);
      expect(adapter.nativeSessionId).toMatch(UUID_RE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('after a crashed first turn, turn 2 starts fresh (--session-id, not --resume=)', async () => {
    const { adapter, child, capturedArgs, replaceChild } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    await runTurn(adapter, child, { stderr: 'boom\n', exitCode: 1 });
    const second = makeChild();
    replaceChild(second);
    await runTurn(adapter, second, { stdout: textTurnJsonl() });
    expect(capturedArgs[1].some((a) => a.startsWith('--resume='))).toBe(false);
    expect(capturedArgs[1]).toContain('--session-id');
  });

  it('picks up sessionId from the result frame', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    await runTurn(adapter, child, { stdout: textTurnJsonl() });
    expect(adapter.nativeSessionId).toBe('cbc05391-873b-4505-bc83-c7e891be1740');
  });
});

describe('CopilotAdapter — error paths', () => {
  it('exit 1 with stderr text → error + status:error (not a silent done)', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'no-such-model' });
    const stderr = readFileSync(join(FIXTURES, 'bad-model.stderr.txt'), 'utf8');
    const events = await runTurn(adapter, child, { stderr, exitCode: 1 });
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.payload.message).toMatch(/code 1/);
    expect(err?.type === 'error' && err.payload.message).toMatch(/no-such-model/);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last?.type === 'status' && last.payload.status).toBe('error');
  });

  it('close with zero emitted content → error + status:error (zero-output guard)', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    const events = await runTurn(adapter, child, { stdout: '', exitCode: 0 });
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.payload.message).toMatch(/no output/i);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last?.type === 'status' && last.payload.status).toBe('error');
  });

  it('spawn error → error + status:error', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    const events = collect(adapter);
    const done = adapter.sendPrompt('ping');
    setImmediate(() => {
      child.emit('error', new Error('spawn copilot ENOENT'));
    });
    await done;
    expect(events.some((e) => e.type === 'error' && e.payload.message.includes('ENOENT'))).toBe(true);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last?.type === 'status' && last.payload.status).toBe('error');
  });

  it('denied-tool fixture is a completed turn (status:done), not a turn-level error', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    const stdout = readFileSync(join(FIXTURES, 'denied-tool.jsonl'), 'utf8');
    const events = await runTurn(adapter, child, { stdout, exitCode: 0 });
    expect(events.some((e) => e.type === 'tool_result' && e.payload.isError === true)).toBe(true);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last?.type === 'status' && last.payload.status).toBe('done');
  });
});

describe('CopilotAdapter — stop / native session', () => {
  it('stop() kills SIGTERM and emits status:idle then end', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/fixture', model: 'claude-sonnet-5' });
    adapter.sendPrompt('in flight').catch(() => {});
    const ended = new Promise<void>((resolve) => adapter.streamEvents().once('end', () => resolve()));
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
    await adapter.stop();
    await ended;
    expect(child.killed).toContain('SIGTERM');
    const idle = events.find((e) => e.type === 'status' && e.payload.status === 'idle');
    expect(idle).toBeDefined();
  });

  it('isNativeSessionAvailable consults session-store.db, not the session-state dir', async () => {
    const home = makeCopilotHome([KNOWN_UUID]);
    try {
      // A crashed turn leaves a session-state dir with no store row.
      mkdirSync(join(home, 'session-state', 'f8a3ba39-1111-4222-8333-444444444444'), { recursive: true });
      const adapter = new CopilotAdapter({ bin: 'copilot', copilotHome: home, spawnFn: (() => makeChild()) as never });
      expect(await adapter.isNativeSessionAvailable(KNOWN_UUID)).toBe(true);
      // dir-only id must NOT count as resumable
      expect(await adapter.isNativeSessionAvailable('f8a3ba39-1111-4222-8333-444444444444')).toBe(false);
      expect(await adapter.isNativeSessionAvailable('missing-id')).toBe(false);
      expect(await adapter.isNativeSessionAvailable('')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('isNativeSessionAvailable is false when session-store.db does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
    try {
      const adapter = new CopilotAdapter({ bin: 'copilot', copilotHome: home, spawnFn: (() => makeChild()) as never });
      expect(await adapter.isNativeSessionAvailable(KNOWN_UUID)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('listModels returns []', async () => {
    const adapter = new CopilotAdapter({ bin: 'copilot', spawnFn: (() => makeChild()) as never });
    expect(await adapter.listModels()).toEqual([]);
  });

  it('listSessions returns []', async () => {
    const adapter = new CopilotAdapter({ bin: 'copilot', spawnFn: (() => makeChild()) as never });
    expect(await adapter.listSessions()).toEqual([]);
  });
});
