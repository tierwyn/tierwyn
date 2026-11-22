import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PACKAGED } from '../../installSource.js';
import { resolveOnPath } from '../../discovery.js';
import { claudeExecutableOpt } from './executable.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('claudeExecutableOpt', () => {
  it('not packaged → {}', () => {
    expect(claudeExecutableOpt(false, () => '/usr/bin/claude')).toEqual({});
  });

  it('packaged with claude on PATH → absolute path', () => {
    expect(claudeExecutableOpt(true, () => '/usr/bin/claude')).toEqual({
      pathToClaudeCodeExecutable: '/usr/bin/claude',
    });
  });

  it('packaged without claude → {}', () => {
    expect(claudeExecutableOpt(true, () => undefined)).toEqual({});
  });

  it('PACKAGED is false under vitest', () => {
    expect(PACKAGED).toBe(false);
  });

  it('resolveOnPath returns first PATH hit', () => {
    const prev = process.env.PATH;
    process.env.PATH = '/opt/a:/opt/b:/opt/c';
    try {
      const exists = (p: string) => p === '/opt/b/claude' || p === '/opt/c/claude';
      expect(resolveOnPath('claude', exists)).toBe('/opt/b/claude');
    } finally {
      process.env.PATH = prev;
    }
  });

  it('every SDK query call site spreads claudeExecutableOpt', () => {
    const indexSrc = readFileSync(join(here, 'index.ts'), 'utf8');
    const probeSrc = readFileSync(join(here, 'probeUsage.ts'), 'utf8');
    const src = indexSrc + '\n' + probeSrc;
    const queryCalls = (src.match(/(?:query|_queryFn)\(\{/g) ?? []).length;
    const spreads = (src.match(/claudeExecutableOpt\(/g) ?? []).length;
    expect(queryCalls).toBeGreaterThan(0);
    expect(spreads).toBe(queryCalls);
  });
});
