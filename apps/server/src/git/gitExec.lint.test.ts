import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const RAW_GIT = /(execFile|execFileSync|spawn|spawnSync)\(\s*['"]git['"]/;

describe('git exec choke point', () => {
  it('no raw git spawns outside gitExec.ts', () => {
    const allow = new Set([
      join(here, 'gitExec.ts'),
    ]);
    const failures: string[] = [];
    for (const file of walkTs(srcRoot)) {
      if (allow.has(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (RAW_GIT.test(src)) failures.push(file);
    }
    expect(failures).toEqual([]);
  });
});
