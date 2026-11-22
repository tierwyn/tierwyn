import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import {
  parseCliVersion,
  compareVersions,
  isBehind,
  probeInstalledVersion,
  fetchLatestNpm,
  fetchLatestGitHub,
  fetchLatestFeed,
  refreshAgentVersions,
  VERSION_SETTINGS_KEY,
  loadVersionCache,
} from './versions.js';
import { AGENT_BINARIES } from './discovery.js';

function createDb() {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

describe('parseCliVersion', () => {
  it('extracts semver from Claude Code output', () => {
    expect(parseCliVersion('2.1.286 (Claude Code)')).toBe('2.1.286');
  });

  it('extracts semver from codex-cli output', () => {
    expect(parseCliVersion('codex-cli 0.151.0')).toBe('0.151.0');
  });

  it('extracts semver from Qwen Code output', () => {
    expect(parseCliVersion('Qwen Code 0.22.3')).toBe('0.22.3');
  });

  it('extracts clean 3-part semver', () => {
    expect(parseCliVersion('1.0.98')).toBe('1.0.98');
  });

  it('extracts date-style version with git hash suffix', () => {
    expect(parseCliVersion('2026.10.14-0f9edde')).toBe('2026.10.14-0f9edde');
  });

  it('handles multiline/ASCII-art output', () => {
    const text = `
    .-------.
   /  OPEN   \\
  |   CLAW    |  v1.4.12-beta.1
   \\         /
    '-------'
    `;
    expect(parseCliVersion(text)).toBe('1.4.12-beta.1');
  });

  it('returns undefined when no semver-like token matches', () => {
    expect(parseCliVersion('no match')).toBeUndefined();
    expect(parseCliVersion('')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('handles numeric comparisons in major, minor, patch', () => {
    expect(compareVersions('2.1.286', '2.1.300')).toBe(-1);
    expect(compareVersions('2.1.300', '2.1.286')).toBe(1);
    expect(compareVersions('0.39.1', '2.2.0')).toBe(-1);
    expect(compareVersions('2.2.0', '0.39.1')).toBe(1);
  });

  it('release WITHOUT prerelease is greater than one WITH prerelease', () => {
    expect(compareVersions('1.0.98-0', '1.0.98')).toBe(-1);
    expect(compareVersions('1.0.98', '1.0.98-0')).toBe(1);
  });

  it('compares date-style versions correctly', () => {
    expect(compareVersions('2026.10.14-0f9edde', '2026.10.15')).toBe(-1);
    expect(compareVersions('2026.10.15', '2026.10.14-0f9edde')).toBe(1);
  });

  it('returns 0 for identical prerelease strings and two prereleases with identical cores', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(0);
  });

  it('returns undefined for non-numeric core unless identical', () => {
    expect(compareVersions('foo.bar.baz', '1.2.3')).toBeUndefined();
    expect(compareVersions('foo.bar.baz', 'foo.bar.baz')).toBe(0);
  });
});

describe('isBehind', () => {
  it('returns true when installed is older than latest', () => {
    expect(isBehind('1.0.0', '1.1.0')).toBe(true);
    expect(isBehind('v2.1.286', '2.1.300')).toBe(true);
  });

  it('returns false when current or newer', () => {
    expect(isBehind('1.1.0', '1.1.0')).toBe(false);
    expect(isBehind('1.2.0', '1.1.0')).toBe(false);
  });

  it('returns undefined when either side is missing or invalid', () => {
    expect(isBehind(undefined, '1.1.0')).toBeUndefined();
    expect(isBehind('1.0.0', undefined)).toBeUndefined();
    expect(isBehind('invalid', '1.0.0')).toBeUndefined();
    expect(isBehind('1.0.0', 'invalid')).toBeUndefined();
  });
});

describe('fetchLatestNpm', () => {
  it('returns version on happy path 200', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '2.1.300' }),
    });
    const ver = await fetchLatestNpm('@anthropic-ai/claude-code', stub as unknown as typeof fetch);
    expect(ver).toBe('2.1.300');
  });

  it('returns undefined on 404', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    const ver = await fetchLatestNpm('nonexistent-pkg', stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });

  it('returns undefined on invalid JSON', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json'); },
    });
    const ver = await fetchLatestNpm('pkg', stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });

  it('returns undefined on network/thrown error', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('network down'));
    const ver = await fetchLatestNpm('pkg', stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });
});

