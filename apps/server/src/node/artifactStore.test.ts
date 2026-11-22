import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lutimesSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NODE_FILE_MAX_BYTES } from '@tierwyn/shared';
import { artifactPurge, artifactRead, artifactSweep, artifactWrite } from './artifactStore.js';
import { RpcError } from './rpc.js';

let root = '';
const C1 = 'c1conversation';
const C2 = 'c2conversation';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tierwyn-artifacts-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function buf3(n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 11) % 256));
}

function upload(name: string, bytes: Buffer, conversationId = C1, chunk = 3): Promise<string> {
  const uploadId = randomUUID();
  const sum = sha(bytes);
  let offset = 0;
  const step = async (): Promise<string> => {
    const isFinal = offset + chunk >= bytes.length;
    const take = isFinal ? bytes.length - offset : chunk;
    const r = await artifactWrite(root, {
      conversationId,
      name,
      uploadId,
      offset,
      b64: bytes.subarray(offset, offset + take).toString('base64'),
      final: isFinal,
      size: bytes.length,
      sha256: sum,
    });
    if ('path' in r) return r.path;
    offset = r.received;
    return step();
  };
  return step();
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RpcError) return err.code;
    throw err;
  }
  return 'no_error';
}

describe('artifactWrite', () => {
  it('writes 3 chunks and lands the file at 0600 with no part left behind', async () => {
    const bytes = buf3(8);
    const landed = await upload('out.png', bytes);
    expect(landed).toBe(join(root, C1, 'out.png'));
    const st = await import('node:fs').then((fs) => fs.statSync(landed));
    expect((st.mode & 0o777) === 0o600).toBe(true);
    expect(readFileSync(landed).equals(bytes)).toBe(true);
    expect(readdirSync(join(root, C1)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('lands a same-name second upload as <stem>-1.bin', async () => {
    await upload('dup.bin', buf3(5));
    const landed = await upload('dup.bin', buf3(5));
    expect(landed).toBe(join(root, C1, 'dup-1.bin'));
  });

  it('rejects a wrong sha256 on final with checksum and cleans the part', async () => {
    const bytes = buf3(4);
    const uploadId = randomUUID();
    expect(
      await codeOf(
        artifactWrite(root, {
          conversationId: C1, name: 'bad.png', uploadId, offset: 0,
          b64: bytes.toString('base64'), final: true, size: bytes.length,
          sha256: 'f'.repeat(64),
        }),
      ),
    ).toBe('checksum');
    expect(existsSync(join(root, C1, 'bad.png'))).toBe(false);
    expect(existsSync(join(root, C1, `.${uploadId}.part`))).toBe(false);
  });

  it('rejects a restart on an existing part with checksum', async () => {
    const bytes = buf3(4);
    const uploadId = randomUUID();
    await artifactWrite(root, {
      conversationId: C1, name: 're.png', uploadId, offset: 0,
      b64: bytes.subarray(0, 2).toString('base64'), final: false, size: bytes.length, sha256: sha(bytes),
    });
    expect(
      await codeOf(
        artifactWrite(root, {
          conversationId: C1, name: 're.png', uploadId, offset: 0,
          b64: bytes.toString('base64'), final: true, size: bytes.length, sha256: sha(bytes),
        }),
      ),
    ).toBe('checksum');
  });

  it('rejects a mid-upload offset mismatch with checksum', async () => {
    const bytes = buf3(6);
    expect(
      await codeOf(
        artifactWrite(root, {
          conversationId: C1, name: 'mis.png', uploadId: randomUUID(), offset: 5,
          b64: bytes.toString('base64'), final: false, size: bytes.length, sha256: sha(bytes),
        }),
      ),
    ).toBe('checksum');
  });

  it('rejects size above NODE_FILE_MAX_BYTES with too_large', async () => {
    expect(
      await codeOf(
        artifactWrite(root, {
          conversationId: C1, name: 'big.png', uploadId: randomUUID(), offset: 0,
          b64: '', final: false, size: NODE_FILE_MAX_BYTES + 1, sha256: sha(Buffer.alloc(0)),
        }),
      ),
    ).toBe('too_large');
  });

  it('rejects bad names and ids with bad_name', async () => {
    const base = { uploadId: randomUUID(), offset: 0, b64: '', final: false, size: 0, sha256: sha(Buffer.alloc(0)) };
    expect(await codeOf(artifactWrite(root, { ...base, conversationId: C1, name: '../x' }))).toBe('bad_name');
    expect(await codeOf(artifactWrite(root, { ...base, conversationId: C1, name: '.hidden' }))).toBe('bad_name');
    expect(await codeOf(artifactWrite(root, { ...base, conversationId: '../c', name: 'x' }))).toBe('bad_name');
  });

  it('sweeps orphan part files older than 1h on a fresh offset-0 write', async () => {
    const shard = join(root, C1);
    mkdirSync(shard, { recursive: true });
    const stale = join(shard, '.deadbeef-dead-beef-dead-beefdeadbeef.part');
    writeFileSync(stale, Buffer.from('stale'));
    utimesSync(stale, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
    await upload('sweep.png', buf3(3));
    expect(existsSync(stale)).toBe(false);
  });

  it('refuses to open a planted symlink at the part path and leaves the target untouched', async () => {
    const shard = join(root, C1);
    mkdirSync(shard, { recursive: true });
    const victim = join(shard, 'victim.txt');
    writeFileSync(victim, 'keep me');
    const uploadId = randomUUID();
    symlinkSync(victim, join(shard, `.${uploadId}.part`));
    const bytes = buf3(3);
    expect(
      await codeOf(
        artifactWrite(root, {
          conversationId: C1, name: 'evil.png', uploadId, offset: 0,
          b64: bytes.toString('base64'), final: true, size: bytes.length, sha256: sha(bytes),
        }),
      ),
    ).toBe('checksum');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
  });
});

describe('artifactRead', () => {
  it('returns sha256 only on offset 0 and the requested window otherwise', async () => {
    const bytes = buf3(10);
    const landed = await upload('win.png', bytes);
    const all = await artifactRead(root, { conversationId: C1, path: landed, offset: 0, length: 32 });
    expect(all.sha256).toBe(sha(bytes));
    expect(all.size).toBe(bytes.length);
    expect(Buffer.from(all.data, 'base64').equals(bytes)).toBe(true);
    const tail = await artifactRead(root, { conversationId: C1, path: landed, offset: 8, length: 32 });
    expect(tail.sha256).toBeUndefined();
    expect(tail.data).toBe(bytes.subarray(8).toString('base64'));
  });

  it('refuses a symlink that escapes the shard with outside_shard', async () => {
    const shard = join(root, C1);
    mkdirSync(shard, { recursive: true });
    symlinkSync('/etc/hostname', join(shard, 'escape.png'));
    expect(
      await codeOf(artifactRead(root, { conversationId: C1, path: join(shard, 'escape.png'), offset: 0, length: 4 })),
    ).toBe('outside_shard');
  });

  it('refuses a path inside a sibling shard with outside_shard', async () => {
    const sibling = join(root, C2);
    mkdirSync(sibling, { recursive: true });
    const f = join(sibling, 'secret.png');
    writeFileSync(f, 'sibling');
    expect(
      await codeOf(artifactRead(root, { conversationId: C1, path: f, offset: 0, length: 4 })),
    ).toBe('outside_shard');
  });

  it('rejects a path containing NUL with outside_shard', async () => {
    expect(
      await codeOf(artifactRead(root, { conversationId: C1, path: 'a\0b', offset: 0, length: 4 })),
    ).toBe('outside_shard');
  });

  it('reports a missing artifact as not_found', async () => {
    expect(
      await codeOf(artifactRead(root, { conversationId: C1, path: join(root, C1, 'nope.png'), offset: 0, length: 4 })),
    ).toBe('not_found');
  });
});

describe('artifactPurge', () => {
  it('removes the shard and tolerates a missing one', async () => {
    await upload('gone.png', buf3(3), C2);
    expect(existsSync(join(root, C2))).toBe(true);
    await expect(artifactPurge(root, { conversationId: C2 })).resolves.toEqual({ ok: true });
    expect(existsSync(join(root, C2))).toBe(false);
    await expect(artifactPurge(root, { conversationId: C2 })).resolves.toEqual({ ok: true });
  });

  it('rejects a bad id with bad_name', async () => {
    expect(await codeOf(artifactPurge(root, { conversationId: '../../etc' }))).toBe('bad_name');
  });
});

describe('artifactSweep', () => {
  const DAY = 86_400_000;

  function sweepRoot(): string {
    return mkdtempSync(join(tmpdir(), 'tierwyn-sweep-'));
  }

  function cleanup(...dirs: string[]): void {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }

  it('removes files older than maxAge and keeps fresh ones', async () => {
    const r = sweepRoot();
    try {
      const shard = join(r, 'convold');
      mkdirSync(shard, { recursive: true });
      const oldF = join(shard, 'old.png');
      const newF = join(shard, 'new.png');
      writeFileSync(oldF, 'old');
      writeFileSync(newF, 'new');
      const oldT = new Date(Date.now() - 100 * DAY);
      utimesSync(oldF, oldT, oldT);
      await expect(artifactSweep(r, 90, Date.now())).resolves.toEqual({ removed: 1 });
      expect(existsSync(oldF)).toBe(false);
      expect(existsSync(newF)).toBe(true);
    } finally {
      cleanup(r);
    }
  });

  it('removes the conversation dir once emptied', async () => {
    const r = sweepRoot();
    try {
      const shard = join(r, 'convempty');
      mkdirSync(shard, { recursive: true });
      const f = join(shard, 'gone.bin');
      writeFileSync(f, 'x');
      const t = new Date(Date.now() - 91 * DAY);
      utimesSync(f, t, t);
      await artifactSweep(r, 90, Date.now());
      expect(existsSync(shard)).toBe(false);
    } finally {
      cleanup(r);
    }
  });

  it('does not follow a symlink out of root', async () => {
    const r = sweepRoot();
    const outside = mkdtempSync(join(tmpdir(), 'tierwyn-sweep-out-'));
    try {
      const target = join(outside, 'target.txt');
      writeFileSync(target, 'keep me');
      const t = new Date(Date.now() - 100 * DAY);
      utimesSync(target, t, t);
      const shard = join(r, 'convsym');
      mkdirSync(shard, { recursive: true });
      const link = join(shard, 'old.png');
      symlinkSync(target, link);
      lutimesSync(link, t, t);
      await expect(artifactSweep(r, 90, Date.now())).resolves.toEqual({ removed: 1 });
      expect(existsSync(link)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('keep me');
    } finally {
      cleanup(r, outside);
    }
  });

  it('with maxAgeDays 0 is a no-op', async () => {
    const r = sweepRoot();
    try {
      const shard = join(r, 'convzero');
      mkdirSync(shard, { recursive: true });
      const f = join(shard, 'ancient.png');
      writeFileSync(f, 'x');
      const t = new Date(Date.now() - 3650 * DAY);
      utimesSync(f, t, t);
      await expect(artifactSweep(r, 0, Date.now())).resolves.toEqual({ removed: 0 });
      expect(existsSync(f)).toBe(true);
    } finally {
      cleanup(r);
    }
  });
});
