import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  argvForInstall,
  installDetected,
  runTierwyn,
} from '../bin/tierwyn';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'tierwyn');

function fakeInstallSh(tmp) {
  const log = path.join(tmp, 'invocation.txt');
  const sh = path.join(tmp, 'install.sh');
  fs.writeFileSync(
    sh,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${log}"
exit 7
`,
    { mode: 0o755 },
  );
  return { sh, log };
}

describe('tierwyn cli', () => {
  it('argvForInstall adds setup when no install and no args', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-home-'));
    assert.equal(installDetected(home), false);
    assert.deepEqual(argvForInstall([], home), ['setup']);
  });

  it('argvForInstall passes args through when install exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-home-'));
    fs.mkdirSync(path.join(home, 'tierwyn'));
    assert.deepEqual(argvForInstall(['doctor'], home), ['doctor']);
  });

  it('argvForInstall passes args through even without install', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-home-'));
    assert.deepEqual(argvForInstall(['help'], home), ['help']);
  });

  it('runTierwyn spawns bash with forwarded args', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cli-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const { sh, log } = fakeInstallSh(tmp);
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, 'tierwyn'));

    const prevHome = process.env.HOME;
    const prevSh = process.env.TIERWYN_CLI_INSTALL_SH;
    process.env.HOME = home;
    process.env.TIERWYN_CLI_INSTALL_SH = sh;

    try {
      const code = runTierwyn(['doctor', '--yes']);
      assert.equal(code, 7);
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.deepEqual(lines, ['doctor', '--yes']);
    } finally {
      process.env.HOME = prevHome;
      if (prevSh === undefined) delete process.env.TIERWYN_CLI_INSTALL_SH;
      else process.env.TIERWYN_CLI_INSTALL_SH = prevSh;
    }
  });

  it('runTierwyn uses setup when no install and no args', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cli-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const { sh, log } = fakeInstallSh(tmp);
    const home = path.join(tmp, 'empty-home');
    fs.mkdirSync(home);

    const prevHome = process.env.HOME;
    const prevSh = process.env.TIERWYN_CLI_INSTALL_SH;
    const prevTier = process.env.TIERWYN_DIR;
    const prevKel = process.env.TIERWYN_DIR;
    process.env.HOME = home;
    process.env.TIERWYN_CLI_INSTALL_SH = sh;
    delete process.env.TIERWYN_DIR;

    try {
      const code = runTierwyn([]);
      assert.equal(code, 7);
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'setup');
    } finally {
      process.env.HOME = prevHome;
      if (prevSh === undefined) delete process.env.TIERWYN_CLI_INSTALL_SH;
      else process.env.TIERWYN_CLI_INSTALL_SH = prevSh;
      if (prevTier === undefined) delete process.env.TIERWYN_DIR;
      else process.env.TIERWYN_DIR = prevTier;
      if (prevKel === undefined) delete process.env.TIERWYN_DIR;
      else process.env.TIERWYN_DIR = prevKel;
    }
  });

  it('bin entry passes args via spawnSync integration', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-bin-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const { sh, log } = fakeInstallSh(tmp);
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, 'tierwyn'));

    const r = spawnSync(process.execPath, [bin, 'status'], {
      env: {
        ...process.env,
        HOME: home,
        TIERWYN_CLI_INSTALL_SH: sh,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 7);
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'status');
  });

  it('runs when invoked through a symlink (npm bin / npx)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tierwyn-link-'));
    const sh = path.join(tmp, 'install.sh');
    const log = path.join(tmp, 'argv.log');
    fs.writeFileSync(sh, `#!/bin/bash\necho "$*" > ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
    const link = path.join(tmp, 'tierwyn');
    fs.symlinkSync(path.join(here, '..', 'bin', 'tierwyn'), link);
    const r = spawnSync(link, ['help'], {
      env: { ...process.env, TIERWYN_CLI_INSTALL_SH: sh }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'help');
  });
});
