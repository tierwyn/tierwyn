import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerStdioAdapters } from '../adapters/registerAll.js';
import {
  AgentsCliError, NODE_AGENT_TYPES, applyAgentChange, collectStatus, parseAgentList, renderStatus,
  restartStep, runAgentsCommand, validateAgents, type Exec,
} from './agentsCli.js';

const dirs: string[] = [];
function tmp(start: Record<string, unknown> | null = { hostId: 'h', hubUrl: 'https://hub.x', allowedAgents: ['cursor'], custom: 1 }): string {
  const d = mkdtempSync(join(tmpdir(), 'rh-ac-'));
  dirs.push(d);
  if (start) writeFileSync(join(d, 'node.json'), JSON.stringify(start, null, 2) + '\n');
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const code = (fn: () => unknown): number | undefined => {
  try { fn(); } catch (e) { return (e as AgentsCliError).code; }
  return undefined;
};
const msg = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  return '';
};
const read = (d: string) => JSON.parse(readFileSync(join(d, 'node.json'), 'utf8'));

describe('names + validation', () => {
  it('NODE_AGENT_TYPES matches the stdio registry and excludes grok-bot', () => {
    const t: string[] = [];
    registerStdioAdapters({ register: (x: string) => { t.push(x); } }, () => 'bypass');
    expect([...NODE_AGENT_TYPES]).toEqual([...new Set(t)].sort());
    expect(NODE_AGENT_TYPES).not.toContain('grok-bot');
    expect(NODE_AGENT_TYPES.length).toBeGreaterThanOrEqual(15);
  });
  it('NODE_AGENT_TYPES matches display names minus grok-bot', async () => {
    const { AGENT_DISPLAY_NAMES } = await import('@tierwyn/shared');
    expect([...NODE_AGENT_TYPES]).toEqual(
      Object.keys(AGENT_DISPLAY_NAMES).filter((t) => t !== 'grok-bot').sort(),
    );
  });
  it('parseAgentList', () => {
    expect(parseAgentList(['claude-code,codex', ' Cursor ', 'a,,'])).toEqual(['a', 'claude-code', 'codex', 'cursor']);
  });
  it('unknown name suggests + lists known', () => {
    const f = () => validateAgents(['codx'], 'allow');
    expect(code(f)).toBe(2);
    expect(msg(f)).toContain('unknown agent "codx"');
    expect(msg(f)).toContain('did you mean codex?');
    expect(msg(f)).toContain('known: ' + NODE_AGENT_TYPES.join(', '));
  });
  it('reports all unknowns at once', () => {
    const m = msg(() => validateAgents(['zzzzzz', 'qqqqqq'], 'allow'));
    expect(m).toContain('"zzzzzz"');
    expect(m).toContain('"qqqqqq"');
  });
  it('grok-bot refused on allow/enroll, no-op on disallow', () => {
    for (const op of ['allow', 'enroll'] as const) {
      expect(code(() => validateAgents(['grok-bot'], op))).toBe(2);
      expect(msg(() => validateAgents(['grok-bot'], op))).toContain('grok-bot cannot run on a remote host');
    }
    expect(() => validateAgents(['grok-bot'], 'disallow')).not.toThrow();
  });
  it('empty is a usage error', () => {
    expect(code(() => validateAgents([], 'allow'))).toBe(2);
  });
  it('disallow accepts hand-added junk only when present', () => {
    expect(() => validateAgents(['foo'], 'disallow', ['foo'])).not.toThrow();
    expect(code(() => validateAgents(['foo'], 'disallow', []))).toBe(2);
  });
});

