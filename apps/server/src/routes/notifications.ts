import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { ensureVapidKeys } from '../notifications/notifier.js';
import { deletePushSubscription, upsertPushSubscription } from '../repositories/pushSubscriptions.js';
import { assertOutboundUrl, OutboundUrlError } from '../net/outboundUrl.js';

export function registerNotificationRoutes(app: Express, getDb: () => Database): void {
  app.get('/notifications/vapid-public-key', (_req, res) => {
    const keys = ensureVapidKeys(getDb());
    res.json({ key: keys.publicKey });
  });

  app.post('/notifications/subscribe', async (req, res) => {
    const body = (req.body ?? {}) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
    const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: 'endpoint and keys.p256dh / keys.auth are required' });
      return;
    }
    try {
      await assertOutboundUrl(endpoint, 'public-only', { httpsOnly: true });
    } catch (e) {
      if (e instanceof OutboundUrlError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    upsertPushSubscription(getDb(), { endpoint, p256dh, auth, userAgent: ua });
    res.status(204).end();
  });

  app.delete('/notifications/subscribe', (req, res) => {
    const body = (req.body ?? {}) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }
    deletePushSubscription(getDb(), endpoint);
    res.status(204).end();
  });
}
