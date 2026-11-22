import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { runModelDiscovery, runCommandDiscovery, runVersionDiscovery } from './scheduler.js';
import { loadVersionCache } from './versions.js';
import type { AgentAdapter, ModelDescriptor, CommandDescriptor } from '@tierwyn/shared';

function fakeAdapter(models: ModelDescriptor[], throws = false): AgentAdapter {
  return {
    start: async () => {}, sendPrompt: async () => {}, streamEvents: () => ({} as never),
    stop: async () => {}, listSessions: async () => [], loadSession: async () => {},
    listModels: async () => { if (throws) throw new Error('not installed'); return models; },
  };
}

describe('runModelDiscovery', () => {
  it('upserts models for every agent that returns them', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const agents = {
      'claude-code': { label: 'Claude Code', create: () => fakeAdapter([{ name: 'claude-sonnet-4-6', label: 'Sonnet 4.6', provider: 'anthropic' }]) },
      pi: { label: 'Pi', create: () => fakeAdapter([{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama' }]) },
    };
    await runModelDiscovery(db, agents);
    const n = (db.prepare('SELECT COUNT(*) c FROM agent_models').get() as { c: number }).c;
    expect(n).toBe(2);
  });

  it('continues when one agent throws', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const agents = {
      pi: { label: 'Pi', create: () => fakeAdapter([], true) },
      'claude-code': { label: 'Claude Code', create: () => fakeAdapter([{ name: 'claude-opus-4-8', label: 'Opus', provider: 'anthropic' }]) },
    };
    await runModelDiscovery(db, agents);
    const n = (db.prepare('SELECT COUNT(*) c FROM agent_models').get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('times out a hung agent without blocking others', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const hung: AgentAdapter = {
      ...fakeAdapter([]),
      listModels: () => new Promise(() => {}), // never resolves
    };
    const agents = {
      opencode: { label: 'OpenCode', create: () => hung },
      'claude-code': { label: 'Claude Code', create: () => fakeAdapter([{ name: 'claude-opus-4-8', label: 'Opus', provider: 'anthropic' }]) },
    };
    await runModelDiscovery(db, agents, 50);
    const n = (db.prepare('SELECT COUNT(*) c FROM agent_models').get() as { c: number }).c;
    expect(n).toBe(1);
  });
});

describe('runCommandDiscovery', () => {
  it('upserts commands when adapter implements listCommands', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const agents = {
      'claude-code': {
        label: 'Claude Code',
        create: () => ({
          ...fakeAdapter([]),
          listCommands: async (): Promise<CommandDescriptor[]> => [
            { name: 'find-skills', label: 'find-skills', sourceDetail: 'skill' },
          ],
        }),
      },
    };
    await runCommandDiscovery(db, agents);
    const n = (db.prepare("SELECT COUNT(*) c FROM agent_commands WHERE agent_id='claude-code'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('skips agents without listCommands', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    await runCommandDiscovery(db, { pi: { label: 'Pi', create: () => fakeAdapter([]) } });
    const n = (db.prepare('SELECT COUNT(*) c FROM agent_commands').get() as { c: number }).c;
    expect(n).toBe(0);
  });
});

describe('runVersionDiscovery', () => {
  it('writes the version cache when invoked with options', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    await runVersionDiscovery(db, {
      probe: async () => '2.0.0',
      npm: async () => '2.1.0',
      github: async () => '2.1.0',
    });
    const cache = loadVersionCache(db);
    expect(cache['claude-code']?.latest).toBe('2.1.0');
    expect(cache['opencode']?.latest).toBe('2.1.0');
  });
});

