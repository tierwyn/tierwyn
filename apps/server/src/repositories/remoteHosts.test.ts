import { createHash, randomBytes } from 'crypto';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createConversation } from './conversations.js';
import { createProject } from './projects.js';
import {
  createPendingHost,
  deleteRemoteHost,
  getRemoteHost,
  keyFingerprint,
  redeemEnrollToken,
  remoteHostIdFor,
  saveHello,
} from './remoteHosts.js';
import type { NodeHello } from '@tierwyn/shared';

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const enroll = {
  publicKey: randomBytes(32).toString('base64'),
  hubOrigin: 'https://hub.example',
  hello: { hostname: 'node-a', protocol: 1 },
};

describe('remoteHosts repository', () => {
  it('redeem succeeds once and defaults to trusted', () => {
    const db = fresh();
    const hash = 'abc';
    createPendingHost(db, 'alpha', hash, Date.now() + 60_000);
    const first = redeemEnrollToken(db, hash, Date.now(), enroll);
    expect(first?.status).toBe('trusted');
    expect(first?.publicKey).toBe(enroll.publicKey);
    expect(redeemEnrollToken(db, hash, Date.now(), enroll)).toBeUndefined();
  });

  it('redeem with autoTrust false lands enrolled', () => {
    const db = fresh();
    const hash = 'manual';
    createPendingHost(db, 'manual', hash, Date.now() + 60_000, false);
    const first = redeemEnrollToken(db, hash, Date.now(), enroll);
    expect(first?.status).toBe('enrolled');
    expect(redeemEnrollToken(db, hash, Date.now(), enroll)).toBeUndefined();
  });

  it('redeem rejects expired', () => {
    const db = fresh();
    const hash = 'expired';
    createPendingHost(db, 'beta', hash, Date.now() - 1);
    expect(redeemEnrollToken(db, hash, Date.now(), enroll)).toBeUndefined();
  });

  it('single-use under concurrent redeem', () => {
    const db = fresh();
    const hash = 'once';
    createPendingHost(db, 'gamma', hash, Date.now() + 60_000);
    const a = redeemEnrollToken(db, hash, Date.now(), enroll);
    const b = redeemEnrollToken(db, hash, Date.now(), enroll);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('token hash cleared after redeem', () => {
    const db = fresh();
    const hash = 'clear-me';
    const host = createPendingHost(db, 'delta', hash, Date.now() + 60_000);
    redeemEnrollToken(db, hash, Date.now(), enroll);
    const raw = db.prepare('SELECT enroll_token_hash FROM remote_hosts WHERE id=?')
      .get(host.id) as { enroll_token_hash: string | null };
    expect(raw.enroll_token_hash).toBeNull();
  });

  it('remoteHostIdFor resolves via conversation → project', () => {
    const db = fresh();
    const host = createPendingHost(db, 'eps', 'h', Date.now() + 60_000);
    const project = createProject(db, { name: 'P', rootPath: '/tmp/p', remoteHostId: host.id });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    expect(remoteHostIdFor(db, { projectId: project.id })).toBe(host.id);
    expect(remoteHostIdFor(db, { conversationId: conv.id })).toBe(host.id);
  });

  it('delete refuses while a project references host', () => {
    const db = fresh();
    const host = createPendingHost(db, 'zeta', 'h', Date.now() + 60_000);
    createProject(db, { name: 'P', rootPath: '/tmp/p', remoteHostId: host.id });
    expect(deleteRemoteHost(db, host.id)).toEqual({ ok: false, projects: 1, projectNames: ['P'] });
  });

  it('delete with unbind nulls projects then removes the host', () => {
    const db = fresh();
    const host = createPendingHost(db, 'unbind-me', 'h', Date.now() + 60_000);
    const project = createProject(db, { name: 'P', rootPath: '/tmp/p', remoteHostId: host.id });
    expect(deleteRemoteHost(db, host.id, { unbind: true }))
      .toEqual({ ok: true, projects: 0, projectNames: ['P'] });
    expect(db.prepare('SELECT id FROM remote_hosts WHERE id = ?').get(host.id)).toBeUndefined();
    const row = db.prepare('SELECT remote_host_id FROM projects WHERE id = ?')
      .get(project.id) as { remote_host_id: string | null };
    expect(row.remote_host_id).toBeNull();
  });

  it('saveHello keeps a short version and drops empty, long, or non-string', () => {
    const db = fresh();
    const host = createPendingHost(db, 'ver', 'h', Date.now() + 60_000);
    redeemEnrollToken(db, 'h', Date.now(), enroll);
    const base = { protocol: 1, gitSha: 'deadbeef', hostname: 'n' } as NodeHello;

    saveHello(db, host.id, { ...base, version: '0.2.0' }, 1);
    expect(getRemoteHost(db, host.id)?.hello.version).toBe('0.2.0');

    saveHello(db, host.id, { ...base }, 2);
    expect(getRemoteHost(db, host.id)?.hello.version).toBeUndefined();

    saveHello(db, host.id, { ...base, version: '' }, 3);
    expect(getRemoteHost(db, host.id)?.hello.version).toBeUndefined();

    saveHello(db, host.id, { ...base, version: 'x'.repeat(33) }, 4);
    expect(getRemoteHost(db, host.id)?.hello.version).toBeUndefined();

    saveHello(db, host.id, { ...base, version: 12 as unknown as string }, 5);
    expect(getRemoteHost(db, host.id)?.hello.version).toBeUndefined();
  });

  it('fingerprint is stable', () => {
    const key = Buffer.from('ed25519-spki-bytes').toString('base64');
    const a = keyFingerprint(key);
    const b = keyFingerprint(key);
    expect(a).toBe(b);
    expect(a.startsWith('SHA256:')).toBe(true);
    expect(a.endsWith('=')).toBe(false);
    const raw = createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
    expect(a).toBe(`SHA256:${raw}`);
  });
});
