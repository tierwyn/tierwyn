import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { registerHealthRoutes, getHealthInfo } from './health.js';

let server: Server;
let base: string;

beforeEach(async () => {
  const app = express();
  registerHealthRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('GET /health', () => {
  it('returns ok fingerprint fields', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      version: string;
      gitSha: string | null;
      builtAt: string;
      serverMode: string;
      startedAt: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.builtAt).toBe('string');
    expect(body.builtAt.length).toBeGreaterThan(0);
    expect(['dist', 'tsx', 'unknown']).toContain(body.serverMode);
    expect(typeof body.startedAt).toBe('number');
  });
});

describe('getHealthInfo', () => {
  it('is stable across calls within the process', () => {
    const a = getHealthInfo();
    const b = getHealthInfo();
    expect(a.startedAt).toBe(b.startedAt);
    expect(a.serverMode).toBe(b.serverMode);
    expect(a.version).toBe(b.version);
  });
});
