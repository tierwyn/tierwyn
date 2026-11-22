import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { migrations } from './migrations/index.js';
import { seedCatalogue, seedDefaultSettings, enableAllAgents, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from './seed.js';
import { updateModel } from '../repositories/models.js';
import type { AgentProfile } from '@tierwyn/shared';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

// Synthetic profile sets used to exercise seedCatalogue without depending on
// the live agent-profiles.json contents. The optional second argument to
// seedCatalogue injects these directly.
function profile(id: string, agentType: string, model: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    agentType,
    model,
    label: `${agentType} · ${model}`,
    description: '',
    vision: false,
    steer: false,
    enabled: true,
    ...overrides,
  };
}

describe('seedCatalogue', () => {
  it('inserts all seeded agents and all seeded model profiles, idempotently', () => {
    const db = freshDb();
    seedCatalogue(db);
    seedCatalogue(db); // second call must not duplicate

    const agents = db.prepare('SELECT id FROM agents ORDER BY id').all() as { id: string }[];
    expect(agents.map((a) => a.id)).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'deepseek', 'grok-bot', 'grok-build', 'hermes', 'kimi', 'kiro', 'openclaw', 'qwen']);

    const models = db.prepare('SELECT id FROM agent_models ORDER BY id').all() as { id: string }[];
    expect(models.map((m) => m.id)).toEqual([
      'claude-code:fable-5',
      'claude-code:haiku-4.5',
      'claude-code:opus-4.8',
      'claude-code:sonnet-4.6',
      'codex:gpt-5.3-codex',
      'codex:gpt-5.4-mini',
      'codex:gpt-5.5',
      'copilot:auto',
      'copilot:claude-haiku-4.5',
      'copilot:claude-sonnet-5',
      'copilot:gpt-5.6-sol',
      'cursor:claude-opus-4-8-thinking-high',
      'cursor:composer-2.5',
      'deepseek:GLM-5.3',
      'deepseek:GLM-5.3-Flash',
      'deepseek:deepseek-chat',
      'deepseek:deepseek-reasoner',
      'grok-bot:default',
      'grok-build:grok-4.5',
      'grok-build:grok-4.6',
      'hermes:zai:glm-4.5',
      'hermes:zai:glm-5.1',
      'hermes:zai:glm-5.2',
      'hermes:zai:glm-5.3-flash',
      'kimi:zai-coding-plan/glm-4.7',
      'kimi:zai-coding-plan/glm-5-turbo',
      'kimi:zai-coding-plan/glm-5.2',
      'kimi:zai-coding-plan/glm-5.2-highspeed',
      'kimi:zai-coding-plan/glm-5.3',
      'kimi:zai-coding-plan/glm-5.3-flash',
      'kimi:zai-coding-plan/glm-5.3-highspeed',
      'kiro:auto',
      'kiro:claude-sonnet-4.5',
      'kiro:glm-5',
      'openclaw:glm-4.7-flash',
      'openclaw:glm-5-turbo',
      'qwen:GLM-5.3-Flash',
    ]);
  });

  it('marks every seeded row source=seed so discovery can never prune them', () => {
    const db = freshDb();
    seedCatalogue(db);
    const rows = db.prepare(
      "SELECT id, source FROM agent_models WHERE agent_id IN ('claude-code')"
    ).all() as { id: string; source: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === 'seed')).toBe(true);
  });

  it('prunes seed rows whose (agent_id, model_name) is no longer in the profile set', () => {
    const db = freshDb();
    // First boot: two profiles present.
    seedCatalogue(db, [
      profile('claude-code:sonnet-4.6', 'claude-code', 'claude-sonnet-4-6'),
      profile('claude-code:opus-4.8',   'claude-code', 'claude-opus-4-8'),
    ]);
    let names = db.prepare("SELECT model_name FROM agent_models WHERE agent_id='claude-code' ORDER BY model_name")
      .all() as { model_name: string }[];
    expect(names.map((r) => r.model_name)).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);

    // Second boot: opus removed from JSON. Its seed row must be pruned.
    seedCatalogue(db, [
      profile('claude-code:sonnet-4.6', 'claude-code', 'claude-sonnet-4-6'),
    ]);
    names = db.prepare("SELECT model_name FROM agent_models WHERE agent_id='claude-code' ORDER BY model_name")
      .all() as { model_name: string }[];
    expect(names.map((r) => r.model_name)).toEqual(['claude-sonnet-4-6']);
  });

  it('does not prune source=user or source=discovered rows when the seed profile is removed', () => {
    const db = freshDb();
    seedCatalogue(db, [
      profile('claude-code:sonnet-4.6', 'claude-code', 'claude-sonnet-4-6'),
    ]);
    // Inject a user row and a discovered row that are NOT in the JSON set.
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, source, created_at)
       VALUES ('claude-code:user-custom', 'claude-code', 'user-custom', 'UC', NULL, 0, 0, 1, '', 'user', @now),
              ('claude-code:discovered-x', 'claude-code', 'discovered-x', 'DX', NULL, 0, 0, 1, '', 'discovered', @now)`
    ).run({ now: Date.now() });

    // Re-seed with the same single profile; both non-seed rows must survive.
    seedCatalogue(db, [
      profile('claude-code:sonnet-4.6', 'claude-code', 'claude-sonnet-4-6'),
    ]);
    const rows = db.prepare(
      "SELECT model_name, source FROM agent_models WHERE agent_id='claude-code' ORDER BY model_name"
    ).all() as { model_name: string; source: string }[];
    expect(rows.map((r) => r.model_name)).toEqual(['claude-sonnet-4-6', 'discovered-x', 'user-custom']);
    const uc = rows.find((r) => r.model_name === 'user-custom')!;
    expect(uc.source).toBe('user');
    const dx = rows.find((r) => r.model_name === 'discovered-x')!;
    expect(dx.source).toBe('discovered');
  });

  it('preserves an operator-disabled seed model across re-seed (JSON enabled only applies on insert)', () => {
    const db = freshDb();
    const p = profile('claude-code:sonnet-4.6', 'claude-code', 'claude-sonnet-4-6', { enabled: true });
    seedCatalogue(db, [p]);
    const read = () => (db.prepare(
      "SELECT enabled_flag FROM agent_models WHERE agent_id='claude-code' AND model_name='claude-sonnet-4-6'"
    ).get() as { enabled_flag: number }).enabled_flag;
    expect(read()).toBe(1);

    db.prepare("UPDATE agent_models SET enabled_flag=0 WHERE id='claude-code:sonnet-4.6'").run();
    seedCatalogue(db, [p]);
    expect(read()).toBe(0);
  });

  it('refuses to prune when the profile set is empty (defensive against wiped JSON)', () => {
    const db = freshDb();
    seedCatalogue(db, [
      profile('claude-code:sonnet-4.6', 'claude-code', 'claude-sonnet-4-6'),
    ]);
    expect(() => seedCatalogue(db, [])).toThrow(/empty profiles array/);
    // Original seed row must still be present.
    const n = (db.prepare("SELECT COUNT(*) c FROM agent_models WHERE agent_id='claude-code'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('re-applies manual vision/steer overrides after the seed refresh (FW-4)', () => {
    const db = freshDb();
    // Boot 1: hermes profile seeded with vision=false steer=false.
    seedCatalogue(db, [
      profile('hermes:zai:glm-5.2', 'hermes', 'zai:glm-5.2', { vision: false, steer: false }),
    ]);
    // Operator flips both flags via the catalogue edit UI (updateModel records
    // a persistent override — hermes listModels() returns [], so discovery can
    // NEVER re-heal this row; boot seeding is the only writer left).
    updateModel(db, 'hermes:zai:glm-5.2', { vision: true, steer: true });
    // Boot 2: JSON still says vision=false steer=false — the manual override
    // must win, not the seed refresh.
    seedCatalogue(db, [
      profile('hermes:zai:glm-5.2', 'hermes', 'zai:glm-5.2', { vision: false, steer: false }),
    ]);
    const row = db.prepare(
      "SELECT vision_flag v, steer_flag s FROM agent_models WHERE agent_id='hermes' AND model_name='zai:glm-5.2'"
    ).get() as { v: number; s: number };
    expect(row.v).toBe(1);
    expect(row.s).toBe(1);
    // A flag with NO recorded override still follows the seed JSON (here:
    // re-seed with steer=true in JSON but no steer override recorded).
    db.prepare('DELETE FROM agent_model_overrides').run();
    seedCatalogue(db, [
      profile('hermes:zai:glm-5.2', 'hermes', 'zai:glm-5.2', { vision: false, steer: true }),
    ]);
    const row2 = db.prepare(
      "SELECT vision_flag v, steer_flag s FROM agent_models WHERE agent_id='hermes' AND model_name='zai:glm-5.2'"
    ).get() as { v: number; s: number };
    expect(row2.v).toBe(0); // no override → JSON wins
    expect(row2.s).toBe(1); // no override → JSON wins
  });

  it('persists contextWindow onto the seeded row (GLM-5.2 advertises 1M)', () => {
    const db = freshDb();
    seedCatalogue(db, [
      profile('hermes:GLM-5.2', 'hermes', 'GLM-5.2', { contextWindow: 1_000_000 }),
    ]);
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='hermes' AND model_name='GLM-5.2'"
    ).get() as { w: number | null };
    expect(row.w).toBe(1_000_000);
  });

  it('leaves context_window NULL when the profile advertises no window', () => {
    const db = freshDb();
    seedCatalogue(db, [profile('pi:ollama/qwen', 'pi', 'ollama/qwen')]);
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { w: number | null };
    expect(row.w).toBeNull();
  });

  it('refreshes a changed contextWindow on re-seed, and preserves the last known one when the JSON drops it (FW-7 D3)', () => {
    const db = freshDb();
    // Boot 1: JSON says 200k.
    seedCatalogue(db, [
      profile('hermes:GLM-5.2', 'hermes', 'GLM-5.2', { contextWindow: 200_000 }),
    ]);
    // Boot 2: JSON corrected to 1M — the new number must win.
    seedCatalogue(db, [
      profile('hermes:GLM-5.2', 'hermes', 'GLM-5.2', { contextWindow: 1_000_000 }),
    ]);
    const refreshed = db.prepare(
      "SELECT context_window w FROM agent_models WHERE id='hermes:GLM-5.2'"
    ).get() as { w: number | null };
    expect(refreshed.w).toBe(1_000_000);

    // Boot 3: JSON omits the field entirely — COALESCE preserves 1M rather than
    // regressing a known window to "unknown".
    seedCatalogue(db, [
      profile('hermes:GLM-5.2', 'hermes', 'GLM-5.2'),
    ]);
    const preserved = db.prepare(
      "SELECT context_window w FROM agent_models WHERE id='hermes:GLM-5.2'"
    ).get() as { w: number | null };
    expect(preserved.w).toBe(1_000_000);
  });

  it('never stores a non-positive contextWindow as a fake window', () => {
    const db = freshDb();
    seedCatalogue(db, [
      profile('pi:weird', 'pi', 'weird', { contextWindow: 0 }),
    ]);
    const row = db.prepare("SELECT context_window w FROM agent_models WHERE id='pi:weird'")
      .get() as { w: number | null };
    expect(row.w).toBeNull();
  });

  it('seedCatalogue inserts new agents disabled', () => {
    const db = freshDb();
    seedCatalogue(db);
    const on = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE enabled_flag = 1')
      .get() as { n: number };
    expect(on.n).toBe(0);
  });

  it('seedCatalogue preserves an operator-enabled agent across re-seed', () => {
    const db = freshDb();
    seedCatalogue(db);
    db.prepare("UPDATE agents SET enabled_flag=1 WHERE id='claude-code'").run();
    seedCatalogue(db);
    const claude = db.prepare("SELECT enabled_flag FROM agents WHERE id='claude-code'")
      .get() as { enabled_flag: number };
    const other = db.prepare("SELECT enabled_flag FROM agents WHERE id='codex'")
      .get() as { enabled_flag: number };
    expect(claude.enabled_flag).toBe(1);
    expect(other.enabled_flag).toBe(0);
  });

  it('seedCatalogue does not change agent_models.enabled_flag semantics', () => {
    const db = freshDb();
    seedCatalogue(db);
    const on = db.prepare('SELECT COUNT(*) AS n FROM agent_models WHERE enabled_flag = 1')
      .get() as { n: number };
    expect(on.n).toBeGreaterThan(0);
  });

  it('enableAllAgents flips every stored agent on', () => {
    const db = freshDb();
    seedCatalogue(db);
    enableAllAgents(db);
    const off = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE enabled_flag = 0')
      .get() as { n: number };
    expect(off.n).toBe(0);
  });
});

describe('seedDefaultSettings', () => {
  it('writes default compaction settings once', () => {
    const db = freshDb();
    seedCatalogue(db);
    seedDefaultSettings(db);
    const row = db.prepare("SELECT value FROM settings WHERE key='compaction'").get() as { value: string };
    const settings = JSON.parse(row.value);
    expect(settings.outputTokenCap).toBe(4000);
    expect(settings.preferredProfileId).toBe('claude-code:sonnet-4.6');
    // New handoff/transcript defaults.
    expect(settings.compactionEnabled).toBe(true);
    expect(settings.handoffMode).toBe('summary');
    expect(settings.maxTranscriptHandoffTokens).toBe(150_000);
    expect(settings.transcriptContextSafetyFactor).toBe(0.5);
  });

  it('seed default spawnApprovalRequired is false', () => {
    const db = freshDb();
    seedDefaultSettings(db);
    // getCompactionSettings returns defaults merged with stored value.
    const row = db.prepare("SELECT value FROM settings WHERE key='compaction'").get() as { value: string };
    // The seeded value includes spawnApprovalRequired: false.
    const settings = JSON.parse(row.value) as { spawnApprovalRequired?: boolean };
    expect(settings.spawnApprovalRequired).toBe(false);
  });
});

describe('ensureRemoteAgentsProject', () => {
  it('inserts the system project once and is unchanged after a second call', () => {
    const db = freshDb();
    const first = ensureRemoteAgentsProject(db);
    expect(first).toBe(REMOTE_AGENTS_PROJECT_ID);
    const row = db.prepare('SELECT id, name, system FROM projects WHERE id = ?')
      .get(REMOTE_AGENTS_PROJECT_ID) as { id: string; name: string; system: number };
    expect(row.name).toBe('Grok Bots');
    expect(row.system).toBe(1);

    const createdAt = (db.prepare('SELECT created_at FROM projects WHERE id = ?')
      .get(REMOTE_AGENTS_PROJECT_ID) as { created_at: number }).created_at;
    ensureRemoteAgentsProject(db);
    const after = db.prepare('SELECT id, name, system, created_at FROM projects WHERE system = 1')
      .all() as { id: string; name: string; system: number; created_at: number }[];
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(REMOTE_AGENTS_PROJECT_ID);
    expect(after[0]?.name).toBe('Grok Bots');
    expect(after[0]?.system).toBe(1);
    expect(after[0]?.created_at).toBe(createdAt);
  });
});
