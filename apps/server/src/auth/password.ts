import argon2 from 'argon2';

/**
 * Verify a plaintext operator password against the stored argon2 hash.
 * Returns a generic boolean; never throws and never logs the password.
 */
export async function verifyPassword(hash: string | undefined, password: string): Promise<boolean> {
  if (!hash || !password) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
