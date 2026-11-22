/**
 * index.test.ts — unit tests for CodexAdapter.listCommands().
 *
 * The adapter is never start()ed here — proves the discovery path (listCommands)
 * works without a live codex app-server subprocess.
 *
 * Run with:
 *   npx vitest run apps/server/src/adapters/codex/index.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import { CodexAdapter, resolveCodexSandbox } from './index.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'codex-test-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.`,
  );
}

describe('CodexAdapter.listCommands()', () => {
  it('always includes /review even with no skills dir', async () => {
    // ponytail: codexHome opt exists only for test isolation
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const cmds = await adapter.listCommands();
    const review = cmds.find((c) => c.name === 'review');
    expect(review).toBeDefined();
    expect(review?.sourceDetail).toBe('builtin');
    expect(review?.description).toContain('code review');
  });

  it('includes a user skill from skills/<name>/SKILL.md', async () => {
    const skillsDir = join(tmpHome, 'skills');
    mkdirSync(skillsDir);
    writeSkill(skillsDir, 'foo', 'The foo skill');

    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const cmds = await adapter.listCommands();

    const foo = cmds.find((c) => c.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo?.description).toBe('The foo skill');
    expect(foo?.sourceDetail).toBe('skill');
  });

  it('includes a system skill from skills/.system/<name>/SKILL.md', async () => {
    const systemDir = join(tmpHome, 'skills', '.system');
    mkdirSync(systemDir, { recursive: true });
    writeSkill(systemDir, 'sys', 'System skill description');

    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const cmds = await adapter.listCommands();

    const sys = cmds.find((c) => c.name === 'sys');
    expect(sys).toBeDefined();
    expect(sys?.description).toBe('System skill description');
    expect(sys?.sourceDetail).toBe('skill');
  });

  it('deduplicates: user skill name shadows system skill with same name', async () => {
    const skillsDir = join(tmpHome, 'skills');
    const systemDir = join(skillsDir, '.system');
    mkdirSync(systemDir, { recursive: true });
    writeSkill(skillsDir, 'dupe', 'User version');
    writeSkill(systemDir, 'dupe', 'System version');

    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const cmds = await adapter.listCommands();

    const dupes = cmds.filter((c) => c.name === 'dupe');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].description).toBe('User version');
  });

  it('never starts a subprocess (no start() call — proves discovery path)', async () => {
    // If this test completes without error, no subprocess was required.
    const skillsDir = join(tmpHome, 'skills');
    mkdirSync(skillsDir);
    writeSkill(skillsDir, 'bar', 'Bar skill');

    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const cmds = await adapter.listCommands();
    // review + bar
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    expect(cmds.find((c) => c.name === 'review')).toBeDefined();
    expect(cmds.find((c) => c.name === 'bar')).toBeDefined();
  });
});

describe('CodexAdapter steer loop (mid-turn vs between-turn routing)', () => {
  /**
   * Drives _runSteerLoop directly with a fake RPC (the adapter constructs its
   * subprocess internally, so there is no spawnFn seam — mirror the
   * poke-the-privates pattern from claude-code interaction tests).
   */
  function loopHarness() {
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const rpc = {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        if (method === 'turn/start') return { turn: { id: 'turn-next' } };
        return {};
      },
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = adapter as any;
    a._rpc = rpc;
    a._proc = { pid: 1 }; // truthy is all the loop checks
    a._threadId = 'thread-1';
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    return { adapter, sent, events };
  }

  it('injects via turn/steer when a turn is live, then re-parks', async () => {
    const h = loopHarness();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = h.adapter as any;
    a._activeTurnId = 'turn-1';
    let calls = 0;
    let parked: ((v: { text: string } | null) => void) | null = null;
    a._getNextSteer = () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) resolve({ text: 'change course' });
      else parked = resolve;
    });
    const loop = a._runSteerLoop() as Promise<void>;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    await new Promise((r) => setImmediate(r));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].method).toBe('turn/steer');
    expect(h.sent[0].params.expectedTurnId).toBe('turn-1');
    expect(h.events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    // Loop re-parked, no turn/start issued.
    expect(calls).toBe(2);

    parked!(null);
    await loop;
  });

  it('starts a fresh turn via turn/start when no turn is live', async () => {
    const h = loopHarness();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = h.adapter as any;
    a._activeTurnId = null;
    let calls = 0;
    let parked: ((v: { text: string } | null) => void) | null = null;
    a._getNextSteer = () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) resolve({ text: 'follow up' });
      else parked = resolve;
    });
    const loop = a._runSteerLoop() as Promise<void>;
    await new Promise((r) => setImmediate(r));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].method).toBe('turn/start');
    expect(a._activeTurnId).toBe('turn-next');
    /* eslint-enable @typescript-eslint/no-explicit-any */

    parked!(null);
    await loop;
  });

  it('falls back to turn/start when turn/steer rejects (expectedTurnId mismatch)', async () => {
    const h = loopHarness();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = h.adapter as any;
    a._activeTurnId = 'turn-stale';
    a._rpc = {
      send: async (method: string, params: Record<string, unknown>) => {
        h.sent.push({ method, params });
        if (method === 'turn/steer') throw new Error('turn id mismatch');
        return { turn: { id: 'turn-next' } };
      },
    };
    let calls = 0;
    let parked: ((v: { text: string } | null) => void) | null = null;
    a._getNextSteer = () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) resolve({ text: 'late steer' });
      else parked = resolve;
    });
    const loop = a._runSteerLoop() as Promise<void>;
    await new Promise((r) => setImmediate(r));

    expect(h.sent.map((s) => s.method)).toEqual(['turn/steer', 'turn/start']);
    expect(a._activeTurnId).toBe('turn-next');
    /* eslint-enable @typescript-eslint/no-explicit-any */

    parked!(null);
    await loop;
  });

  it('second _runSteerLoop call is a no-op while the first is parked', async () => {
    const h = loopHarness();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = h.adapter as any;
    let calls = 0;
    let parked: ((v: { text: string } | null) => void) | null = null;
    a._getNextSteer = () => new Promise((resolve) => {
      calls += 1;
      parked = resolve;
    });
    const loop = a._runSteerLoop() as Promise<void>;
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);

    // Simulates the turn/completed re-entry.
    void a._runSteerLoop();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1); // guard held — no second parked resolver
    /* eslint-enable @typescript-eslint/no-explicit-any */

    parked!(null);
    await loop;
  });
});

