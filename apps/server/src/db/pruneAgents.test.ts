import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { migrations } from './migrations/index.js';
import { pruneUnregisteredAgents } from './pruneAgents.js';

const NOW = Date.now();

function seedAgent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, id, id, NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(`${id}:m`, id, 'm', 'm', NOW);
  db.prepare(
    `INSERT INTO agent_commands (id, agent_id, name, label, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(`${id}:cmd`, id, 'cmd', 'cmd', NOW);
}

describe('pruneUnregisteredAgents', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
  });
  afterEach(() => db.close());

  it('deletes catalogue and vault rows for types not in the registry, keeps registered ones', () => {
    seedAgent(db, 'a');
    seedAgent(db, 'b');
    db.prepare(
      `INSERT INTO plugin_secrets (plugin_id, key, key_id, ciphertext, iv, tag, updated_at)
       VALUES ('tierwyn:agents', 'env.b.KEY', 'sess:v1', x'00', x'00', x'00', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO plugin_secrets (plugin_id, key, key_id, ciphertext, iv, tag, updated_at)
       VALUES ('tierwyn:agents', 'env.a.KEY', 'sess:v1', x'00', x'00', x'00', ?)`,
    ).run(NOW);

    expect(pruneUnregisteredAgents(db, ['a'])).toBe(1);

    const agents = db.prepare('SELECT id FROM agents ORDER BY id').all() as { id: string }[];
    expect(agents).toEqual([{ id: 'a' }]);
    expect(db.prepare('SELECT id FROM agent_models').all()).toEqual([{ id: 'a:m' }]);
    expect(db.prepare('SELECT id FROM agent_commands').all()).toEqual([{ id: 'a:cmd' }]);
    const secrets = db.prepare(
      "SELECT key FROM plugin_secrets WHERE plugin_id = 'tierwyn:agents' ORDER BY key",
    ).all() as { key: string }[];
    expect(secrets).toEqual([{ key: 'env.a.KEY' }]);
  });

  it('nulls transcript references to pruned models instead of failing the FK', () => {
    db.pragma('foreign_keys = ON');
    seedAgent(db, 'b');
    db.pragma('foreign_keys = OFF'); // ponytail: skip seeding the project/conversation chain
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, agent_model_id, created_at, updated_at)
       VALUES ('s', 'c', 'b', 'b:m', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO events (id, session_id, type, payload, sender, agent_model_id, ts)
       VALUES ('e', 's', 'message', '{}', 'agent', 'b:m', ?)`,
    ).run(NOW);
    db.pragma('foreign_keys = ON');

    expect(pruneUnregisteredAgents(db, [])).toBe(1);
    expect(db.prepare('SELECT agent_model_id FROM events').get()).toEqual({ agent_model_id: null });
  });
});
