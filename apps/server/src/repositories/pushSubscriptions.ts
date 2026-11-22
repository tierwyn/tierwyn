import type { Database } from 'better-sqlite3';

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
  userAgent?: string;
}

interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  user_agent: string | null;
}

function toRow(r: Row): PushSubscriptionRow {
  return {
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at,
    ...(r.user_agent ? { userAgent: r.user_agent } : {}),
  };
}

export function upsertPushSubscription(
  db: Database,
  s: Omit<PushSubscriptionRow, 'createdAt'>,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, user_agent)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent
  `).run(s.endpoint, s.p256dh, s.auth, now, s.userAgent ?? null);
}

export function deletePushSubscription(db: Database, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function listPushSubscriptions(db: Database): PushSubscriptionRow[] {
  return (db.prepare(
    'SELECT endpoint, p256dh, auth, created_at, user_agent FROM push_subscriptions',
  ).all() as Row[]).map(toRow);
}
