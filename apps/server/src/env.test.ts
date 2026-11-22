import { describe, it, expect } from 'vitest';
import { findEnvFile } from './env.js';

describe('findEnvFile', () => {
  it('returns the .env in the starting directory', () => {
    const exists = (p: string) => p === '/a/b/c/.env';
    expect(findEnvFile('/a/b/c', exists)).toBe('/a/b/c/.env');
  });

  it('walks up to a parent directory that has a .env (monorepo root)', () => {
    const exists = (p: string) => p === '/a/.env';
    expect(findEnvFile('/a/b/c', exists)).toBe('/a/.env');
  });

  it('prefers the closest .env when several ancestors have one', () => {
    const exists = (p: string) => p === '/a/.env' || p === '/a/b/.env';
    expect(findEnvFile('/a/b/c', exists)).toBe('/a/b/.env');
  });

  it('returns undefined when no .env exists up to the filesystem root', () => {
    expect(findEnvFile('/a/b/c', () => false)).toBeUndefined();
  });
});
