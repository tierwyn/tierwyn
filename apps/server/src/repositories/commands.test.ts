import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  upsertDiscoveredCommands, createCommand, updateCommand, listAllCommandsForAgent,
  normaliseCommandName,
} from './commands.js';
import { ensureAgent } from './models.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('commands repo', () => {
  it('upserts and prunes discovered commands', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    upsertDiscoveredCommands(db, 'claude-code', [
      { name: 'find-skills', label: 'find-skills', description: 'Discover skills', sourceDetail: 'skill' },
      { name: 'commit', label: 'commit', description: 'Commit helper', sourceDetail: 'skill' },
    ]);
    upsertDiscoveredCommands(db, 'claude-code', [
      { name: 'find-skills', label: 'find-skills', description: 'Discover skills', sourceDetail: 'skill' },
    ]);
    const rows = db.prepare("SELECT name FROM agent_commands WHERE agent_id='claude-code' ORDER BY name").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['find-skills']);
  });

  it('does not prune on empty list', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredCommands(db, 'pi', [{ name: 'x', label: 'X', sourceDetail: 'skill' }]);
    upsertDiscoveredCommands(db, 'pi', []);
    const n = (db.prepare("SELECT COUNT(*) c FROM agent_commands WHERE agent_id='pi'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('preserves enabled_flag across re-discovery', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredCommands(db, 'pi', [{ name: 'find-skills', label: 'find-skills', sourceDetail: 'skill' }]);
    db.prepare("UPDATE agent_commands SET enabled_flag=0 WHERE agent_id='pi' AND name='find-skills'").run();
    upsertDiscoveredCommands(db, 'pi', [{ name: 'find-skills', label: 'Find Skills', description: 'Updated', sourceDetail: 'skill' }]);
    const row = db.prepare(
      "SELECT enabled_flag e, label FROM agent_commands WHERE agent_id='pi' AND name='find-skills'"
    ).get() as { e: number; label: string };
    expect(row.e).toBe(0);
    expect(row.label).toBe('Find Skills');
  });

  it('T15 prune skips user commands', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    createCommand(db, 'pi', { name: 'deploy' });
    upsertDiscoveredCommands(db, 'pi', [{ name: 'other', label: 'other', sourceDetail: 'skill' }]);
    const rows = listAllCommandsForAgent(db, 'pi');
    const deploy = rows.find((c) => c.name === 'deploy');
    expect(deploy).toBeTruthy();
    expect(deploy!.source).toBe('user');
  });

  it('T16 name collision with discovery keeps source=user and refreshes label', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    createCommand(db, 'pi', { name: 'find-skills', label: 'Mine' });
    upsertDiscoveredCommands(db, 'pi', [{ name: 'find-skills', label: 'Theirs', sourceDetail: 'skill' }]);
    const row = listAllCommandsForAgent(db, 'pi').find((c) => c.name === 'find-skills');
    expect(row).toBeTruthy();
    expect(row!.source).toBe('user');
    expect(row!.label).toBe('Theirs');
  });

  it('T17 renaming a user command then discovering the old name does not throw', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    const created = createCommand(db, 'pi', { name: 'foo' });
    updateCommand(db, created.id, { name: 'bar' });
    expect(() => {
      upsertDiscoveredCommands(db, 'pi', [{ name: 'foo', label: 'foo', sourceDetail: 'skill' }]);
    }).not.toThrow();
    const rows = listAllCommandsForAgent(db, 'pi');
    expect(rows.find((c) => c.name === 'foo' && c.source === 'discovered')).toBeTruthy();
    expect(rows.find((c) => c.name === 'bar' && c.source === 'user')).toBeTruthy();
  });

  it('rename syncs defaulted label to the new name (B1)', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    const created = createCommand(db, 'pi', { name: 'deploy' });
    expect(created.label).toBe('deploy');
    const renamed = updateCommand(db, created.id, { name: 'ship' });
    expect(renamed?.name).toBe('ship');
    expect(renamed?.label).toBe('ship');
    // Custom label must survive rename.
    const custom = createCommand(db, 'pi', { name: 'build', label: 'Ship it' });
    const kept = updateCommand(db, custom.id, { name: 'compile' });
    expect(kept?.name).toBe('compile');
    expect(kept?.label).toBe('Ship it');
  });

  it('T18 updateCommand on an unknown id returns undefined', () => {
    const db = freshDb();
    expect(updateCommand(db, 'user:missing', { label: 'x' })).toBeUndefined();
  });

  it('T19 normaliseCommandName unit cases', () => {
    expect(normaliseCommandName('/x')).toBe('x');
    expect(normaliseCommandName(' x ')).toBe('x');
    expect(normaliseCommandName('a b')).toBeNull();
    expect(normaliseCommandName('')).toBeNull();
    expect(normaliseCommandName('-x')).toBeNull();
    expect(normaliseCommandName('skill:foo')).toBe('skill:foo');
  });
});
