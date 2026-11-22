import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUB_ROOT, hubRootGuard, isDedicatedHub, overlapsHubRoot } from './hubMode.js';
import { getSandboxSettings, putSandboxSettings } from './repositories/sandboxSettings.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('hubMode', () => {
  it('HUB_ROOT is the repo root', () => {
    expect(HUB_ROOT.endsWith('/apps')).toBe(false);
    expect(join(HUB_ROOT, 'scripts', 'install.sh')).toMatch(/scripts\/install\.sh$/);
  });

  it('overlap covers inside, equal and ancestor — not siblings', () => {
    const base = mkdtempSync(join(tmpdir(), 'hubroot-'));
    dirs.push(base);
    const hub = join(base, 'tierwyn');
    mkdirSync(join(hub, 'apps'), { recursive: true });
    mkdirSync(join(base, 'tierwyn-work'));
    expect(overlapsHubRoot(hub, hub)).toBe(true);
    expect(overlapsHubRoot(join(hub, 'apps'), hub)).toBe(true);
    expect(overlapsHubRoot(base, hub)).toBe(true);
    expect(overlapsHubRoot(join(base, 'tierwyn-work'), hub)).toBe(false);
  });

  it('guard only fires on a dedicated hub', () => {
    expect(isDedicatedHub({})).toBe(false);
    expect(hubRootGuard(HUB_ROOT, {})).toBeNull(); // dev checkout: projects over the repo are the job
    expect(hubRootGuard(HUB_ROOT, { TIERWYN_DEDICATED_HUB: '1' })).toMatch(/overlaps the hub install/);
  });

  it('sandbox defaults on only for a dedicated hub, and a saved row wins', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    vi.stubEnv('TIERWYN_DEDICATED_HUB', '');
    expect(getSandboxSettings(db).global).toBe(false);
    vi.stubEnv('TIERWYN_DEDICATED_HUB', '1');
    expect(getSandboxSettings(db).global).toBe(true);
    putSandboxSettings(db, { global: false, defaults: [], hostPaths: {} });
    expect(getSandboxSettings(db).global).toBe(false);
  });
});
