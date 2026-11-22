import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAgyAlwaysProceed } from './index.js';

const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));

describe('ensureAgyAlwaysProceed', () => {
  it('creates the file on a fresh host', async () => {
    const p = path.join(await mkdtemp(path.join(tmpdir(), 'agy-')), 'antigravity-cli', 'settings.json');
    await ensureAgyAlwaysProceed(p);
    expect(await read(p)).toEqual({ toolPermission: 'always-proceed' });
  });

  it('adds the key and keeps other settings', async () => {
    const p = path.join(await mkdtemp(path.join(tmpdir(), 'agy-')), 'settings.json');
    await writeFile(p, JSON.stringify({ trustedWorkspaces: ['/h'] }));
    await ensureAgyAlwaysProceed(p);
    expect(await read(p)).toEqual({ trustedWorkspaces: ['/h'], toolPermission: 'always-proceed' });
  });

  it('leaves an explicit value and invalid JSON alone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agy-'));
    const explicit = path.join(dir, 'a.json');
    await writeFile(explicit, JSON.stringify({ toolPermission: 'ask' }));
    await ensureAgyAlwaysProceed(explicit);
    expect(await read(explicit)).toEqual({ toolPermission: 'ask' });
    const bad = path.join(dir, 'b.json');
    await writeFile(bad, '{nope');
    await ensureAgyAlwaysProceed(bad);
    expect(await readFile(bad, 'utf8')).toBe('{nope');
  });
});
