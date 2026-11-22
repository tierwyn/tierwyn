#!/usr/bin/env node
// Docs freshness harness (docs-campaign S8).
// Three checks, zero dependencies, runs green from a clean checkout:
//   1. Link check    — every relative markdown link in every git-tracked .md resolves.
//   2. Hub integrity — every page under docs/ is reachable from docs/README.md in <= 2 hops.
//   3. Fact assertions — load-bearing documented values still match the source they came from.
// Wired into `npm run typecheck` via the root `docs:check` script. Run directly:
//   node scripts/check-docs.mjs
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const internalDir = join(root, 'internal');
const hasInternal = existsSync(internalDir);
const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

// ── Scope: every markdown file git tracks (matches the docs-campaign glob). ──────────
const mdFiles = execSync(`git -C ${JSON.stringify(root)} ls-files -- '*.md'`, { encoding: 'utf8' })
  .split('\n').filter(Boolean);

// ── 1. Link check ────────────────────────────────────────────────────────────────────
const MD_LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;   // [t](url) / ![t](url)
const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm;                  // [ref]: url
const HTML_ATTR = /(?:src|href)="([^"]+)"/g;                      // <img src="..."> etc.
const isExternal = (t) => /^(?:[a-z][a-z0-9+.-]*:|\/|#|mailto:)/i.test(t) || t.startsWith('\\');

/** All relative link targets in one markdown file (code fences excluded). */
function linkTargets(mdPath) {
  // HTML comments never render, so links inside them (e.g. media placeholders) are not checked.
  const text = readFileSync(mdPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const targets = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const re of [MD_LINK, REF_DEF, HTML_ATTR]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const t = m[2] ?? m[1];
        if (t && !isExternal(t)) targets.push(t.split('#')[0]);
      }
    }
  }
  return targets;
}

for (const f of mdFiles) {
  const abs = join(root, f);
  for (const t of linkTargets(abs)) {
    if (t === '') continue; // pure-anchor link
    const target = resolve(dirname(abs), t);
    // Gitignored local directories: links into them are ignored if not present in the workspace.
    if (!hasInternal && (target === internalDir || target.startsWith(internalDir + '/'))) continue;
    ok(existsSync(join(dirname(abs), t)), `broken link: ${f} -> ${t}`);
  }
}

// ── 2. Hub integrity: one hub, every docs page within 2 hops ─────────────────────────
const HUB = 'docs/README.md';
ok(mdFiles.includes(HUB), `hub missing: ${HUB}`);
const docsPages = mdFiles.filter((f) => f.startsWith('docs/') && f.endsWith('.md'));
const adj = new Map(); // md file -> linked md files
for (const f of mdFiles) {
  adj.set(f, linkTargets(join(root, f))
    .map((t) => {
      const p = resolve(dirname(join(root, f)), t);
      const rel = p.startsWith(root + '/') ? p.slice(root.length + 1) : null;
      try {
        if (rel && statSync(p).isDirectory()) {
          // A directory link reaches that directory's README.md (index) page.
          return statSync(join(p, 'README.md')).isFile() ? `${rel}/README.md`.replaceAll('//', '/') : null;
        }
      } catch { /* not a dir */ }
      return rel && rel.endsWith('.md') && existsSync(p) ? rel : null;
    })
    .filter(Boolean));
}
const HOPS = 2;
const reached = new Set([HUB]);
let frontier = [HUB];
for (let h = 0; h < HOPS && frontier.length; h++) {
  frontier = [...new Set(frontier.flatMap((f) => adj.get(f) ?? []))].filter((f) => !reached.has(f));
  frontier.forEach((f) => reached.add(f));
}
for (const p of docsPages) {
  ok(reached.has(p), `docs page not reachable from hub in <= ${HOPS} hops: ${p}`);
}

// ── 3. Fact assertions (each asserts doc value == source value) ───────────────────────
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const hubText = readFileSync(join(root, HUB), 'utf8');

// default_server_port = 8787  (apps/server/src/index.ts)
// ponytail: matched by content, not line number — a line-pinned anchor here
// tempted a past change to collapse two statements onto one line just to keep
// the count. Anchor on the statement instead.
ok(/process\.env\.PORT \?\? '8787'/.test(readFileSync(join(root, 'apps/server/src/index.ts'), 'utf8')),
  "fact default_server_port: apps/server/src/index.ts no longer defaults PORT to 8787");
// dev_web_port = 5173  (apps/web/vite.config.ts)
ok(/port:\s*5173/.test(readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8')),
  'fact dev_web_port: apps/web/vite.config.ts no longer sets port 5173');
// preview_web_port = 4173  (apps/web/vite.config.ts)
ok(/port:\s*4173/.test(readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8')),
  'fact preview_web_port: apps/web/vite.config.ts no longer sets port 4173');
// monorepo_workspaces  (package.json:12)
ok(JSON.stringify(rootPkg.workspaces) === JSON.stringify(['apps/server', 'apps/web', 'packages/shared']),
  `fact monorepo_workspaces: package.json:12 is now ${JSON.stringify(rootPkg.workspaces)}`);
// latest_registered_migration_version = 1 (everything squashed into 001_baseline.sql at release).
// next_migration_version = 2. Content pins, not line numbers.
const migIndex = readFileSync(join(root, 'apps/server/src/db/migrations/index.ts'), 'utf8');
ok((migIndex.match(/\{ version: \d+,/g) ?? []).length === 1 && /\{ version: 1, sql: readFileSync\(join\(here, '001_baseline\.sql'\)/.test(migIndex) && /next new migration must be \*\*2\*\*/.test(migIndex),
  'fact latest_registered_migration_version: index.ts no longer registers exactly 001_baseline.sql with next migration 2');
// shared_package_name = @tierwyn/shared  (packages/shared/package.json:2)
const sharedPkg = JSON.parse(readFileSync(join(root, 'packages/shared/package.json'), 'utf8'));
ok(sharedPkg.name === '@tierwyn/shared',
  `fact shared_package_name: packages/shared/package.json:2 is now ${sharedPkg.name}`);

// ── Result ───────────────────────────────────────────────────────────────────────────
console.log(`docs: link check — ${mdFiles.length} tracked markdown files scanned`);
console.log(`docs: hub integrity — ${docsPages.length} docs pages, reachability limit ${HOPS} hops`);
console.log(`docs: fact assertions — 7`);
if (errors.length) {
  console.error(`FAIL: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('PASS: all doc links resolve, all docs pages reachable, all facts verified');
