import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/install.sh');
const MARKER = 'TIERWYN_HUB_PKG_SHA256=""  # hub substitutes this line when serving /node/install.sh';

const haveBash = spawnSync('bash', ['-c', 'command -v sha256sum && command -v tar'], { encoding: 'utf8' }).status === 0;
const REAL_TAR = spawnSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-inst-pkg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stub(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function makeStubs(home: string): string {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  stub(bin, 'curl', `
echo "curl $*" >> "$HOME/curl.log"
for a in "$@"; do echo "$a" >> "$HOME/curl.args"; done
out=""
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  [[ \${args[i]} = -o ]] && out=\${args[i+1]}
done
[[ -n $out ]] && cp "$HOME/fixture.tgz" "$out"
printf 200
`);
  stub(bin, 'git', `
echo "git $*" >> "$HOME/git.log"
if [[ $1 = clone ]]; then dest=\${@: -1}; mkdir -p "\$dest/.git" "\$dest/scripts"; echo clone-ok > "\$dest/.git/ok"; fi
`);
  stub(bin, 'node', `
echo "node $*" >> "$HOME/node.log"
[[ $1 = -v ]] && { echo v24.22.1; exit 0; }
[[ $1 = -p ]] && { echo 24; exit 0; }
[[ $1 = -e ]] && exit 0
if [[ $* == *self-check* ]]; then echo '{"buildId":"x","source":"package","sqlite":true,"profiles":1}'; exit \${SELFCHECK_RC:-0}; fi
if [[ $* == *package-fetch* ]]; then
  out=""
  args=("$@")
  for ((i=0; i<\${#args[@]}; i++)); do [[ \${args[i]} = --out ]] && out=\${args[i+1]}; done
  [[ -n $out ]] && cp "$HOME/fixture.tgz" "$out"
  echo "\${FETCH_ID:-fetched-id}"
  if [[ \${FETCH_RC:-0} != 0 ]]; then echo "package-fetch failed: stub" >&2; fi
  exit \${FETCH_RC:-0}
fi
exit 0
`);
  stub(bin, 'npm', `echo "npm $*" >> "$HOME/npm.log"`);
  stub(bin, 'systemctl', `
echo "systemctl $*" >> "$HOME/systemctl.log"
if [[ $* == *restart* ]]; then
  echo restart >> "$HOME/systemctl.restart"
  if [[ \${SYSTEMCTL_FAIL_AFTER_RESTART:-} = 1 && ! -f $HOME/rolled_back ]]; then
    touch "$HOME/fail_is_active"
  fi
  if [[ \${SYSTEMCTL_RESTART_FAIL:-} = 1 && ! -f $HOME/rolled_back ]]; then
    touch "$HOME/fail_is_active"
    exit 1
  fi
fi
if [[ $* == *is-active* ]]; then
  if [[ -f $HOME/fail_is_active ]]; then echo inactive; exit 1; fi
  echo "\${SYSTEMCTL_ACTIVE:-active}"
  [[ \${SYSTEMCTL_ACTIVE:-active} = active ]]
  exit
fi
exit 0
`);
  stub(bin, 'sudo', `echo "sudo $*" >> "$HOME/sudo.log"`);
  stub(bin, 'tar', `
if [[ \${TAR_FAIL:-} = 1 ]]; then
  dest=""
  args=("$@")
  for ((i=0; i<\${#args[@]}; i++)); do [[ \${args[i]} = -C ]] && dest=\${args[i+1]}; done
  [[ -n $dest ]] || exit 1
  mkdir -p "\$dest/apps/server/dist/node" "\$dest/scripts"
  echo test-build > "\$dest/BUILD_ID"
  echo 'console.log("partial")' > "\$dest/apps/server/dist/node/main.js"
  exit 1
fi
exec "${REAL_TAR}" "$@"
`);
  return bin;
}

function fixtureTgz(home: string, opts: { realInstall?: boolean } = {}): { tgz: string; sha: string } {
  const staging = join(home, 'stage');
  const tree = join(staging, 'tierwyn-node');
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  mkdirSync(join(tree, 'apps/server/dist/node'), { recursive: true });
  mkdirSync(join(tree, 'docs/deploy/systemd'), { recursive: true });
  writeFileSync(join(tree, 'BUILD_ID'), 'test-build\n');
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'tierwyn', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(tree, 'apps/server/package.json'), JSON.stringify({ name: '@tierwyn/server-node', private: true, type: 'module' }) + '\n');
  if (opts.realInstall) {
    writeFileSync(join(tree, 'scripts/install.sh'), readFileSync(INSTALL_SH));
    chmodSync(join(tree, 'scripts/install.sh'), 0o755);
  } else {
    writeFileSync(join(tree, 'scripts/install.sh'), '#!/bin/bash\necho "reexec $*" >> "$HOME/reexec.log"\nexit 0\n', { mode: 0o755 });
  }
  writeFileSync(join(tree, 'apps/server/dist/node/main.js'), 'console.log("stub-main"); // package-fetch\n');
  writeFileSync(join(tree, 'docs/deploy/systemd/tierwyn-node.service'), '[Service]\nExecStart=/usr/bin/env node %h/tierwyn-node/apps/server/dist/node/main.js run\n');
  const tgz = join(home, 'fixture.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', staging, 'tierwyn-node']);
  return { tgz, sha: sha256(tgz) };
}