describe('fetchLatestGitHub', () => {
  it('returns tag on happy path 200, stripping leading v', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v0.3.5' }),
    });
    const ver = await fetchLatestGitHub('sst/opencode', stub as unknown as typeof fetch);
    expect(ver).toBe('0.3.5');
  });

  it('returns undefined on 404', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    const ver = await fetchLatestGitHub('user/repo', stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });

  it('returns undefined on invalid JSON', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json'); },
    });
    const ver = await fetchLatestGitHub('user/repo', stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('network failure'));
    const ver = await fetchLatestGitHub('user/repo', stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });
});

describe('fetchLatestFeed', () => {
  it('reads the version field from a json manifest (kiro)', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '2.34.0', files: [] }),
    });
    const ver = await fetchLatestFeed(
      { url: 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json', kind: 'json' },
      stub as unknown as typeof fetch,
    );
    expect(ver).toBe('2.34.0');
    expect(stub).toHaveBeenCalledWith('https://prod.download.cli.kiro.dev/stable/latest/manifest.json', expect.anything());
  });

  it('trims a bare version string body (grok-build)', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '  1.0.70\n',
    });
    const ver = await fetchLatestFeed({ url: 'https://x.ai/cli/stable', kind: 'text' }, stub as unknown as typeof fetch);
    expect(ver).toBe('1.0.70');
  });

  it('rejects a text body that merely CONTAINS a version (HTML error page)', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><title>Service — Ray 1.2.3</title><p>under maintenance</p>',
    });
    const ver = await fetchLatestFeed({ url: 'https://x.ai/cli/stable', kind: 'text' }, stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });

  it('extracts the release embedded in an install script (cursor, date-style)', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => [
        '#!/bin/sh',
        '# cursor installer',
        'URL="https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/x64/CursorCLI.tar.gz"',
        'curl -fsSL "$URL" | tar xz',
      ].join('\n'),
    });
    const ver = await fetchLatestFeed(
      { url: 'https://cursor.com/install', kind: 'script' },
      stub as unknown as typeof fetch,
    );
    expect(ver).toBe('2026.10.22-27dcf5f');
  });

  it('returns undefined on non-200', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const ver = await fetchLatestFeed({ url: 'https://x.ai/cli/stable', kind: 'text' }, stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });

  it('returns undefined on garbage bodies for every kind', async () => {
    const garbage = '<html>under maintenance</html>';
    for (const kind of ['json', 'text', 'script'] as const) {
      const stub = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => garbage });
      const ver = await fetchLatestFeed({ url: 'https://example.com/feed', kind }, stub as unknown as typeof fetch);
      expect(ver, kind).toBeUndefined();
    }
  });

  it('returns undefined on network error', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('dns fail'));
    const ver = await fetchLatestFeed({ url: 'https://example.com/feed', kind: 'json' }, stub as unknown as typeof fetch);
    expect(ver).toBeUndefined();
  });
});

