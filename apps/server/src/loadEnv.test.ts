import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadEnv', () => {
  const origCwd = process.cwd();
  const origNodeEnv = process.env.NODE_ENV;
  const origTestVar = process.env.TIERWYN_LOADENV_TEST_VAR;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tierwyn-loadenv-'));
    writeFileSync(join(tmpDir, '.env'), 'TIERWYN_LOADENV_TEST_VAR=from-dotenv\n');
    delete process.env.TIERWYN_LOADENV_TEST_VAR;
    process.chdir(tmpDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origTestVar === undefined) delete process.env.TIERWYN_LOADENV_TEST_VAR;
    else process.env.TIERWYN_LOADENV_TEST_VAR = origTestVar;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips loading workspace .env when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    await import('./loadEnv.js');
    expect(process.env.TIERWYN_LOADENV_TEST_VAR).toBeUndefined();
  });

  it('loads workspace .env when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'development';
    await import('./loadEnv.js');
    expect(process.env.TIERWYN_LOADENV_TEST_VAR).toBe('from-dotenv');
  });
});