function markedScript(sha: string): string {
  const src = readFileSync(INSTALL_SH, 'utf8');
  if (!src.includes(MARKER)) throw new Error('marker line missing from install.sh');
  return src.replace(MARKER, `TIERWYN_HUB_PKG_SHA256="${sha}"`);
}

function runPiped(script: string, args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const bin = makeStubs(home);
  return spawnSync('bash', ['-s', '--', ...args], {
    input: script,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      YES: '1',
      TIERWYN_TUI: '0',
      NO_COLOR: '1',
      ...extraEnv,
    },
  });
}

function packageRoot(home: string): string {
  const root = join(home, 'tierwyn-node');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'apps/server/dist/node'), { recursive: true });
  mkdirSync(join(root, 'docs/deploy/systemd'), { recursive: true });
  writeFileSync(join(root, 'BUILD_ID'), 'pkg-id\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tierwyn', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(root, 'apps/server/package.json'), '{}\n');
  writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
  writeFileSync(join(root, 'docs/deploy/systemd/tierwyn-node.service'),
    '[Service]\nExecStart=/usr/bin/env node %h/tierwyn-node/apps/server/dist/node/main.js run\n');
  writeFileSync(join(root, 'scripts/install.sh'), readFileSync(INSTALL_SH));
  chmodSync(join(root, 'scripts/install.sh'), 0o755);
  return root;
}

function gitRoot(home: string): string {
  const root = join(home, 'tierwyn');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'apps/server/dist/node'), { recursive: true });
  mkdirSync(join(root, 'docs/deploy/systemd'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tierwyn', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main")\n');
  writeFileSync(join(root, 'docs/deploy/systemd/tierwyn-node.service'),
    '[Service]\nExecStart=/usr/bin/env node %h/tierwyn-node/apps/server/dist/node/main.js run\n');
  writeFileSync(join(root, 'scripts/install.sh'), readFileSync(INSTALL_SH));
  chmodSync(join(root, 'scripts/install.sh'), 0o755);
  return root;
}

function runFrom(root: string, args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const bin = makeStubs(home);
  return spawnSync('bash', [join(root, 'scripts/install.sh'), '--yes', ...args], {
    encoding: 'utf8',
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      YES: '1',
      TIERWYN_TUI: '0',
      NO_COLOR: '1',
      ...extraEnv,
    },
  });
}

const describeIf = haveBash ? describe : describe.skip;

