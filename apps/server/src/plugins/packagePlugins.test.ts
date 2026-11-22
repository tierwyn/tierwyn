import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(process.cwd(), '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'package-plugins.mjs');
const EXPECTED_IDS = [
  'cursor-usage',
  'firecrawl',
  'gemini-audiobook',
  'gemini-image',
  'gemini-podcast',
  'kilo-usage',
  'openrouter-usage',
  'zai-usage',
];
const EXPECTED_ARCHIVES = EXPECTED_IDS.map((id) => `plugin-archives/${id}.tar.gz`);

function gitLsFiles(...paths: string[]): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...paths], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).sort();
}

describe('scripts/package-plugins.mjs', () => {
  it('core repo ships no installed plugins; source and archives stay tracked', () => {
    expect(gitLsFiles('plugins')).toEqual([]);
    expect(gitLsFiles('plugin-src').length).toBeGreaterThan(0);
    expect(gitLsFiles('plugin-archives')).toEqual(EXPECTED_ARCHIVES);
  });

  it('generates the 8 plugin archives, produces byte-identical output, and passes layout checks', () => {
    const out1 = mkdtempSync(join(tmpdir(), 'pkg-test-1-'));
    const out2 = mkdtempSync(join(tmpdir(), 'pkg-test-2-'));

    try {
      // First run
      execFileSync('node', [SCRIPT_PATH, '--out', out1], { stdio: 'pipe' });

      // (a) Verify all archives exist
      for (const id of EXPECTED_IDS) {
        const file = join(out1, `${id}.tar.gz`);
        expect(existsSync(file), `archive exists: ${id}.tar.gz`).toBe(true);

        // (c) Inspect tar listing for safety (no absolute, no ..)
        const rawListing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' });
        const lines = rawListing.split('\n').filter(Boolean);
        expect(lines.length).toBeGreaterThan(0);

        for (const line of lines) {
          expect(line.startsWith('/')).toBe(false);
          expect(line.split('/')).not.toContain('..');
          expect(line.includes('\\')).toBe(false);
          // Layout: must be inside <id>/
          expect(line === id || line.startsWith(`${id}/`)).toBe(true);
        }

        // Verify plugin.json and index.js exist inside the archive
        expect(lines).toContain(`${id}/plugin.json`);
        expect(lines).toContain(`${id}/index.js`);
      }

      // Second run into separate output dir to assert byte-determinism (b)
      execFileSync('node', [SCRIPT_PATH, '--out', out2], { stdio: 'pipe' });

      for (const id of EXPECTED_IDS) {
        const b1 = readFileSync(join(out1, `${id}.tar.gz`));
        const b2 = readFileSync(join(out2, `${id}.tar.gz`));
        expect(b1.equals(b2), `byte-identical archive: ${id}.tar.gz`).toBe(true);
      }
    } finally {
      rmSync(out1, { recursive: true, force: true });
      rmSync(out2, { recursive: true, force: true });
    }
  });
});
