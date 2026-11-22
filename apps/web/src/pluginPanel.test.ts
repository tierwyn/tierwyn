import { describe, expect, it } from 'vitest';
import { credentialRowLabel, invocationLine, deleteConfirmText, isPluginArchiveName } from './pluginPanel.js';
import type { PluginCredentialStatus, PluginInvocationRow } from '@tierwyn/shared';

const SECRET = 'should-never-appear-in-label';

describe('credentialRowLabel', () => {
  it('shapes status without emitting a value', () => {
    expect(credentialRowLabel({
      key: 'DEMO_KEY', configured: false, source: undefined, updatedAt: null,
    })).toBe('Not set');
    expect(credentialRowLabel({
      key: 'DEMO_KEY', configured: true, source: 'env', updatedAt: null,
    })).toBe('Set (env, restart to change)');
    const vault: PluginCredentialStatus = {
      key: 'DEMO_KEY', configured: true, source: 'vault', updatedAt: Date.UTC(2026, 7, 30, 12, 0, 0),
    };
    expect(credentialRowLabel(vault)).toBe('Set (vault, 2026-08-30 12:00 UTC)');
    expect(credentialRowLabel({
      key: 'DEMO_KEY', configured: true, source: 'vault', updatedAt: null,
    })).toBe('Set (vault)');
    expect(credentialRowLabel({
      key: 'DEMO_KEY', configured: false, source: 'vault', updatedAt: Date.UTC(2026, 7, 30, 12, 0, 0), needsReentry: true,
    })).toBe('Set (vault, needs re-entry)');
    expect(credentialRowLabel(vault)).not.toContain(SECRET);
  });
});

describe('invocationLine', () => {
  it('formats a row and never emits a credential value', () => {
    const row: PluginInvocationRow = {
      id: 7,
      ts: Date.UTC(2026, 7, 30, 12, 0, 0),
      pluginId: 'zai-usage',
      capability: 'usage.get',
      callerKind: 'agent',
      conversationId: 'conv-1',
      ok: false,
      durationMs: 42,
      error: 'upstream failed',
    };
    const line = invocationLine(row);
    expect(line).toBe('2026-08-30T12:00:00.000Z usage.get agent conv-1 fail 42ms upstream failed');
    expect(line).not.toContain(SECRET);
    const ok = invocationLine({ ...row, ok: true, error: null, conversationId: null, callerKind: 'operator' });
    expect(ok).toBe('2026-08-30T12:00:00.000Z usage.get operator ok 42ms');
  });
});

describe('deleteConfirmText', () => {
  it('deleteConfirmText names the plugin and the purged state', () => {
    const text = deleteConfirmText({ id: 'zai-usage', name: 'Z.ai Usage' });
    expect(text).toContain('Delete plugin "Z.ai Usage" (zai-usage)?');
    expect(text).toContain('Its files, stored credentials, settings and invocation history will be removed.');
  });
});

describe('isPluginArchiveName', () => {
  it('isPluginArchiveName accepts .tar.gz and .tgz, rejects .zip', () => {
    expect(isPluginArchiveName('plugin.tar.gz')).toBe(true);
    expect(isPluginArchiveName('my-plugin-v1.0.0.TAR.GZ')).toBe(true);
    expect(isPluginArchiveName('bundle.tgz')).toBe(true);
    expect(isPluginArchiveName('BUNDLE.TGZ')).toBe(true);
    expect(isPluginArchiveName('plugin.zip')).toBe(false);
    expect(isPluginArchiveName('plugin.tar')).toBe(false);
    expect(isPluginArchiveName('tar.gz')).toBe(false);
  });
});