describe('applyAgentChange', () => {
  it('allow unions, sorts, 0600, keeps unknown keys', () => {
    const d = tmp();
    const r = applyAgentChange({ dir: d, op: 'allow', names: ['codex', 'claude-code'] });
    expect(r).toEqual({ changed: true, list: ['claude-code', 'codex', 'cursor'], added: ['codex', 'claude-code'], removed: [], unchanged: [] });
    expect(read(d).allowedAgents).toEqual(['claude-code', 'codex', 'cursor']);
    expect(read(d).custom).toBe(1);
    expect(statSync(join(d, 'node.json')).mode & 0o777).toBe(0o600);
  });
  it('already allowed → unchanged; disallow absent → unchanged', () => {
    const d = tmp();
    expect(applyAgentChange({ dir: d, op: 'allow', names: ['cursor'] }).unchanged).toEqual(['cursor']);
    const r = applyAgentChange({ dir: d, op: 'disallow', names: ['codex'] });
    expect(r.unchanged).toEqual(['codex']);
    expect(r.changed).toBe(false);
  });
  it('disallow removes; --all clears / fills keeping junk', () => {
    const d = tmp({ hostId: 'h', allowedAgents: ['cursor', 'foo'] });
    expect(applyAgentChange({ dir: d, op: 'allow', names: [], all: true }).list).toEqual([...new Set([...NODE_AGENT_TYPES, 'foo'])].sort());
    expect(applyAgentChange({ dir: d, op: 'disallow', names: [], all: true }).list).toEqual([]);
  });
  it('mixed-case hand-added entry is removable (M1)', () => {
    const d = tmp({ hostId: 'h', allowedAgents: ['Foo', 'cursor'] });
    const r = applyAgentChange({ dir: d, op: 'disallow', names: ['foo'] });
    expect(r.list).toEqual(['cursor']);
    expect(read(d).allowedAgents).toEqual(['cursor']);
  });
  it('allow adds exact-case name even if a case variant exists (N1)', () => {
    const d = tmp({ hostId: 'h', allowedAgents: ['Codex'] });
    const r = applyAgentChange({ dir: d, op: 'allow', names: ['codex'] });
    expect(r.added).toEqual(['codex']);
    expect(read(d).allowedAgents).toContain('codex');
  });
  it('hand-added foo survives allow and is removable', () => {
    const d = tmp({ hostId: 'h', allowedAgents: ['foo'] });
    expect(applyAgentChange({ dir: d, op: 'allow', names: ['codex'] }).list).toEqual(['codex', 'foo']);
    expect(applyAgentChange({ dir: d, op: 'disallow', names: ['foo'] }).list).toEqual(['codex']);
  });
  it('no change leaves file untouched', () => {
    const d = tmp();
    const p = join(d, 'node.json');
    utimesSync(p, 1000, 1000);
    const before = [readFileSync(p, 'utf8'), statSync(p).mtimeMs];
    expect(applyAgentChange({ dir: d, op: 'allow', names: ['cursor'] }).changed).toBe(false);
    expect([readFileSync(p, 'utf8'), statSync(p).mtimeMs]).toEqual(before);
  });
  it('not enrolled → 2', () => {
    expect(code(() => applyAgentChange({ dir: tmp(null), op: 'allow', names: ['codex'] }))).toBe(2);
    expect(msg(() => applyAgentChange({ dir: tmp({ hostId: '' }), op: 'allow', names: ['codex'] }))).toBe('not enrolled');
  });
  it('invalid JSON → 1, untouched', () => {
    const d = tmp(null);
    writeFileSync(join(d, 'node.json'), '{nope');
    const f = () => applyAgentChange({ dir: d, op: 'allow', names: ['codex'] });
    expect(code(f)).toBe(1);
    expect(msg(f)).toBe('node.json is not valid JSON — fix it by hand');
    expect(readFileSync(join(d, 'node.json'), 'utf8')).toBe('{nope');
  });
  it('validation errors throw 2 before any write', () => {
    const d = tmp();
    const before = readFileSync(join(d, 'node.json'), 'utf8');
    expect(code(() => applyAgentChange({ dir: d, op: 'allow', names: ['codx'] }))).toBe(2);
    expect(code(() => applyAgentChange({ dir: d, op: 'allow', names: ['grok-bot'] }))).toBe(2);
    expect(readFileSync(join(d, 'node.json'), 'utf8')).toBe(before);
  });
});

