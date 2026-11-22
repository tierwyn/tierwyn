import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Node isolation guard: the `tierwyn node` entry graph (src/node/main.ts and
 * everything it pulls in) must never reach the hub's SQLite layer. The node
 * runs as a standalone process (`tierwyn node run`) with no database, and
 * importing better-sqlite3/db/** or repositories/** would either crash the
 * node (native binding present but no data dir) or silently couple the node
 * to hub internals. Any hub helper the node needs must be split into a
 * DB-free module instead.
 */

const NODE_DIR = dirname(fileURLToPath(import.meta.url));

/** Strip line/block comments so commented-out imports are not counted. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FROM_RE = /^\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_RE = /^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(src: string): Array<{ spec: string; typeOnly: boolean }> {
  const text = withoutComments(src);
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  for (const re of [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      let typeOnly = false;
      if (re === FROM_RE) {
        // Whole statement text, from its line start through the specifier.
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const stmt = text.slice(lineStart, m.index + m[0].length);
        typeOnly = /^\s*(?:import|export)\s+type\b/.test(stmt);
      }
      out.push({ spec, typeOnly });
    }
  }
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined; // bare / absolute — not part of the graph
  const base = resolve(dirname(fromFile), spec);
  if (base.endsWith('.js')) return base.slice(0, -3) + '.ts';
  return base;
}

function walk(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue; // not a .ts file we can read (e.g. resolved to a directory-less path)
    }
    for (const { spec, typeOnly } of specifiers(src)) {
      if (typeOnly) continue;
      if (spec === 'better-sqlite3') {
        bare.add(spec);
        continue;
      }
      const resolved = resolveSpec(file, spec);
      if (resolved === undefined) continue; // @tierwyn/shared and other bare packages
      queue.push(resolved);
    }
  }
  return { files, bare };
}

describe('node entry graph never reaches the DB', () => {
  const entry = join(NODE_DIR, 'main.ts');
  const { files, bare } = walk(entry);

  it('visits the node entry graph', () => {
    expect(files.has(entry)).toBe(true);
    expect(files.size).toBeGreaterThan(5);
  });

  it('never imports better-sqlite3', () => {
    expect([...bare]).toEqual([]);
  });

  it('never imports from db/ or repositories/', () => {
    const offenders = [...files].filter((f) => /\/(db|repositories)\//.test(f));
    expect(offenders).toEqual([]);
  });
});
