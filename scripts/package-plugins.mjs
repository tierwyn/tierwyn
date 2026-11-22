#!/usr/bin/env node
// Package first-party plugin source (plugin-src/<id>/) into installable .tar.gz archives.
// Usage: node scripts/package-plugins.mjs [--out <dir>]
import { execFileSync, execSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Parse --out flag (default plugin-archives/ at repo root)
const args = process.argv.slice(2);
let outDir = join(root, 'plugin-archives');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) {
    outDir = resolve(process.cwd(), args[i + 1]);
    i++;
  }
}

mkdirSync(outDir, { recursive: true });

// Constants mirroring apps/server/src/routes/plugins.ts
const MAX_PLUGIN_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_PLUGIN_FILES = 2000;

// Find all tracked plugin files under plugin-src/
const trackedOutput = execSync(`git -C ${JSON.stringify(root)} ls-files -- 'plugin-src/'`, { encoding: 'utf8' });
const trackedFiles = trackedOutput.split('\n').filter(Boolean);

// Group by top-level plugin directory under plugin-src/
const pluginsMap = new Map(); // dirName -> relPaths
for (const rel of trackedFiles) {
  const parts = rel.split('/');
  if (parts.length < 3 || parts[0] !== 'plugin-src') continue;
  const dirName = parts[1];
  if (!pluginsMap.has(dirName)) {
    pluginsMap.set(dirName, []);
  }
  pluginsMap.get(dirName).push(rel);
}

const pluginDirs = [...pluginsMap.keys()].sort();
console.log(`Packaging ${pluginDirs.length} plugin(s) to ${outDir}…`);

for (const dirName of pluginDirs) {
  const files = pluginsMap.get(dirName);
  const stagingRoot = mkdtempSync(join(outDir, '.staging-'));

  try {
    const pluginStaging = join(stagingRoot, dirName);
    mkdirSync(pluginStaging, { recursive: true });

    // Copy each tracked file
    for (const rel of files) {
      const src = join(root, rel);
      // Path inside plugin dir (e.g. plugin-src/cursor-usage/index.js -> index.js)
      const subPath = rel.slice(`plugin-src/${dirName}/`.length);
      const dest = join(pluginStaging, subPath);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }

    // Rename plugin.json.example -> plugin.json
    const examplePath = join(pluginStaging, 'plugin.json.example');
    const manifestPath = join(pluginStaging, 'plugin.json');
    if (existsSync(examplePath)) {
      renameSync(examplePath, manifestPath);
    }

    if (!existsSync(manifestPath)) {
      throw new Error(`Plugin ${dirName} is missing plugin.json or plugin.json.example`);
    }

    // Read manifest to get id and assert matches dirName
    const manifestRaw = readFileSync(manifestPath, 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (e) {
      throw new Error(`Plugin ${dirName} has invalid manifest JSON: ${e.message}`);
    }

    if (!manifest.id || typeof manifest.id !== 'string') {
      throw new Error(`Plugin ${dirName} manifest missing valid id string`);
    }

    if (manifest.id !== dirName) {
      throw new Error(`Plugin manifest.id "${manifest.id}" does not match directory name "${dirName}"`);
    }

    const archiveName = `${manifest.id}.tar.gz`;
    const archivePath = join(outDir, archiveName);

    // Build deterministic archive:
    // tar --sort=name --mtime="UTC 1970-01-01" --owner=0 --group=0 --numeric-owner -cf - -C <stagingRoot> <dirName> | gzip -n > <archivePath>
    const tarCmd = `tar --sort=name --mtime="UTC 1970-01-01" --owner=0 --group=0 --numeric-owner -cf - -C ${JSON.stringify(stagingRoot)} ${JSON.stringify(dirName)} | gzip -n > ${JSON.stringify(archivePath)}`;
    execSync(tarCmd, { shell: '/bin/bash' });

    // Self-checks (D5) mirroring POST /plugins acceptance rules:
    // 1. tar -tzvf --numeric-owner listing: regular files and dirs only, file count & size caps
    const verboseListing = execFileSync('tar', ['-tzvf', archivePath, '--numeric-owner'], { encoding: 'utf8' });
    const verboseLines = verboseListing.split('\n').filter((l) => l.trim().length > 0);
    if (verboseLines.length > MAX_PLUGIN_FILES) {
      throw new Error(`Archive ${archiveName} contains too many files (${verboseLines.length} > ${MAX_PLUGIN_FILES})`);
    }

    let extractedBytesTotal = 0;
    for (const line of verboseLines) {
      const firstChar = line.charAt(0);
      if (firstChar !== '-' && firstChar !== 'd') {
        throw new Error(`Archive ${archiveName} contains non-regular entry: ${line}`);
      }
      const parts = line.trim().split(/\s+/);
      let size = 0;
      for (let p = 1; p < parts.length; p++) {
        if (/^\d+$/.test(parts[p])) {
          size = Number(parts[p]);
          break;
        }
      }
      extractedBytesTotal += size;
    }

    if (extractedBytesTotal > MAX_PLUGIN_EXTRACTED_BYTES) {
      throw new Error(`Archive ${archiveName} extracted size exceeds cap (${extractedBytesTotal} bytes)`);
    }

    // 2. tar -tzf raw names traversal scan
    const rawListing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
    const rawNames = rawListing.split('\n').filter((l) => l.trim().length > 0);
    for (const name of rawNames) {
      if (name.startsWith('/') || name.includes('\n') || name.includes('\r') || name.includes('\\')) {
        throw new Error(`Archive ${archiveName} contains unsafe path: ${name}`);
      }
      const segments = name.split('/');
      if (segments.includes('..')) {
        throw new Error(`Archive ${archiveName} contains .. traversal: ${name}`);
      }
    }

    // 3. Verify top-level dir layout: all members start with dirName/
    for (const name of rawNames) {
      if (!name.startsWith(`${dirName}/`) && name !== dirName && name !== `${dirName}/`) {
        throw new Error(`Archive ${archiveName} contains entry outside ${dirName}/: ${name}`);
      }
    }

    console.log(`  ✓ ${archiveName} (${verboseLines.length} files, ${extractedBytesTotal} bytes)`);
  } finally {
    if (existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

console.log('Done packaging plugins.');
