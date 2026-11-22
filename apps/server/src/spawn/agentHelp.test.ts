import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { AGENT_HELP_TOPICS, registerAgentHelpRoutes } from './agentHelp.js';

function mount(opts?: { loopback?: boolean }): Promise<{ server: Server; base: string }> {
  const app = express();
  if (opts?.loopback === false) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: '8.8.8.8',
        configurable: true,
      });
      next();
    });
  }
  registerAgentHelpRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('GET /agent/help', () => {
  it('200 markdown index from loopback, listing every topic', async () => {
    const mounted = await mount();
    server = mounted.server;
    const res = await fetch(`${mounted.base}/agent/help`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/markdown/i);
    const text = await res.text();
    expect(text).toContain('# Agent help');
    for (const topic of AGENT_HELP_TOPICS) expect(text).toContain(topic);
    expect(text).not.toMatch(/Bearer [0-9a-f-]{36}/i);
  });

  it.each([...AGENT_HELP_TOPICS])('200 markdown for topic %s', async (topic) => {
    const mounted = await mount();
    server = mounted.server;
    const res = await fetch(`${mounted.base}/agent/help/${topic}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/markdown/i);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(80);
    expect(text).not.toMatch(/Bearer [0-9a-f-]{36}/i);
  });

  it('unknown topic → 404 with the topic list', async () => {
    const mounted = await mount();
    server = mounted.server;
    const res = await fetch(`${mounted.base}/agent/help/nope`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain('Unknown topic');
    for (const topic of AGENT_HELP_TOPICS) expect(text).toContain(topic);
  });

  it('403 when remoteAddress is a public IP', async () => {
    const mounted = await mount({ loopback: false });
    server = mounted.server;
    const res = await fetch(`${mounted.base}/agent/help`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'loopback only' });
    const topic = await fetch(`${mounted.base}/agent/help/spawn`);
    expect(topic.status).toBe(403);
  });
});
