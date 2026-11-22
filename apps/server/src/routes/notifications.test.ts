import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { listPushSubscriptions } from '../repositories/pushSubscriptions.js';
import { registerNotificationRoutes } from './notifications.js';
import { notifierDeps } from '../notifications/notifier.js';
import { outboundDns } from '../net/outboundUrl.js';

function boot() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  notifierDeps.generateVAPIDKeys = () => ({ publicKey: 'PUB-ROUTE', privateKey: 'PRIV-ROUTE' });
  const app = express();
  app.use(express.json());
  registerNotificationRoutes(app, () => db);
  return { db, app };
}

function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (r) => {
          const text = await r.text();
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          return { status: r.status, body: parsed };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('notification routes', () => {
  const origLookup = outboundDns.lookup;
  beforeEach(() => {
    outboundDns.lookup = (async () => [{ address: '1.2.3.4', family: 4 }]) as typeof outboundDns.lookup;
  });
  afterEach(() => {
    outboundDns.lookup = origLookup;
  });

  it('subscribe then list has 1; subscribe twice still 1; delete → 0', async () => {
    const { db, app } = boot();
    const body = { endpoint: 'https://push.example/a', keys: { p256dh: 'p1', auth: 'a1' } };
    const first = await fetchJson(app, 'POST', '/notifications/subscribe', body);
    expect(first.status).toBe(204);
    expect(listPushSubscriptions(db)).toHaveLength(1);

    const second = await fetchJson(app, 'POST', '/notifications/subscribe', {
      ...body, keys: { p256dh: 'p2', auth: 'a2' },
    });
    expect(second.status).toBe(204);
    const rows = listPushSubscriptions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('p2');

    const del = await fetchJson(app, 'DELETE', '/notifications/subscribe', { endpoint: body.endpoint });
    expect(del.status).toBe(204);
    expect(listPushSubscriptions(db)).toHaveLength(0);
  });

  it('rejects a malformed subscribe body with 400', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/notifications/subscribe', { endpoint: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects a loopback push endpoint', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/notifications/subscribe', {
      endpoint: 'http://127.0.0.1/push',
      keys: { p256dh: 'p1', auth: 'a1' },
    });
    expect(res.status).toBe(400);
  });

  it('GET vapid-public-key returns the generated public key', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'GET', '/notifications/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'PUB-ROUTE' });
  });
});
