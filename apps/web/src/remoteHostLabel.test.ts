import { describe, it, expect } from 'vitest';
import { remoteHostLabel } from './remoteHostLabel';

describe('remoteHostLabel', () => {
  it('returns undefined for local projects', () => {
    expect(remoteHostLabel(null, [{ id: 'h1', name: 'box' }])).toBeUndefined();
    expect(remoteHostLabel(undefined, [])).toBeUndefined();
    expect(remoteHostLabel('', [{ id: 'h1', name: 'box' }])).toBeUndefined();
  });

  it('returns the host name for a known id', () => {
    expect(remoteHostLabel('h2', [{ id: 'h1', name: 'a' }, { id: 'h2', name: 'box' }])).toBe('box');
  });

  it('prefers hello.hostname when present', () => {
    const hosts = [{ id: 'h2', name: 'box', hello: { hostname: 'node-prod-01' } }];
    expect(remoteHostLabel('h2', hosts)).toBe('node-prod-01');
  });

  it('returns the generic label for an unknown id', () => {
    expect(remoteHostLabel('gone', [{ id: 'h1', name: 'box' }])).toBe('remote host');
  });
});
