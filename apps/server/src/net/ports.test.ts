import { describe, it, expect } from 'vitest';
import { createServer } from 'net';
import { findFreePort } from './ports.js';

describe('findFreePort', () => {
  it('returns a port that can actually be bound', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
    });
  });

  it('returns distinct ports across rapid calls', async () => {
    const a = await findFreePort();
    const b = await findFreePort();
    expect(a).not.toBe(b);
  });
});