describe('probeInstalledVersion', () => {
  it('parses version from noisy stdout/stderr', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'some banner\nClaude Code v2.1.286\n',
      stderr: '',
    });
    const ver = await probeInstalledVersion('claude', exec);
    expect(ver).toBe('2.1.286');
  });

  it('returns undefined when runner throws/errors', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('command not found'));
    const ver = await probeInstalledVersion('missing-bin', exec, 0);
    expect(ver).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('retries once and succeeds when the first probe errors', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ stdout: 'hermes v0.22.5\n', stderr: '' });
    const ver = await probeInstalledVersion('hermes', exec, 0);
    expect(ver).toBe('0.22.5');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first probe returns unparsable output', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'garbage', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'dsh 0.1.2-rc.1', stderr: '' });
    const ver = await probeInstalledVersion('dsh', exec, 0);
    expect(ver).toBe('0.1.2-rc.1');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('stays undefined when both attempts fail', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('still down'));
    const ver = await probeInstalledVersion('bin', exec, 0);
    expect(ver).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the first probe succeeds', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'v1.0.0', stderr: '' });
    const ver = await probeInstalledVersion('bin', exec, 0);
    expect(ver).toBe('1.0.0');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('refreshAgentVersions', () => {
  it('writes version cache to settings table and respects 12h TTL', async () => {
    const db = createDb();
    let time = 1_000_000;
    const now = () => time;

    const probe = vi.fn().mockResolvedValue('1.0.0');
    const npm = vi.fn().mockResolvedValue('1.2.0');
    const github = vi.fn().mockResolvedValue('0.9.0');

    // First call: populates cache
    const firstCache = await refreshAgentVersions(db, {
      now,
      probe,
      npm,
      github,
    });

    expect(firstCache['claude-code']?.latest).toBe('1.2.0');
    expect(firstCache['opencode']?.latest).toBe('0.9.0');

    // Verify row in settings table
    const stored = loadVersionCache(db);
    expect(stored['claude-code']?.latest).toBe('1.2.0');

    // Second call within TTL (e.g. 1 hour later) with different probe responses
    time += 3_600_000;
    const probe2 = vi.fn().mockResolvedValue('9.9.9');
    const npm2 = vi.fn().mockResolvedValue('9.9.9');
    const github2 = vi.fn().mockResolvedValue('9.9.9');

    const secondCache = await refreshAgentVersions(db, {
      now,
      probe: probe2,
      npm: npm2,
      github: github2,
    });

    // Kept cached value because it is within 12h TTL
    expect(secondCache['claude-code']?.latest).toBe('1.2.0');
    expect(npm2).not.toHaveBeenCalled();

    // Third call with force: true re-probes
    const forcedCache = await refreshAgentVersions(db, {
      now,
      probe: probe2,
      npm: npm2,
      github: github2,
      force: true,
    });
    expect(forcedCache['claude-code']?.latest).toBe('9.9.9');
    expect(npm2).toHaveBeenCalled();
  });

  it('routes each agent to its latest-version source: npm, GitHub, or feed', async () => {
    const db = createDb();
    const probe = vi.fn().mockResolvedValue(undefined);
    const npm = vi.fn().mockResolvedValue(undefined);
    const github = vi.fn().mockResolvedValue(undefined);
    const feed = vi.fn().mockResolvedValue(undefined);

    await refreshAgentVersions(db, { now: () => 1, probe, npm, github, feed, force: true });

    // pkg → npm (deepseek from the previous round), releasesRepo → GitHub (antigravity),
    // latestFeed → feed (kiro / grok-build / cursor) — exactly one source each.
    expect(npm).toHaveBeenCalledWith('@deepseek-ai/dsh');
    expect(github).toHaveBeenCalledWith('google-antigravity/antigravity-cli');
    expect(feed).toHaveBeenCalledWith(AGENT_BINARIES.kiro.latestFeed);
    expect(feed).toHaveBeenCalledWith(AGENT_BINARIES['grok-build'].latestFeed);
    expect(feed).toHaveBeenCalledWith(AGENT_BINARIES.cursor.latestFeed);
    expect(feed).toHaveBeenCalledTimes(3);
    // Feed agents must not leak into the npm/GitHub sources and vice versa.
    expect(npm).not.toHaveBeenCalledWith('https://x.ai/cli/stable');
    expect(github).not.toHaveBeenCalledWith('google-antigravity/antigravity-cli', expect.anything());
  });

  it('keeps previous cached values when subsequent lookup fails', async () => {
    const db = createDb();
    let time = 1_000_000;
    const now = () => time;

    await refreshAgentVersions(db, {
      now,
      probe: async () => '1.0.0',
      npm: async () => '1.5.0',
      github: async () => '1.5.0',
    });

    time += 24 * 60 * 60 * 1000; // 24 hours later (expired TTL)

    // Failed lookup returns undefined
    const cache = await refreshAgentVersions(db, {
      now,
      probe: async () => undefined,
      npm: async () => undefined,
      github: async () => undefined,
    });

    // Should retain previous values
    expect(cache['claude-code']?.latest).toBe('1.5.0');
  });

  it('never probes grok-bot binary', async () => {
    const db = createDb();
    const probe = vi.fn().mockResolvedValue('1.0.0');

    await refreshAgentVersions(db, {
      probe,
      npm: async () => '1.0.0',
      github: async () => '1.0.0',
      force: true,
    });

    // probe should never have been called with /opt/Grok Bot/grok-bot
    for (const call of probe.mock.calls) {
      expect(call[0]).not.toContain('Grok Bot');
    }
  });
});
