import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CdpLike } from './cdp.js';
import { resolveSandboxMedia } from './bridge.js';
import { fileFallbackText } from '@tierwyn/shared';

const CONV = 'bc33dace-50e8-4206-9d84-ca7a57187c1b';
const BYTES = Buffer.from('hello from grok bot\n');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function fakeClient(result: unknown): CdpLike {
  return {
    async evaluate() { return result; },
    async send() { return {}; },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
}

function attachmentEv(files: Array<Record<string, unknown>>) {
  return {
    type: 'message' as const,
    payload: {
      chunk: fileFallbackText(files.map((f) => ({ name: String(f.name ?? 'file') }))),
      final: true,
      files,
    },
  };
}

describe('resolveSandboxMedia', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes <dir>/<conv>/<sha>.txt with the resolved bytes and strips sandboxUrl', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-att-'));
    const ev = attachmentEv([{
      name: 'test-file.txt',
      mediaType: 'application/octet-stream',
      status: 'unavailable',
      sandboxUrl: 'file:///home/box/agent-data/agents/x/attachments/deadbeef.txt',
    }]);
    const out = await resolveSandboxMedia(fakeClient({
      kind: 'bytes', size: BYTES.length, b64: BYTES.toString('base64'),
    }), ev, { conversationId: CONV, attachmentsDir: dir });

    const path = join(dir, CONV, `${SHA}.txt`);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(BYTES);
    const file = (out.payload as { files: Array<Record<string, unknown>> }).files[0];
    expect(file).toMatchObject({
      name: 'test-file.txt',
      status: 'ok',
      size: BYTES.length,
      path,
      mediaType: 'text/plain',
    });
    expect(file.sandboxUrl).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/file:\/\//);
  });

  it('is idempotent: a second call does not rewrite the shard', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-att-'));
    const ev = () => attachmentEv([{
      name: 'test-file.txt',
      status: 'unavailable',
      sandboxUrl: 'file:///home/box/a.txt',
    }]);
    const opts = { conversationId: CONV, attachmentsDir: dir };
    await resolveSandboxMedia(fakeClient({
      kind: 'bytes', size: BYTES.length, b64: BYTES.toString('base64'),
    }), ev(), opts);
    const path = join(dir, CONV, `${SHA}.txt`);
    writeFileSync(path, 'stale');
    await resolveSandboxMedia(fakeClient({
      kind: 'bytes', size: BYTES.length, b64: BYTES.toString('base64'),
    }), ev(), opts);
    expect(readFileSync(path, 'utf8')).toBe('stale');
  });

  it('sets too_large and unavailable without writing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-att-'));
    const large = await resolveSandboxMedia(fakeClient({
      kind: 'too-large', size: 30 * 1024 * 1024,
    }), attachmentEv([{
      name: 'big.bin', status: 'unavailable', sandboxUrl: 'file:///home/box/big.bin',
    }]), { conversationId: CONV, attachmentsDir: dir });
    expect((large.payload as { files: Array<{ status: string; size?: number }> }).files[0])
      .toMatchObject({ status: 'too_large', size: 30 * 1024 * 1024 });
    expect(JSON.stringify(large)).not.toMatch(/file:\/\//);

    const missing = await resolveSandboxMedia(fakeClient(null), attachmentEv([{
      name: 'gone.txt', status: 'unavailable', sandboxUrl: 'file:///home/box/gone.txt',
    }]), { conversationId: CONV, attachmentsDir: dir });
    expect((missing.payload as { files: Array<{ status: string }> }).files[0].status).toBe('unavailable');
    expect(JSON.stringify(missing)).not.toMatch(/file:\/\//);
    expect(existsSync(join(dir, CONV))).toBe(false);
  });

  it('sanitises extension: ../../x.sh stays inside the dir; a.<script> becomes .bin', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-att-'));
    const sh = await resolveSandboxMedia(fakeClient({
      kind: 'bytes', size: BYTES.length, b64: BYTES.toString('base64'),
    }), attachmentEv([{
      name: '../../x.sh', status: 'unavailable', sandboxUrl: 'file:///home/box/x.sh',
    }]), { conversationId: CONV, attachmentsDir: dir });
    const shPath = (sh.payload as { files: Array<{ path: string }> }).files[0].path;
    expect(shPath).toBe(join(dir, CONV, `${SHA}.sh`));
    expect(shPath.startsWith(join(dir, CONV))).toBe(true);

    const bin = await resolveSandboxMedia(fakeClient({
      kind: 'bytes', size: BYTES.length, b64: BYTES.toString('base64'),
    }), attachmentEv([{
      name: 'a.<script>', status: 'unavailable', sandboxUrl: 'file:///home/box/x',
    }]), { conversationId: CONV, attachmentsDir: dir });
    expect((bin.payload as { files: Array<{ path: string }> }).files[0].path)
      .toBe(join(dir, CONV, `${SHA}.bin`));
  });

  it('does not write when conversationId is not a UUID', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-att-'));
    await resolveSandboxMedia(fakeClient({
      kind: 'bytes', size: BYTES.length, b64: BYTES.toString('base64'),
    }), attachmentEv([{
      name: 'x.txt', status: 'unavailable', sandboxUrl: 'file:///home/box/x.txt',
    }]), { conversationId: '../etc', attachmentsDir: dir });
    expect(existsSync(join(dir, '../etc'))).toBe(false);
    expect(existsSync(join(dir, 'etc'))).toBe(false);
  });
});