function fakeExec(map: Record<string, { status: number; stdout: string } | 'enoent'>) {
  const calls: Array<[string, string[]]> = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, args]);
    return map[args[1]] ?? { status: 0, stdout: '' };
  };
  return { exec, calls };
}

describe('restartStep', () => {
  it('noRestart', () => {
    const f = fakeExec({}); const log: string[] = [];
    expect(restartStep(f.exec, true, (s) => log.push(s))).toBe(0);
    expect(f.calls).toEqual([]);
    expect(log).toEqual(['change applies on next restart (tierwyn node restart)']);
  });
  it('active → warns then restarts', () => {
    const f = fakeExec({ 'is-active': { status: 0, stdout: 'active\n' } }); const log: string[] = [];
    expect(restartStep(f.exec, false, (s) => { log.push(s); f.calls.push(['LOG', [s]]); })).toBe(0);
    const names = f.calls.map((c) => c[0] === 'LOG' ? 'LOG:' + c[1][0].slice(0, 10) : c[1][1]);
    expect(names.filter((n) => n !== 'cat')).toEqual(['is-active', 'LOG:restarting', 'restart', 'LOG:restarted ']);
    expect(f.calls.some((c) => c[1][1] === 'is-active' && c[1][2] === 'tierwyn-node.service')).toBe(true);
    expect(f.calls.some((c) => c[1][1] === 'restart' && c[1][2] === 'tierwyn-node.service')).toBe(true);
    expect(log[0]).toContain('live sessions on this host will end');
    expect(log[1]).toBe('restarted tierwyn-node.service');
  });
  it('inactive', () => {
    const f = fakeExec({ 'is-active': { status: 3, stdout: 'inactive\n' } }); const log: string[] = [];
    expect(restartStep(f.exec, false, (s) => log.push(s))).toBe(0);
    expect(f.calls.some((c) => c[1][1] === 'is-active')).toBe(true);
    expect(log[0]).toContain('not running — change applies on next tierwyn node start');
  });
  it('enoent / unknown', () => {
    for (const r of ['enoent', { status: 1, stdout: '' }] as const) {
      const log: string[] = [];
      expect(restartStep(fakeExec({ 'is-active': r }).exec, false, (s) => log.push(s))).toBe(0);
      expect(log[0]).toContain('could not reach systemd user session — restart the node yourself');
    }
  });
  it('restart failure → 1', () => {
    const f = fakeExec({ 'is-active': { status: 0, stdout: 'active' }, restart: { status: 1, stdout: '' } }); const log: string[] = [];
    expect(restartStep(f.exec, false, (s) => log.push(s))).toBe(1);
    expect(log.at(-1)).toContain('node.json was updated but restart failed — run: tierwyn node restart');
  });
});

