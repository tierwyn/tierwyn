#!/usr/bin/env node
/**
 * Extract the hub node package to a temp dir outside the repo and assert
 * the allow-list, checksum, --help, and self-check (Review Focus 1).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'apps/server/dist/node-package');
const ALLOW = new Set([
  'BUILD_ID',
  'package.json',
  'scripts/install.sh',
  'docs/deploy/systemd/tierwyn-node.service',
  'apps/server/package.json',
  'apps/server/dist/node/main.js',
  'apps/server/dist/agent-profiles.json',
  'bin/tierwyn',
]);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'manifest.json'), 'utf8'));
const tgz = join(PKG_DIR, manifest.file);
const buf = readFileSync(tgz);
const sha = createHash('sha256').update(buf).digest('hex');
if (sha !== manifest.sha256) fail(`sha256 mismatch: manifest ${manifest.sha256} file ${sha}`);

const listing = execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((l) => l && !l.endsWith('/'))
  .map((l) => l.replace(/^tierwyn-node\//, ''));
const listed = new Set(listing);
if (listed.size !== ALLOW.size || [...ALLOW].some((f) => !listed.has(f)) || listing.some((f) => !ALLOW.has(f))) {
  fail(`tar listing mismatch\n  got: ${[...listed].sort().join('\n  ')}\n  want: ${[...ALLOW].sort().join('\n  ')}`);
}

const dest = mkdtempSync(join(tmpdir(), 'tierwyn-node-smoke-'));
try {
  execFileSync('tar', ['-xzf', tgz, '--strip-components=1', '-C', dest]);
  const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
  if (pkg.name !== 'tierwyn') fail(`package.json name is ${pkg.name}`);
  const raw = readFileSync(join(dest, 'package.json'), 'utf8');
  const hits = (raw.match(/"name": "tierwyn"/g) ?? []).length;
  if (hits !== 1) fail(`grep -c 'name": "tierwyn"' expected 1, got ${hits}`);

  const nodeDir = dirname(process.execPath);
  const mainJs = join(dest, 'apps/server/dist/node/main.js');
  const env = { PATH: nodeDir, HOME: dest };
  const help = spawnSync(process.execPath, [mainJs, '--help'], { env, encoding: 'utf8' });
  if (help.status !== 0) fail(`--help exit ${help.status}: ${help.stderr || help.stdout}`);

  const check = spawnSync(process.execPath, [mainJs, 'self-check'], { env, encoding: 'utf8' });
  if (check.status !== 0) fail(`self-check exit ${check.status}: ${check.stderr || check.stdout}`);
  const parsed = JSON.parse((check.stdout || '').trim().split('\n').at(-1));
  if (!(parsed.profiles > 0)) fail(`self-check profiles not > 0: ${check.stdout}`);
  if (parsed.source !== 'package') fail(`self-check source ${parsed.source}, expected package`);
  if (parsed.sqlite !== true) fail(`self-check sqlite ${parsed.sqlite}`);
  process.stdout.write(`package-node-smoke ok buildId=${parsed.buildId} profiles=${parsed.profiles} size=${manifest.size}\n`);
} finally {
  rmSync(dest, { recursive: true, force: true });
}
