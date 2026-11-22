import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/install.sh');

// `npm run`/npx export npm_config_prefix; the helper must see a clean operator env.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function parse(...args: string[]): Record<string, string> {
  const r = spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8', env: { ...process.env, TIERWYN_INSTALL_PARSE_ONLY: '1' },
  });
  expect(r.status).toBe(0);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

/** Source install.sh (helpers only) under a throwaway HOME whose stub systemctl
 *  reports a unit as installed iff $HOME/units/<name>.service exists. */
function sourced(script: string, units: string[] = [], files: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'tierwyn-hub-'));
  dirs.push(home);
  mkdirSync(join(home, 'bin'));
  mkdirSync(join(home, 'units'));
  for (const u of units) writeFileSync(join(home, 'units', `${u}.service`), '');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(home, p)), { recursive: true });
    writeFileSync(join(home, p), body);
  }
  writeFileSync(join(home, 'bin/systemctl'),
    '#!/bin/bash\n[[ $2 = cat ]] && { [[ -f $HOME/units/$3 ]]; exit; }\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', ['-c', `source "${INSTALL_SH}"\n${script}`], {
    encoding: 'utf8', env: { ...cleanEnv, HOME: home, PATH: `${join(home, 'bin')}:${process.env.PATH}` },
  });
  // the TUI probes /dev/stderr at source time; under vitest that is not a tty
  expect(r.stderr.split('\n').filter((l) => l && !l.includes('/dev/stderr'))).toEqual([]);
  return r.stdout.trim();
}

describe('install.sh: tierwyn hub …', () => {
  it('parses `update --force` (and rejects --force elsewhere)', () => {
    expect(parse('update', '--force')).toMatchObject({ CMD: 'update', TARGET: '--force' });
    expect(parse('update', 'force')).toMatchObject({ CMD: 'update', TARGET: '--force' });
    expect(spawnSync('bash', [INSTALL_SH, 'doctor', '--force'], {
      encoding: 'utf8', env: { ...process.env, TIERWYN_INSTALL_PARSE_ONLY: '1' },
    }).status).toBe(2);
  });

  it('parses `hub <verb>` and `<verb> hub` to the hub pair', () => {
    expect(parse('hub', 'restart')).toMatchObject({ CMD: 'restart', TARGET: 'hub' });
    expect(parse('restart', 'hub')).toMatchObject({ CMD: 'restart', TARGET: 'hub' });
    expect(parse('hub', 'stop')).toMatchObject({ CMD: 'stop', TARGET: 'hub' });
    expect(parse('hub', 'logs')).toMatchObject({ CMD: 'logs', TARGET: 'hub' });
    expect(parse('hub', 'status')).toMatchObject({ CMD: 'status', TARGET: 'hub' });
    // bare restart: no target → resolved pair at dispatch
    expect(parse('restart')).toMatchObject({ CMD: 'restart', TARGET: '' });
    expect(parse('restart', 'prod')).toMatchObject({ CMD: 'restart', TARGET: 'prod' });
    // node stays its own namespace
    expect(parse('node', 'restart')).toMatchObject({ CMD: 'node', NODE_ARGS: 'restart' });
  });

  it('pair prefers installed prod units (dev box) and falls back to hub', () => {
    const show = 'units_for pair; echo "${want[*]}"';
    expect(sourced(show)).toBe('tierwyn-prod tierwyn-prod-web');
    expect(sourced(show, ['tierwyn-hub', 'tierwyn-hub-web'])).toBe('tierwyn-hub tierwyn-hub-web');
    expect(sourced(show, ['tierwyn-prod', 'tierwyn-prod-web', 'tierwyn-hub'])).toBe('tierwyn-prod tierwyn-prod-web');
    // Nothing installed yet, only a hub env file → hub.
    expect(sourced(show, [], { '.config/tierwyn/hub.env': 'PORT=8790\n' })).toBe('tierwyn-hub tierwyn-hub-web');
    // Explicit targets ignore the resolution.
    expect(sourced('units_for hub; echo "${want[*]}"', ['tierwyn-prod'])).toBe('tierwyn-hub tierwyn-hub-web');
    expect(sourced('units_for prod; echo "${want[*]}"', ['tierwyn-hub'])).toBe('tierwyn-prod tierwyn-prod-web');
    expect(sourced('echo "$(pair_env)"', ['tierwyn-hub'])).toMatch(/\.config\/tierwyn\/hub\.env$/);
  });

  it('renders tierwyn-hub* from the prod templates for a hub.env', () => {
    const out = sourced(
      'render_prod_units "$HOME/.config/tierwyn/hub.env" "$HOME/ud" && ls "$HOME/ud" && cat "$HOME/ud/tierwyn-hub-web.service" "$HOME/ud/tierwyn-hub.service"',
      [], { '.config/tierwyn/hub.env': 'PORT=8790\n' },
    );
    expect(out).toMatch(/^tierwyn-hub-web\.service\ntierwyn-hub\.service\n/);
    expect(out).toContain('Requires=tierwyn-hub.service');
    expect(out).toContain('VITE_PROXY_TARGET=http://127.0.0.1:8790');
    expect(out).toContain('Description=Tierwyn hub server');
    expect(out).toMatch(/EnvironmentFile=-\S+\/\.config\/tierwyn\/hub\.env/);
    expect(out).not.toContain('tierwyn-prod');
  });

  it('prod env still renders tierwyn-prod* (dev box unchanged)', () => {
    const out = sourced('render_prod_units "$HOME/.config/tierwyn/prod.env" "$HOME/ud" && ls "$HOME/ud"',
      [], { '.config/tierwyn/prod.env': 'PORT=8788\n' });
    expect(out).toBe('tierwyn-prod-web.service\ntierwyn-prod.service');
  });

  it('npm_writable_prefix exports ~/.npm-global only when the global prefix is not writable', () => {
    const stubNpm = (prefix: string) =>
      `mkdir -p "$HOME/bin"; printf '#!/bin/bash\\n[[ $1 = prefix ]] && echo ${prefix}\\n' >"$HOME/bin/npm"; chmod +x "$HOME/bin/npm"; hash -r\n`;
    // Root-owned prefix → redirected, npmrc untouched.
    expect(sourced(`${stubNpm('/usr')}npm_writable_prefix >/dev/null; echo "$npm_config_prefix"; [[ -e $HOME/.npmrc ]] && echo npmrc`))
      .toMatch(/\/\.npm-global$/);
    // Writable prefix → left alone.
    expect(sourced(`mkdir -p "$HOME/np/lib"; ${stubNpm('$HOME/np')}npm_writable_prefix; echo "[\${npm_config_prefix:-}]"`)).toBe('[]');
    // Already configured → idempotent.
    expect(sourced(`export npm_config_prefix=/opt/x; ${stubNpm('/usr')}npm_writable_prefix; echo "$npm_config_prefix"`)).toBe('/opt/x');
  });

  it('only hub mode writes TIERWYN_DEDICATED_HUB', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    expect(src).toMatch(/\[\[ \$mode = hub \]\] && printf '[^']*TIERWYN_DEDICATED_HUB=1/);
  });

  it('requires TIERWYN_OPERATOR_PASSWORD for --yes hub/prod, never writes it to the env file', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    expect(src).toMatch(/hub\/prod --yes needs TIERWYN_OPERATOR_PASSWORD/);
    expect(src).toMatch(/unset TIERWYN_OPERATOR_PASSWORD/);
    expect(src).toMatch(/TIERWYN_COOKIE_SECURE/);
  });
});
