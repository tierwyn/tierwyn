import { homedir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BRAND, configDir, PROJECT_STATE_DIR, runDir } from './brand.js';

describe('brand helpers', () => {
  it('uses tierwyn names', () => {
    expect(BRAND).toBe('tierwyn');
    expect(PROJECT_STATE_DIR).toBe('.tierwyn');
    expect(runDir()).toBe(join(homedir(), '.tierwyn', 'run'));
  });

  it('configDir honours XDG_CONFIG_HOME', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x' })).toBe('/x/tierwyn');
  });
});
