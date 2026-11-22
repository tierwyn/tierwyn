#!/usr/bin/env node
/**
 * scripts/generate-package-reference.mjs
 * 
 * Generates the Monorepo Package Map and Workspace Interface Reference
 * (docs/reference/packages.md) directly from workspace source definitions.
 * 
 * Usage:
 *   node scripts/generate-package-reference.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function getWorkspaces() {
  const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
  const workspaces = rootPkg.workspaces || [];
  return workspaces.map(ws => {
    const wsDir = join(REPO_ROOT, ws);
    const pkgPath = join(wsDir, 'package.json');
    const pkg = readJson(pkgPath);
    return {
      relPath: ws,
      absPath: wsDir,
      name: pkg.name,
      version: pkg.version,
      type: pkg.type || 'commonjs',
      description: pkg.description || '',
      scripts: pkg.scripts || {},
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {}),
      main: pkg.main,
      exports: pkg.exports,
      types: pkg.types
    };
  });
}

function parseSharedExports() {
  const indexPath = join(REPO_ROOT, 'packages/shared/src/index.ts');
  if (!existsSync(indexPath)) return [];
  const content = readFileSync(indexPath, 'utf8');
  const lines = content.split('\n');
  const modules = [];
  for (const line of lines) {
    const match = line.match(/export\s+\*\s+from\s+['"]\.\/([^'"]+)\.js['"]/);
    if (match) {
      const modName = match[1];
      const modPath = join(REPO_ROOT, 'packages/shared/src', `${modName}.ts`);
      let summary = '';
      if (existsSync(modPath)) {
        const modContent = readFileSync(modPath, 'utf8');
        // Only a doc comment at the very top of the file (before any code) describes
        // the module itself. The first /** */ anywhere else documents a single symbol
        // and would misdescribe the module.
        const commentMatch = modContent.match(/^\s*\/\*\*([\s\S]*?)\*\//);
        if (commentMatch) {
          summary = commentMatch[1]
            .split('\n')
            .map(s => s.replace(/^\s*\*\s?/, '').trim())
            .filter(Boolean)
            .join(' ');
        } else {
          const exports = (modContent.match(/^export\s/gm) || []).length;
          summary = `Exports ${exports} top-level symbol${exports === 1 ? '' : 's'}.`;
        }
      }
      modules.push({ name: modName, summary });
    }
  }
  return modules;
}

