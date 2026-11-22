import { describe, it, expect } from 'vitest';
import { installSourceLabel } from './remoteHostInstallLabel';

describe('installSourceLabel', () => {
  it('shortens a git sha and leaves package ids whole', () => {
    expect(installSourceLabel({ gitSha: '2890dc3abcdef' })).toEqual({ source: 'git', id: '2890dc3' });
    expect(installSourceLabel({ installSource: 'package', gitSha: 'abc12345' }))
      .toEqual({ source: 'package', id: 'abc12345' });
  });

  it('prefixes release semver when hello.version is present', () => {
    expect(installSourceLabel({ gitSha: '2890dc3abcdef', version: '0.2.0' }))
      .toEqual({ source: 'git', id: '0.2.0 · 2890dc3' });
    expect(installSourceLabel({ installSource: 'package', gitSha: 'abc12345', version: '0.2.0' }))
      .toEqual({ source: 'package', id: '0.2.0 · abc12345' });
  });

  it('stays unchanged when version is absent (old nodes)', () => {
    expect(installSourceLabel({ gitSha: '2890dc3abcdef' })).toEqual({ source: 'git', id: '2890dc3' });
    expect(installSourceLabel({})).toEqual({ source: 'git', id: '—' });
  });
});
