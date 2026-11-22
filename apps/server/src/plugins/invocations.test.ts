import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { PluginHost } from './host.js';
import { recordInvocation, listInvocations, purgeInvocations } from './invocations.js';
import type { PluginCaller, PluginManifest } from '@tierwyn/shared';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

const agent: PluginCaller = { kind: 'agent', conversationId: 'conv-a', sessionId: 'sess-a' };

function manifest(over: Partial<PluginManifest> & { id: string }): PluginManifest {
  return {
    name: over.id,
    version: '1.0.0',
    apiVersion: 1,
    capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true }],
    ...over,
  };
}

describe('plugin_invocations trim bound', () => {
  it('600 writes for one plugin ⇒ exactly 500 rows; other plugin untouched', () => {
    const d = db();
    for (let i = 0; i < 600; i++) {
      recordInvocation(d, {
        ts: i,
        pluginId: 'alpha',
        capability: 'echo',
        callerKind: 'agent',
        conversationId: 'c',
        ok: true,
        durationMs: 1,
        error: null,
      });
    }
    for (let i = 0; i < 3; i++) {
      recordInvocation(d, {
        ts: i,
        pluginId: 'beta',
        capability: 'echo',
        callerKind: 'operator',
        conversationId: null,
        ok: true,
        durationMs: 1,
        error: null,
      });
    }
    const alpha = d.prepare('SELECT COUNT(*) AS n FROM plugin_invocations WHERE plugin_id = ?')
      .get('alpha') as { n: number };
    const beta = d.prepare('SELECT COUNT(*) AS n FROM plugin_invocations WHERE plugin_id = ?')
      .get('beta') as { n: number };
    expect(alpha.n).toBe(500);
    expect(beta.n).toBe(3);
    const listed = listInvocations(d, 'alpha', 200);
    expect(listed).toHaveLength(200);
    expect(listed[0]!.id).toBeGreaterThan(listed[listed.length - 1]!.id);
  });

  it('audit-write failure does not fail invoke()', async () => {
    const d = db();
    d.exec('DROP TABLE plugin_invocations');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new PluginHost({ getDb: () => d });
    const ctx = host.addManifest(manifest({ id: 'demo' }), { enabled: true });
    ctx.capability('echo', async () => ({ ok: 1 }));
    host.markActivated('demo');
    const out = await host.invoke('demo', 'echo', {}, agent);
    expect(out).toEqual({ ok: true, data: { ok: 1 } });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[plugins] audit write failed'))).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes('[plugins]') && String(c[0]).includes('ok=true'))).toBe(true);
    warn.mockRestore();
    log.mockRestore();
  });

  it('purgeInvocations deletes only that plugin\'s rows', () => {
    const d = db();
    recordInvocation(d, {
      ts: 1,
      pluginId: 'alpha',
      capability: 'echo',
      callerKind: 'agent',
      conversationId: 'c1',
      ok: true,
      durationMs: 10,
      error: null,
    });
    recordInvocation(d, {
      ts: 2,
      pluginId: 'alpha',
      capability: 'echo',
      callerKind: 'agent',
      conversationId: 'c2',
      ok: false,
      durationMs: 20,
      error: 'err',
    });
    recordInvocation(d, {
      ts: 3,
      pluginId: 'beta',
      capability: 'ping',
      callerKind: 'operator',
      conversationId: null,
      ok: true,
      durationMs: 5,
      error: null,
    });

    const deleted = purgeInvocations(d, 'alpha');
    expect(deleted).toBe(2);

    expect(listInvocations(d, 'alpha')).toEqual([]);
    const betaRows = listInvocations(d, 'beta');
    expect(betaRows).toHaveLength(1);
    expect(betaRows[0]?.capability).toBe('ping');
  });
});