describe('status', () => {
  const onPath = (b: string) => b === 'claude';
  it('collects + renders', () => {
    const d = tmp({ hostId: 'h', hubUrl: 'https://hub.x', roots: ['/r'], allowedAgents: ['claude-code', 'foo'] });
    utimesSync(join(d, 'node.json'), 2_000_000_000, 2_000_000_000); // newer than service start
    const f = fakeExec({
      'is-active': { status: 0, stdout: 'active\n' },
      show: { status: 0, stdout: '@1792746720\n' },
    });
    const before = statSync(join(d, 'node.json')).mtimeMs;
    const s = collectStatus(d, f.exec, onPath);
    expect(s.service).toBe('active');
    expect(s.staleConfig).toBe(true);
    expect(s.agents.map((a) => a.type)).toEqual([...NODE_AGENT_TYPES]);
    expect(s.agents.find((a) => a.type === 'claude-code')).toMatchObject({ allowed: true, onPath: true });
    expect(s.agents.find((a) => a.type === 'codex')).toMatchObject({ allowed: false, onPath: false });
    expect(s.unknownAllowed).toEqual(['foo']);
    const out = renderStatus(s);
    for (const w of ['grok-bot', 'never', 'missing', 'hub link:', 'older node.json', 'unknown type "foo"']) expect(out).toContain(w);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001b\[/);
    expect(statSync(join(d, 'node.json')).mtimeMs).toBe(before);
  });
  it('same-second write after restart is not stale; show requests unix timestamps', () => {
    const d = tmp({ hostId: 'h' });
    utimesSync(join(d, 'node.json'), 1_800_000_000.4, 1_800_000_000.4);
    const f = fakeExec({ 'is-active': { status: 0, stdout: 'active' }, show: { status: 0, stdout: '@1800000000\n' } });
    const s = collectStatus(d, f.exec, onPath);
    expect(s.staleConfig).toBe(false);
    expect(s.serviceSince).toBeTruthy();
    expect(f.calls.find((c) => c[1][1] === 'show')![1]).toContain('--timestamp=unix');
    utimesSync(join(d, 'node.json'), 1_800_000_005, 1_800_000_005);
    expect(collectStatus(d, f.exec, onPath).staleConfig).toBe(true);
  });
  it('unparsable show output (BST style) → no warning, no crash', () => {
    const d = tmp({ hostId: 'h' });
    const f = fakeExec({ 'is-active': { status: 0, stdout: 'active' }, show: { status: 0, stdout: 'Thu 2026-10-22 20:47:49 BST\n' } });
    const s = collectStatus(d, f.exec, onPath);
    expect(s.staleConfig).toBe(false);
    expect(s.serviceSince).toBeUndefined();
  });
  it('not enrolled → 2', () => {
    expect(code(() => collectStatus(tmp(null), fakeExec({}).exec, onPath))).toBe(2);
  });
});

describe('runAgentsCommand', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
  it('allow --no-restart', async () => {
    const d = tmp({ hostId: 'h', allowedAgents: [] });
    const f = fakeExec({}); const log: string[] = [];
    const rc = await runAgentsCommand('allow', ['codex', '--no-restart', '--dir', d], { exec: f.exec, log: (s) => log.push(s), onPath: () => true });
    expect(rc).toBe(0);
    expect(log).toContain('+ codex');
    expect(log).toContain('allowedAgents: codex');
    expect(f.calls).toEqual([]);
  });
  it('usage errors → 2', async () => {
    quiet();
    const deps = { exec: fakeExec({}).exec, log: () => undefined };
    expect(await runAgentsCommand('allow', [], deps)).toBe(2);
    expect(await runAgentsCommand('allow', ['--all', 'codex'], deps)).toBe(2);
    expect(await runAgentsCommand('allow', ['--bogus', 'codex'], deps)).toBe(2);
    expect(await runAgentsCommand('status', ['--bogus'], deps)).toBe(2);
  });
  it('--dir without a value fails (M2)', async () => {
    quiet();
    const deps = { exec: fakeExec({}).exec, log: () => undefined };
    expect(await runAgentsCommand('allow', ['codex', '--dir'], deps)).toBe(2);
    expect(await runAgentsCommand('status', ['--dir', '--json'], deps)).toBe(2);
  });
  it('failed restart exits 1 but file is written (M7)', async () => {
    const d = tmp({ hostId: 'h', allowedAgents: [] });
    const f = fakeExec({ 'is-active': { status: 0, stdout: 'active' }, restart: { status: 1, stdout: '' } });
    const rc = await runAgentsCommand('allow', ['codex', '--dir', d], { exec: f.exec, log: () => undefined, onPath: () => true });
    expect(rc).toBe(1);
    expect(read(d).allowedAgents).toEqual(['codex']);
  });
  it('status --json', async () => {
    const d = tmp();
    const log: string[] = [];
    const rc = await runAgentsCommand('status', ['--json', '--dir', d], { exec: fakeExec({ 'is-active': { status: 3, stdout: 'inactive' } }).exec, log: (s) => log.push(s), onPath: () => false });
    expect(rc).toBe(0);
    expect(JSON.parse(log[0]).hostId).toBe('h');
  });
});