function parseServerAdapters() {
  const adaptersDir = join(REPO_ROOT, 'apps/server/src/adapters');
  if (!existsSync(adaptersDir)) return [];
  const entries = readdirSync(adaptersDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

/**
 * Adapter keys registered in apps/server/src/index.ts via registry.register(...).
 * Each registration is also matched to the adapter class it constructs, so
 * config-only variants that reuse another adapter's package (e.g. 'kilocode'
 * reuses OpenCodeAdapter with a 'kilo' binary) can be called out as such.
 */
function parseRegisteredAdapters() {
  const indexPath = join(REPO_ROOT, 'apps/server/src/index.ts');
  if (!existsSync(indexPath)) return [];
  const content = readFileSync(indexPath, 'utf8');
  const out = [];
  for (const m of content.matchAll(/registry\.register\(\s*'([^']+)'/g)) {
    const after = content.slice(m.index, m.index + 250);
    const cls = after.match(/new\s+([A-Za-z0-9]+Adapter)/);
    out.push({ key: m[1], cls: cls ? cls[1] : null });
  }
  return out;
}

function generateMarkdown(workspaces, sharedExports, serverAdapters, registeredAdapters) {
  let md = `# Monorepo Package Reference

<!-- GENERATED FILE: Do not edit directly. Run 'npm run docs:generate-reference' to regenerate. -->

This document provides the reference manual for all workspaces in the Tierwyn monorepo, their dependency topology, build sequence, and exported interface boundaries.

## Workspace Topology & Build Order

Tierwyn uses npm workspaces with strict layer separation. Upstream contracts live in \`packages/shared\`, and downstream applications consume them.

\`\`\`mermaid
flowchart TD
    shared["packages/shared (@tierwyn/shared)<br/>Contract boundary, domain models, protocol types"]
    server["apps/server (@tierwyn/server)<br/>Express API, WebSocket hub, agent adapters"]
    web["apps/web (@tierwyn/web)<br/>React SPA, Vite preview, UI components"]

    shared --> server
    shared --> web
\`\`\`

### Build Sequence

Because \`apps/server\` and \`apps/web\` compile against the emitted JavaScript and TypeScript declaration files of \`packages/shared\`, \`packages/shared\` must always be built first:

1. **Phase 1 (Contract Core):** \`npm run build --workspace=packages/shared\` (emits \`dist/\` with \`index.js\` and \`index.d.ts\`)
2. **Phase 2 (Applications):** \`npm run build --workspace=apps/server\` and \`npm run build --workspace=apps/web\` (concurrent or sequential)

Full monorepo build command:
\`\`\`bash
npm run build
\`\`\`

---

## Workspace Inventory

| Workspace Path | Package Name | Version | Role | Output Target |
|---|---|---|---|---|
`;

  for (const ws of workspaces) {
    let role = '';
    let target = '';
    if (ws.relPath === 'packages/shared') {
      role = 'Shared protocol, types, domain models, event contracts';
      target = '\`dist/index.js\`, \`dist/index.d.ts\`';
    } else if (ws.relPath === 'apps/server') {
      role = 'Backend Express API, WebSocket dispatcher, adapter execution';
      target = '\`dist/index.js\`, \`dist/db/migrations/\`';
    } else if (ws.relPath === 'apps/web') {
      role = 'Frontend single-page application and UI interface';
      target = '\`dist/\` (client bundle)';
    }
    md += `| \`${ws.relPath}\` | \`${ws.name}\` | \`${ws.version}\` | ${role} | ${target} |\n`;
  }

  md += `\n---\n\n## Per-Package Reference\n\n`;

  for (const ws of workspaces) {
    md += `### \`${ws.name}\` (\`${ws.relPath}\`)\n\n`;
    if (ws.description) {
      md += `${ws.description}\n\n`;
    }

    md += `- **Path:** \`${ws.relPath}\`\n`;
    md += `- **Type:** \`${ws.type}\`\n`;
    if (ws.main) md += `- **Entry Point (main):** \`${ws.main}\`\n`;
    if (ws.types) md += `- **Type Declarations (types):** \`${ws.types}\`\n`;
    md += `\n`;

    md += `#### Scripts\n\n`;
    md += `| Script | Command | Purpose |\n`;
    md += `|---|---|---|\n`;
    for (const [scriptName, scriptCmd] of Object.entries(ws.scripts)) {
      md += `| \`${scriptName}\` | \`${scriptCmd}\` | Run with \`npm run ${scriptName} --workspace=${ws.relPath}\` |\n`;
    }
    md += `\n`;

    md += `#### Internal & External Dependencies\n\n`;
    md += `- **Runtime Dependencies:** ${ws.dependencies.length > 0 ? ws.dependencies.map(d => `\`${d}\``).join(', ') : '_none_'}\n`;
    md += `- **Dev Dependencies:** ${ws.devDependencies.length > 0 ? ws.devDependencies.map(d => `\`${d}\``).join(', ') : '_none_'}\n\n`;

    if (ws.relPath === 'packages/shared') {
      md += `#### Exported Module Surface\n\n`;
      md += `All public types and domain helpers are re-exported via \`packages/shared/src/index.ts\`:\n\n`;
      md += `| Module | Source File | Description |\n`;
      md += `|---|---|---|\n`;
      for (const exp of sharedExports) {
        md += `| \`${exp.name}\` | \`packages/shared/src/${exp.name}.ts\` | ${exp.summary || 'Domain module'} |\n`;
      }
      md += `\n`;
    } else if (ws.relPath === 'apps/server') {
      md += `#### Registered Agent Adapters\n\n`;
      md += `Adapter keys are registered in \`apps/server/src/index.ts\` via \`registry.register(...)\`. Keys with a dedicated package directory live under \`apps/server/src/adapters/\`:\n\n`;
      for (const ad of serverAdapters) {
        md += `- \`${ad}\` (\`apps/server/src/adapters/${ad}/\`)\n`;
      }
      const noDir = registeredAdapters.filter(r => !serverAdapters.includes(r.key));
      if (noDir.length) {
        md += `\nRegistered without a dedicated package directory — config-only variants that reuse another adapter's class:\n\n`;
        for (const r of noDir) {
          md += `- \`${r.key}\` → \`${r.cls}\` (registered in \`apps/server/src/index.ts\`)\n`;
        }
      }
      md += `\n`;
    }

    md += `---\n\n`;
  }

  return md;
}

function main() {
  const workspaces = getWorkspaces();
  const sharedExports = parseSharedExports();
  const serverAdapters = parseServerAdapters();
  const registeredAdapters = parseRegisteredAdapters();
  const output = generateMarkdown(workspaces, sharedExports, serverAdapters, registeredAdapters);
  const targetPath = join(REPO_ROOT, 'docs/reference/packages.md');
  writeFileSync(targetPath, output, 'utf8');
  console.log(`Generated package reference at ${relative(REPO_ROOT, targetPath)}`);
}

main();
