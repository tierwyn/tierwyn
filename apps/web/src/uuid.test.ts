import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from './uuid';

afterEach(() => vi.unstubAllGlobals());

it('falls back to a valid v4 when crypto.randomUUID is missing (insecure context)', () => {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
  const id = randomUUID();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(randomUUID()).not.toBe(id);
});
