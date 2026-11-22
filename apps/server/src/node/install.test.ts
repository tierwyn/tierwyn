import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildPrereqPrefix, runInstall, withWritableNpmPrefix } from './install.js';
import { AGENT_BINARIES } from '../discovery.js';

describe('buildPrereqPrefix', () => {
  it('returns empty string when prereqs is empty or undefined', () => {
    expect(buildPrereqPrefix()).toBe('');
    expect(buildPrereqPrefix([])).toBe('');
  });

  it('builds a safe shell check/install prefix for valid binary names', () => {
    const prefix = buildPrereqPrefix(['unzip']);
    expect(prefix).toContain('if ! command -v unzip >/dev/null 2>&1; then');
    expect(prefix).toContain('sudo -n apt-get install -y unzip');
    expect(prefix.endsWith(' && ')).toBe(true);
  });

  it('rejects unsafe binary names', () => {
    expect(() => buildPrereqPrefix(['unzip; rm -rf /'])).toThrow(/unsafe prereq binary name/);
  });
});

describe('runInstall', () => {
  it('gives the command a CURL_HOME whose .curlrc aborts stalled downloads, then removes it', async () => {
    const r = await runInstall('echo "$CURL_HOME"; cat "$CURL_HOME/.curlrc"');
    const dir = r.tail.split('\n')[0];
    expect(r.tail).toContain('speed-limit = 1024');
    expect(existsSync(dir)).toBe(false);
  });

  it('resolves code 0 with a combined stdout+stderr tail on success', async () => {
    const r = await runInstall('echo out-marker; echo err-marker 1>&2');
    expect(r.code).toBe(0);
    expect(r.tail).toContain('out-marker');
    expect(r.tail).toContain('err-marker');
  });

  it('keeps at most a 4 KiB tail', async () => {
    const r = await runInstall('seq 1 5000');
    expect(r.code).toBe(0);
    expect(r.tail.length).toBeLessThanOrEqual(4096);
    expect(r.tail.endsWith('5000\n')).toBe(true);
  });

  it('resolves the exit code and stderr on failure', async () => {
    const r = await runInstall('echo "fatal: boom" 1>&2; exit 3');
    expect(r.code).toBe(3);
    expect(r.tail).toContain('fatal: boom');
  });

  it('kills a hung command at the timeout (code null)', async () => {
    const r = await runInstall('echo started; sleep 30', { timeoutMs: 200 });
    expect(r.code).toBeNull();
    expect(r.tail).toContain('started');
  });

  it('never rejects — a spawn error resolves code 1 with the error tail', async () => {
    const r = await runInstall('echo hi', { sh: '/nonexistent/shell' });
    expect(r.code).toBe(1);
    expect(r.tail).toContain('nonexistent');
  });

  it('passes through when prereqs are already present on PATH', async () => {
    const r = await runInstall('echo after-prereq', { prereqs: ['sh'] });
    expect(r.code).toBe(0);
    expect(r.tail).toContain('after-prereq');
  });

  it('resolves code 1 when an unsafe prereq name is passed', async () => {
    const r = await runInstall('echo hi', { prereqs: ['bad;name'] });
    expect(r.code).toBe(1);
    expect(r.tail).toContain('unsafe prereq binary name');
  });
});

describe('withWritableNpmPrefix', () => {
  it('leaves curl installers and other commands untouched', () => {
    for (const b of Object.values(AGENT_BINARIES)) {
      if (b.install && !b.install.startsWith('npm ')) expect(withWritableNpmPrefix(b.install)).toBe(b.install);
    }
  });

  it('wraps npm i -g once, keeping the pinned command verbatim at the end', () => {
    const w = withWritableNpmPrefix('npm i -g @openai/codex');
    expect(w.endsWith(' && npm i -g @openai/codex')).toBe(true);
    expect(withWritableNpmPrefix(w)).toBe(w);
  });

  /** Run the wrapped command with a stub npm whose global prefix is `prefix`;
   *  the stub echoes the prefix npm would install into. */
  function run(prefix: string, env: Record<string, string> = {}): string {
    const home = mkdtempSync(join(tmpdir(), 'npmprefix-'));
    try {
      mkdirSync(join(home, 'bin'));
      writeFileSync(join(home, 'bin/npm'),
        `#!/bin/sh\nif [ "$1" = prefix ]; then echo ${prefix.replace('$HOME', home)}; else echo "into=\${npm_config_prefix:-default}"; fi\n`, { mode: 0o755 });
      mkdirSync(join(home, 'np/lib'), { recursive: true });
      const r = spawnSync('/bin/sh', ['-c', withWritableNpmPrefix('npm i -g x')], {
        encoding: 'utf8', env: { PATH: `${join(home, 'bin')}:/usr/bin:/bin`, HOME: home, ...env },
      });
      return r.stdout.trim().replace(home, '~') + (existsSync(join(home, '.npm-global/bin')) ? ' +dir' : '');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  it('redirects a root-owned prefix to ~/.npm-global (env only)', () => {
    expect(run('/usr')).toBe('into=~/.npm-global +dir');
  });
  it('keeps a writable prefix', () => {
    expect(run('$HOME/np')).toBe('into=default');
  });
  it('is a no-op when the prefix is already set in env', () => {
    expect(run('/usr', { npm_config_prefix: '/opt/x' })).toBe('into=/opt/x');
  });
  it('a failing prereq prefix still stops the install', () => {
    const r = spawnSync('/bin/sh', ['-c', `false && ${withWritableNpmPrefix('npm i -g x')}; echo rc=$?`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('rc=1');
  });
});