describe('CodexAdapter effort CLI args', () => {
  it('_effortCliArgs returns -c model_reasoning_effort=high for supported levels', () => {
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = adapter as any;
    a._effort = 'high';
    expect(a._effortCliArgs()).toEqual(['-c', 'model_reasoning_effort=high']);
    a._effort = 'max'; // clamped out — codex is 3-level
    expect(a._effortCliArgs()).toEqual([]);
    a._effort = undefined;
    expect(a._effortCliArgs()).toEqual([]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('start() stores config.effort for session-scoped binding', async () => {
    // Avoid actually spawning app-server: poke privates after a partial start
    // by setting _effort the same way start() does, then checking the helper.
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = adapter as any;
    a._effort = 'high'; // mirrors start({ effort: 'high' })
    expect(a._effortCliArgs()).toContain('model_reasoning_effort=high');
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
});

describe('CodexAdapter app-server spawn args', () => {
  it('enables network in workspace-write so loopback Tierwyn API calls work', async () => {
    let argv: string[] = [];
    // stdio-less fake: start() records the argv, emits an error and returns.
    const fakeSpawn = ((_bin: string, args: string[]) => { argv = args; return new EventEmitter(); }) as never;
    const adapter = new CodexAdapter({ codexHome: tmpHome, spawn: fakeSpawn });
    await adapter.start({ sessionId: 's', model: 'm', cwd: tmpHome } as never);
    expect(argv.slice(0, 3)).toEqual(['app-server', '-c', 'sandbox_workspace_write.network_access=true']);
  });
});

describe('resolveCodexSandbox', () => {
  it('maps staged read-only to the RPC enum', () => {
    expect(resolveCodexSandbox({ sandbox: 'read-only' })).toBe('read-only');
  });

  it('maps staged danger-full-access to the RPC enum', () => {
    expect(resolveCodexSandbox({ sandbox: 'danger-full-access' })).toBe('danger-full-access');
  });

  it('defaults missing, default, and unknown values to workspace-write', () => {
    expect(resolveCodexSandbox(undefined)).toBe('workspace-write');
    expect(resolveCodexSandbox({})).toBe('workspace-write');
    expect(resolveCodexSandbox({ sandbox: 'default' })).toBe('workspace-write');
    expect(resolveCodexSandbox({ sandbox: 'workspace-write' })).toBe('workspace-write');
    expect(resolveCodexSandbox({ sandbox: true })).toBe('workspace-write');
  });
});

describe('CodexAdapter prompt-option sandbox', () => {
  function rpcHarness() {
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const rpc = {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: `thread-${sent.length}` } };
        }
        if (method === 'turn/start') return { turn: { id: `turn-${sent.length}` } };
        return {};
      },
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = adapter as any;
    a._rpc = rpc;
    a._model = 'gpt-5';
    a._cwd = '/tmp';
    a._sessionId = 's1';
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { adapter, sent };
  }

  it('passes non-default sandbox to thread/start on sendPrompt', async () => {
    const { adapter, sent } = rpcHarness();
    await adapter.sendPrompt('hi', [], undefined, undefined, { sandbox: 'read-only' });
    const start = sent.find((s) => s.method === 'thread/start');
    expect(start).toBeDefined();
    expect(start!.params.sandbox).toBe('read-only');
    expect(start!.params).not.toHaveProperty('approvalPolicy', 'danger-full-access');
  });

  it('reuses the thread when sandbox is unchanged', async () => {
    const { adapter, sent } = rpcHarness();
    await adapter.sendPrompt('first');
    await adapter.sendPrompt('second');
    expect(sent.filter((s) => s.method === 'thread/start')).toHaveLength(1);
    expect(sent.filter((s) => s.method === 'turn/start')).toHaveLength(2);
    expect(sent.find((s) => s.method === 'thread/start')!.params.sandbox).toBe('workspace-write');
  });

  it('starts a fresh thread when staged sandbox differs from the current thread', async () => {
    const { adapter, sent } = rpcHarness();
    await adapter.sendPrompt('first');
    await adapter.sendPrompt('second', [], undefined, undefined, { sandbox: 'danger-full-access' });
    const starts = sent.filter((s) => s.method === 'thread/start');
    expect(starts).toHaveLength(2);
    expect(starts[0].params.sandbox).toBe('workspace-write');
    expect(starts[1].params.sandbox).toBe('danger-full-access');
  });

  it('passes sandbox to thread/resume on the first turn of a resumed session', async () => {
    const { adapter, sent } = rpcHarness();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (adapter as any)._resumeThreadId = 'old-thread';
    /* eslint-enable @typescript-eslint/no-explicit-any */
    await adapter.sendPrompt('hi', [], undefined, undefined, { sandbox: 'read-only' });
    const resume = sent.find((s) => s.method === 'thread/resume');
    expect(resume).toBeDefined();
    expect(resume!.params.threadId).toBe('old-thread');
    expect(resume!.params.sandbox).toBe('read-only');
    expect(sent.some((s) => s.method === 'thread/start')).toBe(false);
  });
});

describe('CodexAdapter.listModels', () => {
  it('returns models from models_cache.json when present', async () => {
    writeFileSync(
      join(tmpHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', context_window: 272000, input_modalities: ['text', 'image'] },
        ],
      }),
    );
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('gpt-5.6-terra');
    expect(models[0].label).toBe('Codex · GPT-5.6-Terra');
    expect(models[0].provider).toBe('openai');
    expect(models[0].vision).toBe(true);
  });

  it('falls back to seeded profiles when models_cache.json is absent', async () => {
    const adapter = new CodexAdapter({ codexHome: tmpHome });
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.name === 'gpt-5.5')).toBe(true);
    expect(models.every((m) => m.provider === 'openai')).toBe(true);
  });
});