describeIf('installer package bootstrap', () => {
  it('raw script (empty marker) → clones via git, never fetches package.tgz', () => {
    const home = tmp();
    fixtureTgz(home);
    const r = runPiped(readFileSync(INSTALL_SH, 'utf8'), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(readFileSync(join(home, 'git.log'), 'utf8')).toMatch(/clone/);
    expect(existsSync(join(home, 'curl.log'))).toBe(false);
    expect(r.status).not.toBe(null);
  });

  it('ambient TIERWYN_HUB_PKG_SHA256 env doesn\'t flip a raw script to the hub path', () => {
    const home = tmp();
    fixtureTgz(home);
    const r = runPiped(readFileSync(INSTALL_SH, 'utf8'), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home, {
      TIERWYN_HUB_PKG_SHA256: 'a'.repeat(64),
    });
    expect(existsSync(join(home, 'curl.log'))).toBe(false);
    expect(readFileSync(join(home, 'git.log'), 'utf8')).toMatch(/clone/);
    expect(r.status).not.toBe(null);
  });

  it('marked script → downloads with Authorization, extracts to ~/tierwyn-node, re-execs', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok-secret'], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'curl.args'), 'utf8')).toContain('Authorization: Bearer tok-secret');
    expect(existsSync(join(home, 'tierwyn-node', 'BUILD_ID'))).toBe(true);
    expect(readFileSync(join(home, 'reexec.log'), 'utf8')).toMatch(/node setup/);
    expect(readFileSync(join(home, 'reexec.log'), 'utf8')).toMatch(/node enroll/);
  });

  it('token never appears in the fetched URL', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok-secret'], home);
    const args = readFileSync(join(home, 'curl.args'), 'utf8');
    const urls = args.split('\n').filter((l) => l.startsWith('http'));
    expect(urls.join('\n')).not.toContain('tok-secret');
    expect(urls.join('\n')).toContain('/node/package.tgz');
  });

  it('sha mismatch → dies "re-run the one-liner", no target dir, enroll never called', () => {
    const home = tmp();
    fixtureTgz(home);
    const r = runPiped(markedScript('ab'.repeat(32)), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/re-run the one-liner/);
    expect(existsSync(join(home, 'tierwyn-node'))).toBe(false);
    expect(existsSync(join(home, 'reexec.log'))).toBe(false);
  });

  it('http:// hub without --allow-http → dies before any curl', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'http://hub.example', '--token', 'tok'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/allow-http/);
    expect(existsSync(join(home, 'curl.log'))).toBe(false);
  });

  it('http:// hub with --allow-http → proceeds and passes --allow-http to enroll', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'http://hub.example', '--token', 'tok', '--allow-http'], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'reexec.log'), 'utf8')).toMatch(/--allow-http/);
  });

  it('marker + non-enroll subcommand or missing --hub/--token → usage error', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'status'], home);
    expect(r.status).not.toBe(0);
    const r2 = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example'], home);
    expect(r2.status).not.toBe(0);
  });

  it('target has .git → dies', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    mkdirSync(join(home, 'tierwyn-node', '.git'), { recursive: true });
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/git checkout/);
  });

  it('target non-empty without BUILD_ID → dies', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    mkdirSync(join(home, 'tierwyn-node'), { recursive: true });
    writeFileSync(join(home, 'tierwyn-node', 'noise'), 'x');
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not empty/);
  });

  it('target with BUILD_ID → swapped, .prev kept', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    mkdirSync(join(home, 'tierwyn-node'), { recursive: true });
    writeFileSync(join(home, 'tierwyn-node', 'BUILD_ID'), 'old\n');
    writeFileSync(join(home, 'tierwyn-node', 'kept-old'), 'old');
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, 'tierwyn-node.prev', 'kept-old'))).toBe(true);
    expect(readFileSync(join(home, 'tierwyn-node', 'BUILD_ID'), 'utf8').trim()).toBe('test-build');
  });

  it('pkg_swap: tar failure after partial extract does not swap', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home, {
      TAR_FAIL: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/extract failed/);
    expect(existsSync(join(home, 'tierwyn-node'))).toBe(false);
    expect(readdirSync(home).filter((n) => n.startsWith('tierwyn-node.new'))).toEqual([]);
  });

  it('stale unit pointing at a deleted git checkout does not abort bootstrap', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const gone = join(home, 'tierwyn-gone');
    const ndir = join(home, '.config/tierwyn/node');
    mkdirSync(ndir, { recursive: true });
    writeFileSync(join(ndir, 'node.json'), JSON.stringify({ hostId: 'keep-me', hubUrl: 'https://hub.example' }));
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    writeFileSync(join(home, '.config/systemd/user/tierwyn-node.service'),
      `ExecStart=/usr/bin/node ${gone}/apps/server/dist/node/main.js run\n`);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, 'tierwyn-node', 'BUILD_ID'))).toBe(true);
  });

  it('enrolled git host → dies pointing at update --from-hub; config and key untouched', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const git = join(home, 'tierwyn');
    mkdirSync(join(git, '.git'), { recursive: true });
    mkdirSync(join(git, 'apps/server/dist/node'), { recursive: true });
    writeFileSync(join(git, 'apps/server/dist/node/main.js'), 'x');
    const ndir = join(home, '.config/tierwyn/node');
    mkdirSync(ndir, { recursive: true });
    writeFileSync(join(ndir, 'node.json'), JSON.stringify({ hostId: 'keep-me', hubUrl: 'https://hub.example' }));
    writeFileSync(join(ndir, 'key'), 'SECRET-KEY');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    writeFileSync(join(home, '.config/systemd/user/tierwyn-node.service'),
      `ExecStart=/usr/bin/node ${git}/apps/server/dist/node/main.js run\n`);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/update --from-hub/);
    expect(JSON.parse(readFileSync(join(ndir, 'node.json'), 'utf8')).hostId).toBe('keep-me');
    expect(readFileSync(join(ndir, 'key'), 'utf8')).toBe('SECRET-KEY');
  });

  it('TIERWYN_NODE_REENROLL=1 → proceeds', () => {
    const home = tmp();
    const { sha } = fixtureTgz(home);
    const git = join(home, 'tierwyn');
    mkdirSync(join(git, '.git'), { recursive: true });
    mkdirSync(join(git, 'apps/server/dist/node'), { recursive: true });
    writeFileSync(join(git, 'apps/server/dist/node/main.js'), 'x');
    const ndir = join(home, '.config/tierwyn/node');
    mkdirSync(ndir, { recursive: true });
    writeFileSync(join(ndir, 'node.json'), JSON.stringify({ hostId: 'h' }));
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    writeFileSync(join(home, '.config/systemd/user/tierwyn-node.service'),
      `ExecStart=/usr/bin/node ${git}/apps/server/dist/node/main.js run\n`);
    const r = runPiped(markedScript(sha), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home, {
      TIERWYN_NODE_REENROLL: '1',
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, 'tierwyn-node', 'BUILD_ID'))).toBe(true);
  });

  it('raw script with TIERWYN_DIR at a BUILD_ID dir → dies, no git clone', () => {
    const home = tmp();
    fixtureTgz(home);
    const pkg = join(home, 'already-pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'BUILD_ID'), 'x');
    const r = runPiped(readFileSync(INSTALL_SH, 'utf8'), ['--yes', 'node', 'enroll', '--hub', 'https://hub.example', '--token', 'tok'], home, {
      TIERWYN_DIR: pkg,
    });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(home, 'git.log'))).toBe(false);
  });

  it('from extracted package root: node setup skips npm ci and build, renders unit, installs shim', () => {
    const home = tmp();
    const root = packageRoot(home);
    const r = runFrom(root, ['node', 'setup'], home);
    expect(r.status).toBe(0);
    const npmLog = existsSync(join(home, 'npm.log')) ? readFileSync(join(home, 'npm.log'), 'utf8') : '';
    expect(npmLog).not.toMatch(/\bnpm ci\b/);
    expect(npmLog).not.toMatch(/\bnpm run build\b/);
    expect(existsSync(join(home, '.config/systemd/user/tierwyn-node.service'))).toBe(true);
    const unit = readFileSync(join(home, '.config/systemd/user/tierwyn-node.service'), 'utf8');
    expect(unit).toContain(root);
    expect(existsSync(join(home, '.local/bin/tierwyn'))).toBe(true);
  });

  it('tierwyn update|setup|doctor|config → dies node-only package install', () => {
    const home = tmp();
    const root = packageRoot(home);
    for (const cmd of ['update', 'setup', 'doctor', 'config']) {
      const r = runFrom(root, [cmd], home);
      expect(r.status, cmd).not.toBe(0);
      expect(r.stderr + r.stdout, cmd).toMatch(/node-only package install/);
    }
  });

  it('node status → reaches main.js', () => {
    const home = tmp();
    const root = packageRoot(home);
    const r = runFrom(root, ['node', 'status'], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'node.log'), 'utf8')).toMatch(/status/);
  });

  it('from a git root: node setup still runs npm ci + builds', () => {
    const home = tmp();
    const root = gitRoot(home);
    const r = runFrom(root, ['node', 'setup'], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'npm.log'), 'utf8')).toMatch(/ci/);
  });

  const REAL_NODE_UNIT = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/deploy/systemd/tierwyn-node.service');

  function workingDirectory(unit: string): string | undefined {
    return unit.split('\n').find((l) => l.startsWith('WorkingDirectory='))?.slice('WorkingDirectory='.length);
  }

  it('node setup pins WorkingDirectory to $ROOT for a package host at ~/tierwyn-node', () => {
    const home = tmp();
    const root = packageRoot(home);
    const relocated = root;
    writeFileSync(join(relocated, 'docs/deploy/systemd/tierwyn-node.service'), readFileSync(REAL_NODE_UNIT));
    const r = runFrom(relocated, ['node', 'setup'], home);
    expect(r.status).toBe(0);
    const unit = readFileSync(join(home, '.config/systemd/user/tierwyn-node.service'), 'utf8');
    expect(workingDirectory(unit)).toBe(relocated);
    expect(unit).toContain(`${relocated}/apps/server/dist/node/main.js`);
    expect(unit).not.toMatch(/%h\/tierwyn-node/);
  });

  it('node setup pins WorkingDirectory to $ROOT for a git checkout at ~/tierwyn', () => {
    const home = tmp();
    const root = gitRoot(home);
    const relocated = root;
    writeFileSync(join(relocated, 'docs/deploy/systemd/tierwyn-node.service'), readFileSync(REAL_NODE_UNIT));
    const r = runFrom(relocated, ['node', 'setup'], home);
    expect(r.status).toBe(0);
    const unit = readFileSync(join(home, '.config/systemd/user/tierwyn-node.service'), 'utf8');
    expect(workingDirectory(unit)).toBe(relocated);
    expect(unit).toContain(`${relocated}/apps/server/dist/node/main.js`);
    expect(unit).not.toMatch(/%h\/tierwyn-node/);
  });
});

