import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCommandError, isNonFastForwardError, readWorkingTree } from './workingTree.js';
import { GIT_NETWORK_TIMEOUT_MS, localGitOps, RemoteGitOps, WorkingTreeContextError } from './remoteOps.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcError, RpcPeer } from '../node/rpc.js';

describe('GitOps', () => {
  let root: string;
  let repo: string;
  let ops: RemoteGitOps;
  let extra: string[];

  beforeEach(() => {
    extra = [];
    root = mkdtempSync(join(tmpdir(), 'tierwyn-gitops-root-'));
    extra.push(root);
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'orig\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [root], allowedAgents: [], maxSessions: 4 },
    });
    const [hubT, nodeT] = memoryPair();
    const nodePeer = new RpcPeer(nodeT, runtime.handlers());
    const hub = new RpcPeer(hubT, {});
    void nodePeer;
    ops = new RemoteGitOps({ link: () => ({ request: (m, p, t) => hub.request(m, p, t) }) }, 'h');
  });

  afterEach(() => {
    for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('readWorkingTree round-trips', async () => {
    expect((await ops.readWorkingTree(repo)).isRepo).toBe(true);
  });
  it('kind:git rebuilds GitCommandError', async () => {
    const e = await ops.commitDetail(repo, 'deadbeef').catch((x) => x);
    expect(e).toBeInstanceOf(GitCommandError); expect(e.status).toBe(128);
  });
  it('guard error stays a plain Error with module text', async () => {
    await expect(ops.commitDetail(repo, 'HEAD@{1}')).rejects.toThrow('invalid sha');
  });
  it.each([
    ['host_disconnected', 503], ['timeout', 503], ['no_method', 501], ['path_outside_roots', 403], ['weird', 502],
  ])('RpcError %s → %i', async (code, status) => {
    const bad = new RemoteGitOps({ link: () => ({ request: async () => { throw new RpcError(code, 'secret node text'); } }) }, 'h');
    const e = await bad.listBranches('/x').catch((x) => x);
    expect(e).toBeInstanceOf(WorkingTreeContextError); expect(e.status).toBe(status);
    expect(e.message).not.toContain('secret node text');
  });
  it('link() throwing → 503', async () => {
    const bad = new RemoteGitOps({ link: () => { throw new RpcError('host_disconnected', 'x'); } }, 'h');
    await expect(bad.headRef('/x')).rejects.toMatchObject({ status: 503 });
  });
  it('remote validatePathspec rejects ../ lexically', async () => {
    await expect(ops.validatePathspec(repo, '../x')).rejects.toThrow(/pathspec/);
  });
  it('localGitOps.readWorkingTree equals the sync module', async () => {
    expect(await localGitOps.readWorkingTree(repo)).toEqual(readWorkingTree(repo));
  });

  it('stage → commit → switch round-trip matches local semantics', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    await ops.stagePath(repo, 'a.txt');
    expect(await ops.commitStaged(repo, 'm')).toMatch(/^[0-9a-f]{7,}$/);
    expect(await ops.createBranch(repo, 'feat')).toBe('feat');
    await expect(ops.switchBranch(repo, 'nope')).rejects.toThrow('branch not found');
  });

  it('stashPop conflict surfaces as GitCommandError matching /CONFLICT/', async () => {
    writeFileSync(join(repo, 'a.txt'), 'stashed\n');
    await ops.stashPush(repo, 'm');
    writeFileSync(join(repo, 'a.txt'), 'other\n');
    await ops.stagePath(repo, 'a.txt');
    await ops.commitStaged(repo, 'diverge');
    const err = await ops.stashPop(repo).catch((e) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect(`${err.stderr}\n${err.stdout}`).toMatch(/CONFLICT/);
  });

  it('pullFastForward on diverged branch → GitCommandError with isNonFastForwardError true', async () => {
    const bare = join(root, 'bare.git');
    execFileSync('git', ['clone', '--bare', repo, bare]);
    const a = join(root, 'clone-a');
    const b = join(root, 'clone-b');
    execFileSync('git', ['clone', bare, a]);
    execFileSync('git', ['clone', bare, b]);
    for (const d of [a, b]) {
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: d });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: d });
    }
    writeFileSync(join(a, 'a.txt'), 'from-a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: a });
    execFileSync('git', ['commit', '-m', 'a'], { cwd: a });
    execFileSync('git', ['push'], { cwd: a });
    writeFileSync(join(b, 'a.txt'), 'from-b\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: b });
    execFileSync('git', ['commit', '-m', 'b'], { cwd: b });
    const err = await ops.pullFastForward(b).catch((e) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect(isNonFastForwardError(err)).toBe(true);
  });

  it('network methods pass GIT_NETWORK_TIMEOUT_MS; others the default', async () => {
    const timeouts: Array<number | undefined> = [];
    const spy = new RemoteGitOps({
      link: () => ({
        request: async (_m, _p, t) => {
          timeouts.push(t);
          throw new RpcError('host_disconnected', 'x');
        },
      }),
    }, 'h');
    await spy.fetchRemotes(repo).catch(() => {});
    expect(timeouts[0]).toBe(GIT_NETWORK_TIMEOUT_MS);
    expect(GIT_NETWORK_TIMEOUT_MS).toBe(180_000);
    timeouts.length = 0;
    await spy.stagePath(repo, 'a.txt').catch(() => {});
    expect(timeouts[0]).toBeUndefined();
  });

  it('stashPush(cwd) sends args [] (no trailing undefined)', async () => {
    const seen: unknown[] = [];
    const spy = new RemoteGitOps({
      link: () => ({
        request: async (_m, p) => {
          seen.push((p as { args?: unknown[] }).args);
          throw new RpcError('host_disconnected', 'x');
        },
      }),
    }, 'h');
    await spy.stashPush(repo).catch(() => {});
    expect(seen[0]).toEqual([]);
  });
});
