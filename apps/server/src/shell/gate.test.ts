import { describe, it, expect } from 'vitest';
import { gate } from './gate.js';

describe('gate', () => {
  it('allows base single-token binary with args', () => {
    expect(gate(['ls', '-la'], [])).toEqual({ ok: true });
  });

  it('allows base multi-token git status with extra args', () => {
    expect(gate(['git', 'status', '-s'], [])).toEqual({ ok: true });
  });

  it('refuses git clean (not allow-listed prefix)', () => {
    expect(gate(['git', 'clean', '-fdx'], [])).toEqual({ ok: false, reason: 'not_allowlisted' });
  });

  it('refuses rm (not allow-listed)', () => {
    expect(gate(['rm', '-rf', '/'], [])).toEqual({ ok: false, reason: 'not_allowlisted' });
  });

  it('allows per-project rule (npm test)', () => {
    expect(gate(['npm', 'test'], [['npm', 'test']])).toEqual({ ok: true });
  });

  it('denies destructive flag on otherwise-allowed prefix (per-project ["git"] + --hard)', () => {
    expect(gate(['git', 'reset', '--hard'], [['git']])).toEqual({ ok: false, reason: 'denied' });
  });

  it('prefer not_allowlisted over denied when neither matches', () => {
    // rm is not allow-listed, so fail closed as not_allowlisted (never reaches deny)
    expect(gate(['rm', '-rf'], [])).toEqual({ ok: false, reason: 'not_allowlisted' });
  });

  it('wildcard: deploy* matches deploy:prod', () => {
    expect(gate(['npm', 'run', 'deploy:prod'], [['npm', 'run', 'deploy*']])).toEqual({ ok: true });
  });

  it('wildcard: deploy* matches bare deploy and deploy:prod:full', () => {
    expect(gate(['npm', 'run', 'deploy'], [['npm', 'run', 'deploy*']])).toEqual({ ok: true });
    expect(gate(['npm', 'run', 'deploy:prod:full'], [['npm', 'run', 'deploy*']])).toEqual({ ok: true });
  });

  it('wildcard: refuses a different prefix', () => {
    expect(gate(['npm', 'run', 'evil'], [['npm', 'run', 'deploy*']]))
      .toEqual({ ok: false, reason: 'not_allowlisted' });
  });

  it('wildcard: deny token still catches --force on a wildcard match', () => {
    expect(gate(['npm', 'run', 'deploy', '--force'], [['npm', 'run', 'deploy*']]))
      .toEqual({ ok: false, reason: 'denied' });
  });

  it('wildcard: length constraint — shorter argv than rule is refused', () => {
    expect(gate(['npm', 'run'], [['npm', 'run', 'deploy*']]))
      .toEqual({ ok: false, reason: 'not_allowlisted' });
  });

  it('wildcard: multi-token rule, non-last tokens still strict', () => {
    expect(gate(['npm', 'runx', 'deploy'], [['npm', 'run', 'deploy*']]))
      .toEqual({ ok: false, reason: 'not_allowlisted' });
  });

  it('backward-compat: non-wildcard per-project rule unchanged', () => {
    expect(gate(['npm', 'test'], [['npm', 'test']])).toEqual({ ok: true });
    expect(gate(['npm', 'test', '--watch'], [['npm', 'test']])).toEqual({ ok: true });
  });

  it('bare trailing * matches any single token at that position (option A)', () => {
    expect(gate(['npm', 'run', 'anything'], [['npm', 'run', '*']])).toEqual({ ok: true });
    expect(gate(['npm', 'run'], [['npm', 'run', '*']])).toEqual({ ok: false, reason: 'not_allowlisted' });
  });
});
