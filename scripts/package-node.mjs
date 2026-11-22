#!/usr/bin/env node
/**
 * Build the hub-served tierwyn-node tarball into apps/server/dist/node-package/.
 * Copies happen in a temp dir; the hub dist/ only gains node-package/.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'apps/server/dist/node-package');
const ENTRY = join(ROOT, 'apps/server/src/node/main.ts');
const INSTALL_SH = join(ROOT, 'scripts/install.sh');
const UNIT = join(ROOT, 'docs/deploy/systemd/tierwyn-node.service');
const PROFILES = join(ROOT, 'apps/server/agent-profiles.json');
const ALLOWED_EXTERNALS = new Set(['bufferutil', 'utf-8-validate']);

function gitShort() {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'nogit';
  } catch {
    return 'nogit';
  }
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function contentHash(paths) {
  const h = createHash('sha256');
  for (const p of paths) h.update(readFileSync(p));
  return h.digest('hex').slice(0, 8);
}

function isAllowedExternal(spec) {
  if (ALLOWED_EXTERNALS.has(spec)) return true;
  const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
  if (builtinModules.includes(bare) || builtinModules.includes(spec)) return true;
  if (spec.startsWith('node:')) return true;
  return false;
}

async function bundle(outfile) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external: ['bufferutil', 'utf-8-validate'],
    define: { __TIERWYN_PACKAGED__: 'true' },
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);\n",
    },
    metafile: true,
    logLevel: 'silent',
  });
  const unexpected = [];
  for (const meta of Object.values(result.metafile.outputs)) {
    for (const imp of meta.imports ?? []) {
      if (!imp.external) continue;
      if (!isAllowedExternal(imp.path)) unexpected.push(imp.path);
    }
  }
  if (unexpected.length) {
    throw new Error(`package-node: unexpected external import(s): ${unexpected.join(', ')}`);
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

async function main() {
  if (!readFileSync(ENTRY, 'utf8')) throw new Error(`missing entry ${ENTRY}`);
  const staging = mkdtempSync(join(tmpdir(), 'tierwyn-node-pkg-'));
  const tree = join(staging, 'tierwyn-node');
  try {
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    mkdirSync(join(tree, 'docs/deploy/systemd'), { recursive: true });
    mkdirSync(join(tree, 'apps/server/dist/node'), { recursive: true });
    mkdirSync(join(tree, 'bin'), { recursive: true });

    const mainJs = join(tree, 'apps/server/dist/node/main.js');
    await bundle(mainJs);
    copyFileSync(INSTALL_SH, join(tree, 'scripts/install.sh'));
    copyFileSync(UNIT, join(tree, 'docs/deploy/systemd/tierwyn-node.service'));
    copyFileSync(PROFILES, join(tree, 'apps/server/dist/agent-profiles.json'));
    writeJson(join(tree, 'package.json'), { name: 'tierwyn', private: true, type: 'module' });
    writeJson(join(tree, 'apps/server/package.json'), { name: '@tierwyn/server-node', private: true, type: 'module' });
    const shim = '#!/usr/bin/env bash\nexec bash "$(cd "$(dirname "$0")/.." && pwd)/scripts/install.sh" "$@"\n';
    writeFileSync(join(tree, 'bin/tierwyn'), shim, { mode: 0o755 });
    chmodSync(join(tree, 'bin/tierwyn'), 0o755);

    const buildId = `${gitShort()}-${contentHash([
      mainJs,
      join(tree, 'scripts/install.sh'),
      join(tree, 'docs/deploy/systemd/tierwyn-node.service'),
      join(tree, 'apps/server/dist/agent-profiles.json'),
      join(tree, 'bin/tierwyn'),
    ])}`;
    writeFileSync(join(tree, 'BUILD_ID'), `${buildId}\n`);

    mkdirSync(OUT_DIR, { recursive: true });
    const file = `tierwyn-node-${buildId}.tgz`;
    const tgzPath = join(OUT_DIR, file);
    execFileSync('tar', [
      '-czf', tgzPath,
      '--owner=0', '--group=0', '--numeric-owner',
      '-C', staging,
      'tierwyn-node',
    ]);
    copyFileSync(INSTALL_SH, join(OUT_DIR, 'install.sh'));
    const buf = readFileSync(tgzPath);
    const manifest = { buildId, sha256: sha256Hex(buf), size: buf.length, file };
    const tmpManifest = join(OUT_DIR, 'manifest.json.tmp');
    writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + '\n');
    renameSync(tmpManifest, join(OUT_DIR, 'manifest.json'));
    for (const name of readdirSync(OUT_DIR)) {
      if (/^tierwyn-node-[\w.-]+\.tgz$/.test(name) && name !== file) {
        unlinkSync(join(OUT_DIR, name));
      }
    }
    process.stdout.write(`node-package ${file} ${manifest.size} bytes sha256=${manifest.sha256}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