function runUpdate(root: string, args: string[], home: string, extraEnv: Record<string, string> = {}) {
  return runFrom(root, ['node', 'update', ...args], home, { TIERWYN_UPDATE_SETTLE_S: '0', ...extraEnv });
}

describeIf('installer package update', () => {
  it('git root, no flag → git pull + npm ci path; package-fetch never called', () => {
    const home = tmp();
    const root = gitRoot(home);
    // edge = main tip → pull (stable's tag-follow path is covered in installer.channel.test.ts)
    const r = runUpdate(root, [], home, { TIERWYN_CHANNEL: 'edge' });
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'git.log'), 'utf8')).toMatch(/pull/);
    expect(readFileSync(join(home, 'npm.log'), 'utf8')).toMatch(/ci/);
    const nodeLog = existsSync(join(home, 'node.log')) ? readFileSync(join(home, 'node.log'), 'utf8') : '';
    expect(nodeLog).not.toMatch(/package-fetch/);
  });

  it('package root → fetches, swaps, restarts; .prev holds the old build', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'old');
    const r = runUpdate(root, [], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'node.log'), 'utf8')).toMatch(/package-fetch/);
    expect(readFileSync(join(root, 'BUILD_ID'), 'utf8').trim()).toBe('test-build');
    expect(existsSync(join(home, 'tierwyn-node.prev', 'old-marker'))).toBe(true);
    expect(readFileSync(join(home, 'systemctl.log'), 'utf8')).toMatch(/restart/);
    expect(r.stdout).toMatch(/Node updated to test-build/);
    expect(r.stdout).toMatch(/tierwyn-node\.service is running/);
  });

  it('package root, fetched id equals BUILD_ID → no swap, no restart', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'keep');
    const r = runUpdate(root, [], home, { FETCH_ID: 'pkg-id' });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'old-marker'))).toBe(true);
    expect(existsSync(join(home, 'tierwyn-node.prev'))).toBe(false);
    expect(existsSync(join(home, 'systemctl.restart'))).toBe(false);
    expect(r.stdout).toMatch(/Already up to date \(pkg-id\)/);
    expect(r.stdout).toMatch(/tierwyn-node\.service is running/);
  });

  it('package root, already current but unit inactive → warns and hints start', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    const r = runUpdate(root, [], home, { FETCH_ID: 'pkg-id', SYSTEMCTL_ACTIVE: 'inactive' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Already up to date \(pkg-id\)/);
    expect(r.stdout).toMatch(/tierwyn-node\.service is not running/);
    expect(r.stdout).toMatch(/tierwyn node start/);
  });

  it('self-check fails → old tree intact, no restart, exit 1', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'keep');
    const r = runUpdate(root, [], home, { SELFCHECK_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, 'old-marker'))).toBe(true);
    expect(existsSync(join(home, 'systemctl.restart'))).toBe(false);
  });

  it('is-active false after restart → old tree restored, restarted, exit 1', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'keep');
    const r = runUpdate(root, [], home, { SYSTEMCTL_FAIL_AFTER_RESTART: '1' });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, 'old-marker'))).toBe(true);
    expect(readFileSync(join(home, 'systemctl.restart'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('restart returns non-zero → still rolls back via is-active, old tree restored', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'keep');
    const r = runUpdate(root, [], home, { SYSTEMCTL_RESTART_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, 'old-marker'))).toBe(true);
    expect(readFileSync(join(home, 'systemctl.restart'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('package-fetch fails → nothing changes, exit 1, reason in update.log', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'keep');
    const r = runUpdate(root, [], home, { FETCH_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, 'old-marker'))).toBe(true);
    const log = readFileSync(join(home, '.config/tierwyn/node/update.log'), 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(r.stderr + r.stdout).toMatch(/update failed — see .*update\.log/);
    expect(r.stderr).toMatch(/last lines:/);
    expect(r.stderr).toMatch(/package-fetch failed: stub/);
  });

  it('--from-hub on git root → extracts to ~/tierwyn-node, re-renders unit, repoints shim, restarts; checkout untouched; node.json and key unchanged', () => {
    const home = tmp();
    fixtureTgz(home, { realInstall: true });
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    writeFileSync(join(root, 'checkout-marker'), 'stay');
    const ndir = join(home, '.config/tierwyn/node');
    mkdirSync(ndir, { recursive: true });
    writeFileSync(join(ndir, 'node.json'), JSON.stringify({ hostId: 'keep-me', hubUrl: 'https://hub.example' }));
    writeFileSync(join(ndir, 'key'), 'SECRET-KEY');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    writeFileSync(join(home, '.config/systemd/user/tierwyn-node.service'),
      `ExecStart=/usr/bin/node ${root}/apps/server/dist/node/main.js run\n`);
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    symlinkSync(join(root, 'scripts/install.sh'), join(home, '.local/bin/tierwyn'));
    const r = runUpdate(root, ['--from-hub'], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, 'tierwyn-node', 'BUILD_ID'))).toBe(true);
    expect(existsSync(join(root, 'checkout-marker'))).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(true);
    const unit = readFileSync(join(home, '.config/systemd/user/tierwyn-node.service'), 'utf8');
    expect(unit).toContain('tierwyn-node');
    expect(unit).not.toMatch(new RegExp(`${root}/apps/server`));
    expect(JSON.parse(readFileSync(join(ndir, 'node.json'), 'utf8')).hostId).toBe('keep-me');
    expect(readFileSync(join(ndir, 'key'), 'utf8')).toBe('SECRET-KEY');
    expect(readFileSync(join(home, 'systemctl.log'), 'utf8')).toMatch(/restart/);
  });

  it('--from-hub, self-check fails → unit untouched, keeps running git', () => {
    const home = tmp();
    fixtureTgz(home, { realInstall: true });
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    const unitPath = join(home, '.config/systemd/user/tierwyn-node.service');
    writeFileSync(unitPath, `ExecStart=/usr/bin/node ${root}/apps/server/dist/node/main.js run\n`);
    const r = runUpdate(root, ['--from-hub'], home, { SELFCHECK_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(unitPath, 'utf8')).toContain(root);
    expect(existsSync(join(home, 'tierwyn-node', 'BUILD_ID'))).toBe(false);
  });

  it('--from-hub, is-active false → unit backup restored and tierwyn shim points at git', () => {
    const home = tmp();
    fixtureTgz(home, { realInstall: true });
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    const unitPath = join(home, '.config/systemd/user/tierwyn-node.service');
    const original = `ExecStart=/usr/bin/node ${root}/apps/server/dist/node/main.js run\n`;
    writeFileSync(unitPath, original);
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    const gitShim = join(root, 'scripts/install.sh');
    symlinkSync(gitShim, join(home, '.local/bin/tierwyn'));
    const r = runUpdate(root, ['--from-hub'], home, { SYSTEMCTL_FAIL_AFTER_RESTART: '1' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(unitPath, 'utf8')).toBe(original);
    expect(readlinkSync(join(home, '.local/bin/tierwyn'))).toBe(gitShim);
  });

  it('--from-hub, restart returns non-zero → unit backup restored and tierwyn shim points at git', () => {
    const home = tmp();
    fixtureTgz(home, { realInstall: true });
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    const unitPath = join(home, '.config/systemd/user/tierwyn-node.service');
    const original = `ExecStart=/usr/bin/node ${root}/apps/server/dist/node/main.js run\n`;
    writeFileSync(unitPath, original);
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    const gitShim = join(root, 'scripts/install.sh');
    symlinkSync(gitShim, join(home, '.local/bin/tierwyn'));
    const r = runUpdate(root, ['--from-hub'], home, { SYSTEMCTL_RESTART_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(unitPath, 'utf8')).toBe(original);
    expect(readlinkSync(join(home, '.local/bin/tierwyn'))).toBe(gitShim);
  });

  it('--from-hub retry after failed conversion still converts when leftover BUILD_ID matches fetch id', () => {
    const home = tmp();
    fixtureTgz(home, { realInstall: true });
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    const unitPath = join(home, '.config/systemd/user/tierwyn-node.service');
    const original = `ExecStart=/usr/bin/node ${root}/apps/server/dist/node/main.js run\n`;
    writeFileSync(unitPath, original);
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    symlinkSync(join(root, 'scripts/install.sh'), join(home, '.local/bin/tierwyn'));
    const first = runUpdate(root, ['--from-hub'], home, {
      SYSTEMCTL_FAIL_AFTER_RESTART: '1',
      FETCH_ID: 'test-build',
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(unitPath, 'utf8')).toBe(original);
    expect(existsSync(join(home, 'tierwyn-node', 'BUILD_ID'))).toBe(true);
    rmSync(join(home, 'fail_is_active'), { force: true });
    const second = runUpdate(root, ['--from-hub'], home, { FETCH_ID: 'test-build' });
    expect(second.status).toBe(0);
    const unit = readFileSync(unitPath, 'utf8');
    expect(unit).toContain('tierwyn-node');
    expect(unit).not.toMatch(new RegExp(`${root}/apps/server`));
  });

  it('--from-hub --allow-http is forwarded to package-fetch', () => {
    const home = tmp();
    fixtureTgz(home, { realInstall: true });
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
    writeFileSync(join(home, '.config/systemd/user/tierwyn-node.service'),
      `ExecStart=/usr/bin/node ${root}/apps/server/dist/node/main.js run\n`);
    const ndir = join(home, '.config/tierwyn/node');
    mkdirSync(ndir, { recursive: true });
    writeFileSync(join(ndir, 'node.json'), JSON.stringify({ hostId: 'keep-me', hubUrl: 'http://hub.example' }));
    const r = runUpdate(root, ['--from-hub', '--allow-http'], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'node.log'), 'utf8')).toMatch(/package-fetch/);
    expect(readFileSync(join(home, 'node.log'), 'utf8')).toMatch(/--allow-http/);
  });

  it('--from-hub with target that has .git or is foreign → dies', () => {
    const home = tmp();
    const root = gitRoot(home);
    writeFileSync(join(root, 'apps/server/dist/node/main.js'), 'console.log("main"); // package-fetch\n');
    mkdirSync(join(home, 'tierwyn-node', '.git'), { recursive: true });
    const r = runUpdate(root, ['--from-hub'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/git checkout/);
    rmSync(join(home, 'tierwyn-node'), { recursive: true, force: true });
    mkdirSync(join(home, 'tierwyn-node'));
    writeFileSync(join(home, 'tierwyn-node', 'noise'), 'x');
    const r2 = runUpdate(root, ['--from-hub'], home);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr + r2.stdout).toMatch(/BUILD_ID|not a package|not empty/);
  });

  it('--from-hub with stale main.js lacking package-fetch → dies "run tierwyn node update first"', () => {
    const home = tmp();
    const root = gitRoot(home);
    const r = runUpdate(root, ['--from-hub'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/run tierwyn node update first/);
  });

  it('--from-hub on a package root → same as plain update', () => {
    const home = tmp();
    fixtureTgz(home);
    const root = packageRoot(home);
    writeFileSync(join(root, 'old-marker'), 'old');
    const r = runUpdate(root, ['--from-hub'], home);
    expect(r.status).toBe(0);
    expect(readFileSync(join(root, 'BUILD_ID'), 'utf8').trim()).toBe('test-build');
    expect(existsSync(join(home, 'tierwyn-node.prev', 'old-marker'))).toBe(true);
  });
});
