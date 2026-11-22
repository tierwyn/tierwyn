import { describe, expect, it } from 'vitest';
import { TIERWYN_VERSION } from './version.js';

describe('TIERWYN_VERSION', () => {
  it('exports the release version', () => {
    expect(TIERWYN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
