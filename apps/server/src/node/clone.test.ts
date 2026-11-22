import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RpcError } from './rpc.js';
import { buildCloneArgv, fsClone, fsMkdir } from './clone.js';

const homes: string[] = [];
function tmp(prefix = 'tierwyn-clone-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  homes.push(d);
  return d;
}
afterAll(() => {
  for (const h of homes) {
    try { chmodSync(h, 0o700); } catch { /* ignore */ }
    try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const stubGitOk = '#!/bin/sh\n# last argv is the target; create it and exit 0\n' +
  'last=""; for a in "$@"; do last="$a"; done\nmkdir -p "$last" && exit 0\nexit 128\n';
const stubGitFail = '#!/bin/sh\n# create a partial dir then fail like git does\n' +
  'last=""; for a in "$@"; do last="$a"; done\nmkdir -p "$last/.git/partial"\necho "fatal: boom" >&2\nexit 128\n';

function writeStub(body: string): string {
  const p = join(tmp(), 'stub-git.sh');
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

const good = 'https://example.com/x.git';

describe('buildCloneArgv', () => {
  it('uses fixed argv with protocol policy and `--` before the url', () => {
    expect(buildCloneArgv('https://example.com/x.git', '/work/x')).toEqual([
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      'clone', '--no-recurse-submodules', '--', 'https://example.com/x.git', '/work/x',
    ]);
  });
});

describe('fsClone validation', () => {
  const good = 'https://example.com/x.git';

  it('rejects a disallowed url (file protocol)', async () => {
    await expect(fsClone([tmp()], { url: 'file:///etc/passwd', root: join(tmp(), 'x') }))
      .rejects.toMatchObject({ code: 'bad_url' });
  });

  it('rejects a relative root', async () => {
    await expect(fsClone([tmp()], { url: good, root: 'rel/path' }))
      .rejects.toMatchObject({ code: 'bad_path' });
  });

  it('rejects `..` in the root', async () => {
    const root = tmp();
    // join() would normalise the `..` away — send the raw string.
    await expect(fsClone([root], { url: good, root: `${root}/a/../b` }))
      .rejects.toMatchObject({ code: 'bad_path' });
  });

  it('rejects a parent outside roots', async () => {
    const outside = tmp();
    const roots = tmp();
    await expect(fsClone([roots], { url: good, root: join(outside, 'x') }))
      .rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('rejects a symlink parent pointing outside roots', async () => {
    const roots = tmp();
    const outside = tmp();
    const linkDir = join(roots, 'link');
    symlinkSync(outside, linkDir, 'dir');
    await expect(fsClone([roots], { url: good, root: join(linkDir, 'x') }))
      .rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('rejects an existing target', async () => {
    const roots = tmp();
    mkdirSync(join(roots, 'x'));
    await expect(fsClone([roots], { url: good, root: join(roots, 'x') }))
      .rejects.toMatchObject({ code: 'exists' });
  });

  it('rejects a target named .git', async () => {
    const roots = tmp();
    await expect(fsClone([roots], { url: good, root: join(roots, '.git') }))
      .rejects.toMatchObject({ code: 'bad_path' });
  });

  it('busy when the same target is already cloning', async () => {
    const roots = tmp();
    const target = join(roots, 'x');
    const slow = writeStub('#!/bin/sh\nlast=""; for a in "$@"; do last="$a"; done\nsleep 1\nmkdir -p "$last"\n');
    const first = fsClone([roots], { url: good, root: target }, { git: slow });
    // Second call with the same target hits the concurrency guard even if the
    // first has not finished.
    await expect(fsClone([roots], { url: good, root: target }, { git: slow }))
      .rejects.toMatchObject({ code: 'busy' });
    await expect(first).resolves.toMatchObject({ path: resolve(target) });
  });
});

describe('fsClone spawn', () => {
  it('clones via the stub git and returns the realpath', async () => {
    const roots = tmp();
    const target = join(roots, 'x');
    const res = await fsClone([roots], { url: good, root: target }, { git: writeStub(stubGitOk) });
    expect(res.path).toBe(resolve(target));
  });

  it('cleans up a partial target on failure and returns a redacted stderr tail', async () => {
    const roots = tmp();
    const target = join(roots, 'x');
    const err = await fsClone([roots], { url: good, root: target }, { git: writeStub(stubGitFail) })
      .catch((e: unknown) => e as RpcError);
    expect((err as RpcError).code).toBe('clone_failed');
    expect((err as RpcError).message).toContain('fatal: boom');
    expect(existsSync(target)).toBe(false);
  });

  it('redacts credentials embedded in the failure tail', async () => {
    const roots = tmp();
    const target = join(roots, 'x');
    const leak = '#!/bin/sh\nprev=""; for a in "$@"; do if [ "$prev" = "--" ]; then echo "fatal: unable to access \'https://bob:s3cret@example.com/x.git/\'" >&2; exit 128; fi; prev="$a"; done\n';
    const err = await fsClone([roots], { url: good, root: target }, { git: writeStub(leak) })
      .catch((e: unknown) => e as RpcError);
    expect((err as RpcError).message).not.toContain('s3cret');
    expect((err as RpcError).message).toContain('://***@');
  });

  it('success does not delete the fresh checkout', async () => {
    const roots = tmp();
    const target = join(roots, 'x');
    const res = await fsClone([roots], { url: good, root: target }, { git: writeStub(stubGitOk) });
    expect(existsSync(res.path)).toBe(true);
  });

  it('pre-existing target fails with exists before running git (I-1)', async () => {
    const roots = tmp();
    const target = join(roots, 'x');
    mkdirSync(target);
    const err = await fsClone([roots], { url: good, root: target }, { git: writeStub(stubGitOk) })
      .catch((e: unknown) => e as RpcError);
    expect((err as RpcError).code).toBe('exists');
    expect(existsSync(target)).toBe(true);
  });
});

describe('fsMkdir', () => {
  it('creates the leaf under a root (created: true)', () => {
    const roots = tmp();
    const target = join(roots, 'new-leaf');
    const res = fsMkdir([roots], { path: target });
    expect(res).toEqual({ path: resolve(target), created: true });
    expect(existsSync(target)).toBe(true);
  });

  it('existing dir → created: false', () => {
    const roots = tmp();
    const target = join(roots, 'existing-dir');
    mkdirSync(target);
    const res = fsMkdir([roots], { path: target });
    expect(res).toEqual({ path: resolve(target), created: false });
  });

  it('existing file → exists', () => {
    const roots = tmp();
    const target = join(roots, 'file');
    writeFileSync(target, 'hello');
    expect(() => fsMkdir([roots], { path: target })).toThrowError(
      expect.objectContaining({ code: 'exists' }),
    );
  });

  it('missing parent → path_outside_roots', () => {
    const roots = tmp();
    const target = join(roots, 'missing-parent', 'leaf');
    expect(() => fsMkdir([roots], { path: target })).toThrowError(
      expect.objectContaining({ code: 'path_outside_roots' }),
    );
  });

  it('parent outside roots → path_outside_roots', () => {
    const roots = tmp();
    const outside = tmp();
    const target = join(outside, 'leaf');
    expect(() => fsMkdir([roots], { path: target })).toThrowError(
      expect.objectContaining({ code: 'path_outside_roots' }),
    );
  });

  it('symlinked parent pointing outside roots → path_outside_roots', () => {
    const roots = tmp();
    const outside = tmp();
    const linkDir = join(roots, 'link');
    symlinkSync(outside, linkDir, 'dir');
    const target = join(linkDir, 'leaf');
    expect(() => fsMkdir([roots], { path: target })).toThrowError(
      expect.objectContaining({ code: 'path_outside_roots' }),
    );
  });

  it('relative / .. / .git leaf / /x/.git/y → bad_path', () => {
    const roots = tmp();
    expect(() => fsMkdir([roots], { path: 'rel/leaf' })).toThrowError(
      expect.objectContaining({ code: 'bad_path' }),
    );
    expect(() => fsMkdir([roots], { path: `${roots}/a/../b` })).toThrowError(
      expect.objectContaining({ code: 'bad_path' }),
    );
    expect(() => fsMkdir([roots], { path: join(roots, '.git') })).toThrowError(
      expect.objectContaining({ code: 'bad_path' }),
    );
    expect(() => fsMkdir([roots], { path: `${roots}/.git/leaf` })).toThrowError(
      expect.objectContaining({ code: 'bad_path' }),
    );
  });
});
