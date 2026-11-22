import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { NOTIFICATION_DEFAULTS } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  getNotificationSettings,
  updateNotificationSettings,
  publicNotificationSettings,
} from './settings.js';
import { registerNotificationSettingsRoutes } from '../routes/settings.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

function boot() {
  const db = freshDb();
  const app = express();
  app.use(express.json());
  registerNotificationSettingsRoutes(app, () => db);
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

describe('getNotificationSettings', () => {
  it('returns NOTIFICATION_DEFAULTS on a fresh DB without a seed row', () => {
    const db = freshDb();
    expect(getNotificationSettings(db)).toEqual(NOTIFICATION_DEFAULTS);
    expect(getNotificationSettings(db).enabled).toBe(false);
  });
});

describe('updateNotificationSettings', () => {
  it('persists enabled and leaves other fields at their defaults', () => {
    const db = freshDb();
    const updated = updateNotificationSettings(db, { enabled: true });
    expect(updated.enabled).toBe(true);
    expect(updated.conversationComplete).toBe(NOTIFICATION_DEFAULTS.conversationComplete);
    expect(updated.scheduleFired).toBe(NOTIFICATION_DEFAULTS.scheduleFired);
    expect(updated.scheduleRunEnded).toBe(NOTIFICATION_DEFAULTS.scheduleRunEnded);
    expect(updated.scheduleDisabled).toBe(NOTIFICATION_DEFAULTS.scheduleDisabled);
    expect(updated.vapidSubject).toBe(NOTIFICATION_DEFAULTS.vapidSubject);
    expect(getNotificationSettings(db).enabled).toBe(true);
  });

  it('does not drop previously-set keys on a partial second patch', () => {
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, scheduleFired: false });
    const second = updateNotificationSettings(db, { conversationComplete: false });
    expect(second.enabled).toBe(true);
    expect(second.scheduleFired).toBe(false);
    expect(second.conversationComplete).toBe(false);
    expect(second.scheduleRunEnded).toBe(true);
    expect(getNotificationSettings(db)).toEqual(second);
  });
});

describe('publicNotificationSettings', () => {
  it('omits vapidPrivateKey entirely and keeps vapidPublicKey', () => {
    const s = {
      ...NOTIFICATION_DEFAULTS,
      vapidPublicKey: 'pub',
      vapidPrivateKey: 'SECRET',
    };
    const out = publicNotificationSettings(s);
    expect('vapidPrivateKey' in out).toBe(false);
    expect(out.vapidPublicKey).toBe('pub');
  });
});

describe('GET/POST /settings/notifications', () => {
  it('round-trips a category toggle', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/notifications', { scheduleDisabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      settings: expect.objectContaining({
        enabled: false,
        scheduleDisabled: false,
        conversationComplete: true,
      }),
    });
    expect((res.body as { settings: Record<string, unknown> }).settings).not.toHaveProperty('vapidPrivateKey');

    const get = await fetchJson(app, 'GET', '/settings/notifications');
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      settings: expect.objectContaining({ scheduleDisabled: false }),
    });
    expect((get.body as { settings: Record<string, unknown> }).settings).not.toHaveProperty('vapidPrivateKey');
  });

  it('ignores vapidPrivateKey on POST so the stored private key is untouched', async () => {
    const { db, app } = boot();
    updateNotificationSettings(db, { vapidPrivateKey: 'KEEP-ME' });
    const res = await fetchJson(app, 'POST', '/settings/notifications', {
      vapidPrivateKey: 'x',
      vapidPublicKey: 'forged',
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(getNotificationSettings(db).vapidPrivateKey).toBe('KEEP-ME');
    expect(getNotificationSettings(db).vapidPublicKey).toBe('');
    expect(getNotificationSettings(db).enabled).toBe(true);
    expect((res.body as { settings: Record<string, unknown> }).settings).not.toHaveProperty('vapidPrivateKey');
  });
});
