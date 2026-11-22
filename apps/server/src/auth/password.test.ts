import { describe, it, expect } from 'vitest';
import argon2 from 'argon2';
import { verifyPassword } from './password.js';

describe('verifyPassword', () => {
  it('accepts the correct password against an argon2 hash', async () => {
    const hash = await argon2.hash('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await argon2.hash('correct horse battery staple');
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('rejects when the hash is missing or empty', async () => {
    expect(await verifyPassword(undefined, 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('rejects an empty password', async () => {
    const hash = await argon2.hash('something');
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('rejects a malformed hash without throwing', async () => {
    expect(await verifyPassword('not-an-argon2-hash', 'anything')).toBe(false);
  });
});
