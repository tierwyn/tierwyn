import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, enableAllAgents } from './db/seed.js';
import { ProfileCatalogue } from './catalogue.js';

const here = dirname(fileURLToPath(import.meta.url));
const profilesJson = JSON.parse(
  readFileSync(join(here, '..', 'agent-profiles.json'), 'utf-8')
) as { profiles: Array<{ id: string; model: string; enabled: boolean; contextWindow?: number }> };
const enabledProfiles = profilesJson.profiles.filter((p) => p.enabled);

describe('catalogue from sqlite', () => {
  it('loads all enabled profiles from agent_profiles.json', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    enableAllAgents(db);

    const cat = new ProfileCatalogue();
    cat.load(db);

    const ids = cat.listProfiles().map((p) => p.id).sort();
    expect(ids).toEqual(enabledProfiles.map((p) => p.id).sort());
  });

  it('maps model names correctly', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    enableAllAgents(db);

    const cat = new ProfileCatalogue();
    cat.load(db);

    for (const { id, model } of enabledProfiles) {
      expect(cat.getProfile(id)?.model).toBe(model);
    }
  });

  // FW-7: the usage route reads the persisted window off the in-memory profile
  // rather than issuing a second query inside the request handler.
  it('carries the persisted context_window onto AgentProfile.contextWindow', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    enableAllAgents(db);

    const cat = new ProfileCatalogue();
    cat.load(db);

    // agent-profiles.json advertises 1M for claude-code:opus-5.
    const windowed = profilesJson.profiles.find(
      (p) => (p as { contextWindow?: number }).contextWindow !== undefined && p.enabled,
    ) as { id: string; contextWindow: number };
    expect(cat.getProfile(windowed.id)?.contextWindow).toBe(windowed.contextWindow);
  });

  it('leaves contextWindow undefined for a row with a NULL context_window', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    enableAllAgents(db);
    db.prepare("INSERT INTO agents (id,type,label,description,executable_path,env_vars,created_at) VALUES ('pi','pi','Pi','',NULL,'{}',0)")
      .run();
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, source, created_at)
       VALUES ('pi:ollama/qwen','pi','ollama/qwen','Pi · Qwen',NULL,0,0,1,'','user',0)`
    ).run();

    const cat = new ProfileCatalogue();
    cat.load(db);
    expect(cat.getProfile('pi:ollama/qwen')?.contextWindow).toBeUndefined();
  });

  it('listProfiles is empty after a fresh seed because all agents are disabled', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    const cat = new ProfileCatalogue();
    cat.load(db);
    expect(cat.listProfiles()).toEqual([]);
    const models = db.prepare('SELECT COUNT(*) AS n FROM agent_models').get() as { n: number };
    expect(models.n).toBeGreaterThan(0);
  });

  it("listProfiles returns only the enabled agent's models", () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    db.prepare("UPDATE agents SET enabled_flag=1 WHERE id='claude-code'").run();
    const cat = new ProfileCatalogue();
    cat.load(db);
    const listed = cat.listProfiles();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((p) => p.agentType === 'claude-code')).toBe(true);
  });

  it('a disabled agent hides its models even when the model rows are enabled', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    enableAllAgents(db);
    const cat = new ProfileCatalogue();
    cat.load(db);
    const before = cat.profilesForAgent('codex').length;
    expect(before).toBeGreaterThan(0);
    const modelOn = db.prepare(
      "SELECT COUNT(*) AS n FROM agent_models WHERE agent_id='codex' AND enabled_flag=1",
    ).get() as { n: number };
    db.prepare("UPDATE agents SET enabled_flag=0 WHERE id='codex'").run();
    cat.load(db);
    expect(cat.profilesForAgent('codex')).toEqual([]);
    const modelOnAfter = db.prepare(
      "SELECT COUNT(*) AS n FROM agent_models WHERE agent_id='codex' AND enabled_flag=1",
    ).get() as { n: number };
    expect(modelOnAfter.n).toBe(modelOn.n);
  });

  it('getProfile reports enabled:false for a disabled agent\'s model', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db);
    const id = db.prepare(
      "SELECT id FROM agent_models WHERE agent_id='claude-code' AND enabled_flag=1 LIMIT 1",
    ).get() as { id: string };
    const cat = new ProfileCatalogue();
    cat.load(db);
    expect(cat.getProfile(id.id)?.enabled).toBe(false);
  });
});
