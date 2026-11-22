import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { validateManifest, scanManifests, credentialKeysFrom, activatePlugins, activatePlugin, readPluginDir, MAX_HELP_BYTES } from './loader.js';
import { PluginHost } from './host.js';
import { getPluginState, setPluginDisabled } from '../repositories/settings.js';

describe('validateManifest', () => {
  const base = {
    id: 'zai-usage',
    name: 'Z.ai Usage',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: [{ name: 'usage.get', summary: 'quota', agentCallable: true }],
  };

  it('rejects a bad id', () => {
    expect(validateManifest({ ...base, id: 'ZAI' }).ok).toBe(false);
    expect(validateManifest({ ...base, id: 'a' }).ok).toBe(false);
    expect(validateManifest({ ...base, id: 'has_underscore' }).ok).toBe(false);
  });

  it('rejects apiVersion !== 1', () => {
    const r = validateManifest({ ...base, apiVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/apiVersion/);
  });

  it('rejects a blocklisted credential key', () => {
    expect(validateManifest({
      ...base,
      credentials: [{ key: 'OPENAI_API_KEY' }],
    }).ok).toBe(false);
    expect(validateManifest({
      ...base,
      credentials: [{ key: 'PATH' }],
    }).ok).toBe(false);
    expect(validateManifest({
      ...base,
      credentials: [{ key: 'TIERWYN_SECRET' }],
    }).ok).toBe(false);
  });

  it('rejects a malformed credential key', () => {
    expect(validateManifest({
      ...base,
      credentials: [{ key: 'zai-key' }],
    }).ok).toBe(false);
    expect(validateManifest({
      ...base,
      credentials: [{ key: '1ABC' }],
    }).ok).toBe(false);
  });

  it('accepts a dedicated key', () => {
    const r = validateManifest({
      ...base,
      credentials: [{ key: 'ZAI_API_KEY', required: true }],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts usageProvider on a capability', () => {
    const r = validateManifest({
      ...base,
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Z.AI' },
      }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects usageProvider without label', () => {
    const r = validateManifest({
      ...base,
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: {},
      }],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts capability timeoutMs 120000 and 300000; rejects out-of-range values', () => {
    for (const timeoutMs of [120000, 300000]) {
      const r = validateManifest({
        ...base,
        capabilities: [{ name: 'usage.get', summary: 'quota', agentCallable: true, timeoutMs }],
      });
      expect(r.ok).toBe(true);
    }
    for (const timeoutMs of [0, -1, 1.5, '120000', 300001, NaN]) {
      const r = validateManifest({
        ...base,
        capabilities: [{ name: 'usage.get', summary: 'quota', agentCallable: true, timeoutMs }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/timeoutMs/);
    }
  });

  it('accepts valid permissions string array; rejects invalid permissions', () => {
    expect(validateManifest({
      ...base,
      permissions: ['outbound:https://example.com'],
    }).ok).toBe(true);

    const rNotArray = validateManifest({ ...base, permissions: 'outbound:https://example.com' });
    expect(rNotArray.ok).toBe(false);
    if (!rNotArray.ok) expect(rNotArray.reason).toMatch(/permissions must be an array/);

    const rNotStrings = validateManifest({
      ...base,
      permissions: [{ type: 'outbound', url: 'https://example.com' }],
    });
    expect(rNotStrings.ok).toBe(false);
    if (!rNotStrings.ok) expect(rNotStrings.reason).toMatch(/permissions must be an array of strings/);
  });
});

describe('scanManifests / activatePlugins', () => {
  let dir: string;
  const savedOff = process.env.TIERWYN_PLUGINS;

  afterEach(() => {
    if (savedOff === undefined) delete process.env.TIERWYN_PLUGINS;
    else process.env.TIERWYN_PLUGINS = savedOff;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writePlugin(id: string, extra: {
    apiVersion?: number;
    credentials?: Array<{ key: string }>;
    activateJs?: string;
  } = {}): string {
    const pluginDir = join(dir, id);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      apiVersion: extra.apiVersion ?? 1,
      capabilities: [{ name: 'ping', summary: 'ping', agentCallable: true }],
      credentials: extra.credentials ?? [{ key: `${id.toUpperCase().replace(/-/g, '_')}_KEY` }],
    }));
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(pluginDir, 'index.js'), extra.activateJs ?? 'export default { activate() {} };\n');
    return pluginDir;
  }

  it('TIERWYN_PLUGINS=off returns []', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    writePlugin('alpha');
    process.env.TIERWYN_PLUGINS = 'off';
    expect(scanManifests(dir)).toEqual([]);
  });

  it('activate throw disables that plugin and boot survives; scrub list includes disabled plugins', async () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    writePlugin('good', { credentials: [{ key: 'GOOD_KEY' }] });
    writePlugin('bad', {
      credentials: [{ key: 'BAD_KEY' }],
      activateJs: 'export default { activate() { throw new Error("boom"); } };\n',
    });
    writePlugin('offed', { credentials: [{ key: 'OFFED_KEY' }] });

    const found = scanManifests(dir);
    expect(found.map((p) => p.manifest.id).sort()).toEqual(['bad', 'good', 'offed']);
    expect(credentialKeysFrom(found).sort()).toEqual(['BAD_KEY', 'GOOD_KEY', 'OFFED_KEY']);

    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const host = new PluginHost({ getDb: () => db });
    await activatePlugins(host, found, ['offed']);

    const listed = host.listForOperator();
    expect(listed.find((p) => p.id === 'good')?.enabled).toBe(true);
    expect(listed.find((p) => p.id === 'bad')?.enabled).toBe(false);
    expect(listed.find((p) => p.id === 'offed')?.enabled).toBe(false);
  });

  it('reads HELP.md into found[].help when present', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = writePlugin('helped');
    writeFileSync(join(pluginDir, 'HELP.md'), '# helped\n\nhello agent\n');
    const found = scanManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0].help).toBe('# helped\n\nhello agent\n');
  });

  it('leaves help undefined when HELP.md is absent', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    writePlugin('bare');
    const found = scanManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0].help).toBeUndefined();
  });

  it('ignores an oversized HELP.md but still loads the plugin', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = writePlugin('big');
    writeFileSync(join(pluginDir, 'HELP.md'), 'x'.repeat(MAX_HELP_BYTES + 1));
    const found = scanManifests(dir);
    expect(found.map((p) => p.manifest.id)).toEqual(['big']);
    expect(found[0].help).toBeUndefined();
  });

  it('ignores a symlinked HELP.md', { skip: process.platform === 'win32' }, () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = writePlugin('linked');
    const outside = join(dir, 'outside-help.md');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(pluginDir, 'HELP.md'));
    const found = scanManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0].help).toBeUndefined();
  });

  it('readPluginDir returns the plugin for a valid dir', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = writePlugin('valid');
    const res = readPluginDir(pluginDir);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plugin.manifest.id).toBe('valid');
      expect(res.plugin.dir).toBe(pluginDir);
    }
  });

  it('readPluginDir reports missing for a dir without index.js', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = join(dir, 'no-index');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'no-index',
      name: 'No Index',
      version: '1.0.0',
      apiVersion: 1,
      capabilities: [{ name: 'ping', summary: 'ping', agentCallable: true }],
    }));
    const res = readPluginDir(pluginDir);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toBe(true);
    }
  });

  it('readPluginDir reports the validation reason for a bad manifest', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = join(dir, 'bad-manifest');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'INVALID_ID',
      name: 'Bad',
      version: '1.0.0',
      apiVersion: 1,
      capabilities: [],
    }));
    writeFileSync(join(pluginDir, 'index.js'), 'export default { activate() {} };\n');
    const res = readPluginDir(pluginDir);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toBeUndefined();
      expect(res.reason).toMatch(/invalid id/);
    }
  });

  it('scanManifests skips dot-prefixed staging dirs', () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    writePlugin('good');
    const stagingDir = join(dir, '.import-staging');
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'plugin.json'), JSON.stringify({
      id: 'staging-plugin',
      name: 'Staging',
      version: '1.0.0',
      apiVersion: 1,
      capabilities: [{ name: 'ping', summary: 'ping', agentCallable: true }],
    }));
    writeFileSync(join(stagingDir, 'index.js'), 'export default { activate() {} };\n');

    const found = scanManifests(dir);
    expect(found.map((p) => p.manifest.id)).toEqual(['good']);
  });

  it('activatePlugin returns ok:false and does not markDisabled on activate throw', async () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = writePlugin('boom', {
      activateJs: 'export default { activate() { throw new Error("activate crash"); } };\n',
    });
    const scanned = readPluginDir(pluginDir);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;

    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const host = new PluginHost({ getDb: () => db });
    const ctx = host.addManifest(scanned.plugin.manifest, { enabled: true, dir: scanned.plugin.dir });

    const res = await activatePlugin(host, scanned.plugin, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('activate crash');
    }
    // activatePlugin must not markDisabled - host record enabled remains true
    const op = host.listForOperator().find((p) => p.id === 'boom');
    expect(op?.enabled).toBe(true);
  });

  it('activatePlugin with bust re-imports a changed index.js under the same path', async () => {
    dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-'));
    const pluginDir = join(dir, 'mutable');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'mutable',
      name: 'Mutable',
      version: '1.0.0',
      apiVersion: 1,
      capabilities: [
        { name: 'cap1', summary: 'c1', agentCallable: true },
        { name: 'cap2', summary: 'c2', agentCallable: true },
      ],
    }));
    writeFileSync(
      join(pluginDir, 'index.js'),
      'const loadedAt = Date.now(); export default { activate(ctx) { ctx.capability("cap1", async () => ({ v: "v1", loadedAt })); } };\n',
    );

    const scanned = readPluginDir(pluginDir);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;

    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const host = new PluginHost({ getDb: () => db });

    // Activate v1
    const ctx1 = host.addManifest(scanned.plugin.manifest, { enabled: true, dir: scanned.plugin.dir });
    const r1 = await activatePlugin(host, scanned.plugin, ctx1);
    expect(r1.ok).toBe(true);
    const inv1 = await host.invoke('mutable', 'cap1', {}, { kind: 'operator' });
    expect(inv1.ok).toBe(true);
    const data1 = (inv1 as { data: { v: string; loadedAt: number } }).data;
    expect(data1.v).toBe('v1');

    // Slight delay to guarantee new loadedAt timestamp
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Remove from host, rewrite index.js to v2, activate with bust
    host.removePlugin('mutable');
    writeFileSync(
      join(pluginDir, 'index.js'),
      'const loadedAt = Date.now(); export default { activate(ctx) { ctx.capability("cap2", async () => ({ v: "v2", loadedAt })); } };\n',
    );
    const ctx2 = host.addManifest(scanned.plugin.manifest, { enabled: true, dir: scanned.plugin.dir });
    const r2 = await activatePlugin(host, scanned.plugin, ctx2, { bust: true });
    expect(r2.ok).toBe(true);
    const inv2 = await host.invoke('mutable', 'cap2', {}, { kind: 'operator' });
    expect(inv2.ok).toBe(true);
    const data2 = (inv2 as { data: { v: string; loadedAt: number } }).data;
    expect(data2.v).toBe('v2');
    expect(data2.loadedAt).toBeGreaterThan(data1.loadedAt);
  });
});

describe('getPluginState / setPluginDisabled', () => {
  it('round-trips the plugins blob', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    expect(getPluginState(db)).toEqual({ disabled: [] });
    expect(setPluginDisabled(db, 'zai-usage', true)).toEqual({ disabled: ['zai-usage'] });
    expect(getPluginState(db)).toEqual({ disabled: ['zai-usage'] });
    expect(setPluginDisabled(db, 'zai-usage', false)).toEqual({ disabled: [] });
  });
});
