import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { ensureAgent, upsertDiscoveredModels, createModel, updateModel, withAgentLabelPrefix } from './models.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('models repo', () => {
  it('withAgentLabelPrefix prefixes bare labels and is idempotent', () => {
    expect(withAgentLabelPrefix('Claude Code', 'Opus 5')).toBe('Claude Code · Opus 5');
    expect(withAgentLabelPrefix('Claude Code', 'Claude Code · Opus 5')).toBe('Claude Code · Opus 5');
    expect(withAgentLabelPrefix('claude-code', '  Sonnet 5  ')).toBe('claude-code · Sonnet 5');
  });

  it('createModel prefixes the agent label onto bare labels', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    const created = createModel(db, 'claude-code', {
      modelName: 'claude-opus-5',
      label: 'Opus 5',
      enabled: true,
    });
    expect(created.label).toBe('Claude Code · Opus 5');
    // Already-prefixed labels are left alone (no double prefix)
    const again = createModel(db, 'claude-code', {
      modelName: 'claude-sonnet-5',
      label: 'Claude Code · Sonnet 5',
      enabled: true,
    });
    expect(again.label).toBe('Claude Code · Sonnet 5');
  });

  it('ensureAgent inserts once and is idempotent', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    const n = (db.prepare("SELECT COUNT(*) c FROM agents WHERE id='pi'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('inserts new models and updates labels on re-run without duplicating', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: true }]);
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen 2.5 Coder', provider: 'ollama', vision: false, steer: true }]);
    const rows = db.prepare("SELECT model_name, label FROM agent_models WHERE agent_id='pi'").all() as { model_name: string; label: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Qwen 2.5 Coder');
  });

  it('preserves enabled_flag across re-discovery but refreshes vision/steer from descriptor', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    // Initial insert: vision=false, steer=false (from descriptor)
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false }]);
    // Simulate user disabling the row in the DB (the only user-controlled flag)
    db.prepare("UPDATE agent_models SET enabled_flag=0 WHERE agent_id='pi' AND model_name='ollama/qwen'").run();
    // Re-discovery with a descriptor that now reports vision=true and steer=true —
    // the metadata correction MUST propagate, but enabled_flag is user-controlled
    // and must be preserved.
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: true, steer: true }]);
    const row = db.prepare(
      "SELECT enabled_flag e, vision_flag v, steer_flag s FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { e: number; v: number; s: number };
    expect(row.e).toBe(0);  // user-disabled must be preserved
    expect(row.v).toBe(1);  // descriptor-driven vision_flag refreshed
    expect(row.s).toBe(1);  // descriptor-driven steer_flag refreshed
  });

  it('a disabled model dropped from one listing does not come back enabled', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    const qwen = { name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false };
    const other = { name: 'ollama/llama', label: 'Llama', provider: 'ollama', vision: false, steer: false };
    upsertDiscoveredModels(db, 'pi', [qwen, other]);
    db.prepare("UPDATE agent_models SET enabled_flag=0 WHERE model_name='ollama/qwen'").run();
    upsertDiscoveredModels(db, 'pi', [other]);        // partial listing omits qwen
    upsertDiscoveredModels(db, 'pi', [qwen, other]);  // qwen re-listed
    const e = (db.prepare("SELECT enabled_flag e FROM agent_models WHERE model_name='ollama/qwen'").get() as { e: number }).e;
    expect(e).toBe(0);
  });

  // ── FW-4: manual metadata overrides survive discovery ─────────────────────

  it('re-applies a manual vision/steer override after a discovery upsert reverts it', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    // Discovery reports vision=false steer=true (e.g. wrong vision detection)
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: true }]);
    // Operator flips vision ON via the catalogue edit UI (PATCH /models/:id)
    const updated = updateModel(db, 'pi:ollama/qwen', { vision: true });
    expect(updated?.vision).toBe(true);
    expect(updated?.steer).toBe(true); // untouched by the patch
    // Next discovery tick still reports vision=false — the manual override
    // must win, not the descriptor.
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false }]);
    const row = db.prepare(
      "SELECT vision_flag v, steer_flag s FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { v: number; s: number };
    expect(row.v).toBe(1);  // override preserved across discovery
    expect(row.s).toBe(0);  // steer was NOT overridden → descriptor refresh wins
  });

  it('records only the explicitly-patched flag as an override (partial patch)', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false }]);
    updateModel(db, 'pi:ollama/qwen', { steer: true }); // vision untouched
    const o = db.prepare(
      "SELECT vision_override, steer_override FROM agent_model_overrides WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { vision_override: number | null; steer_override: number | null };
    expect(o.vision_override).toBeNull();  // no manual vision write recorded
    expect(o.steer_override).toBe(1);
  });

  it('does not record an override when the patch touches neither vision nor steer', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: true, steer: true }]);
    updateModel(db, 'pi:ollama/qwen', { label: 'Qwen 2.5', enabled: false });
    const n = (db.prepare("SELECT COUNT(*) c FROM agent_model_overrides").get() as { c: number }).c;
    expect(n).toBe(0);
    // and the descriptor still drives the flags on re-discovery
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen 2.5', provider: 'ollama', vision: false, steer: false }]);
    const row = db.prepare(
      "SELECT vision_flag v, steer_flag s FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { v: number; s: number };
    expect(row.v).toBe(0);
    expect(row.s).toBe(0);
  });

  it('an override keyed to the old name does not leak onto a renamed model row', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false }]);
    updateModel(db, 'pi:ollama/qwen', { vision: true });
    // Discovery later lists a DIFFERENT model; the override row for
    // ollama/qwen exists but must not apply to unrelated rows.
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/gemma', label: 'Gemma', provider: 'ollama', vision: false, steer: false }]);
    const gemma = db.prepare(
      "SELECT vision_flag v FROM agent_models WHERE agent_id='pi' AND model_name='ollama/gemma'"
    ).get() as { v: number };
    expect(gemma.v).toBe(0);
  });

  it('override survives prune + re-discovery of the same model_name', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false }]);
    updateModel(db, 'pi:ollama/qwen', { vision: true });
    // Adapter drops the model (row pruned), then re-lists it later — the
    // override is keyed by (agent_id, model_name), not the row PK, so it
    // re-asserts itself on the fresh row.
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/gemma', label: 'Gemma', provider: 'ollama', vision: false, steer: false }]);
    let qwen = db.prepare(
      "SELECT COUNT(*) c FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { c: number };
    expect(qwen.c).toBe(0);
    upsertDiscoveredModels(db, 'pi', [
      { name: 'ollama/gemma', label: 'Gemma', provider: 'ollama', vision: false, steer: false },
      { name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false },
    ]);
    qwen = db.prepare(
      "SELECT vision_flag v FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { v: number };
    expect(qwen.v).toBe(1);
  });

  it('updateModel rename carries the override to the new model_name', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [{ name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false }]);
    updateModel(db, 'pi:ollama/qwen', { vision: true, modelName: 'ollama/qwen3' });
    const o = db.prepare(
      "SELECT vision_override FROM agent_model_overrides WHERE agent_id='pi' AND model_name='ollama/qwen3'"
    ).get() as { vision_override: number | null };
    expect(o.vision_override).toBe(1);
  });

  it('prunes stale discovered rows when listModels output shrinks', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [
      { name: 'lmstudio/gemma', label: 'Gemma', provider: 'lmstudio', vision: false, steer: false },
      { name: 'lmstudio/qwen', label: 'Qwen', provider: 'lmstudio', vision: false, steer: false },
      { name: 'openai/gpt-4', label: 'GPT-4', provider: 'openai', vision: false, steer: false },
    ]);
    // Next discovery cycle: adapter drops openai/* from its output
    upsertDiscoveredModels(db, 'pi', [
      { name: 'lmstudio/gemma', label: 'Gemma', provider: 'lmstudio', vision: false, steer: false },
      { name: 'lmstudio/qwen', label: 'Qwen', provider: 'lmstudio', vision: false, steer: false },
    ]);
    const rows = db.prepare("SELECT model_name, source FROM agent_models WHERE agent_id='pi' ORDER BY model_name").all() as { model_name: string; source: string }[];
    expect(rows.map((r) => r.model_name)).toEqual(['lmstudio/gemma', 'lmstudio/qwen']);
    expect(rows.every((r) => r.source === 'discovered')).toBe(true);
  });

  it('never prunes user-created or seeded rows', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    // Seed two rows: one discovered, one user-created via Phase 5 CRUD
    upsertDiscoveredModels(db, 'pi', [
      { name: 'lmstudio/gemma', label: 'Gemma', provider: 'lmstudio', vision: false, steer: false },
    ]);
    createModel(db, 'pi', {
      modelName: 'custom/my-model',
      label: 'My Custom',
      provider: 'custom',
      vision: false,
      steer: false,
      enabled: true,
    });
    // Discovery cycle that drops the original discovered row but reports a
    // different one. The discovered 'lmstudio/gemma' must be pruned; the
    // user-created 'custom/my-model' must survive.
    upsertDiscoveredModels(db, 'pi', [
      { name: 'lmstudio/qwen', label: 'Qwen', provider: 'lmstudio', vision: false, steer: false },
    ]);
    const rows = db.prepare("SELECT model_name, source FROM agent_models WHERE agent_id='pi' ORDER BY model_name").all() as { model_name: string; source: string }[];
    // The original discovered gemma is gone (pruned), the user-created custom model survives
    expect(rows.map((r) => r.model_name)).toEqual(['custom/my-model', 'lmstudio/qwen']);
    const custom = rows.find((r) => r.model_name === 'custom/my-model')!;
    expect(custom.source).toBe('user');
  });

  it('does not wipe the catalogue when called with an empty descriptor list', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [
      { name: 'lmstudio/gemma', label: 'Gemma', provider: 'lmstudio', vision: false, steer: false },
    ]);
    upsertDiscoveredModels(db, 'pi', []);
    const n = (db.prepare("SELECT COUNT(*) c FROM agent_models WHERE agent_id='pi'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('still upserts new models when a stale discovered row is FK-referenced by a session', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'antigravity', label: 'Antigravity' });
    upsertDiscoveredModels(db, 'antigravity', [
      { name: 'Gemini 3.5 Flash (Medium)', label: 'Legacy', provider: 'antigravity', vision: true, steer: false },
    ]);
    // Create a project + conversation + session that pins the legacy model id
    // (the FK that previously aborted the whole discovery transaction).
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'P', '/tmp', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
       VALUES ('c1', 'p1', 't', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, agent_model_id, created_at, updated_at)
       VALUES ('s1', 'c1', 'antigravity', 'antigravity:Gemini 3.5 Flash (Medium)', ?, ?)`,
    ).run(now, now);

    // Rename cycle: legacy display name gone, slug id appears.
    expect(() =>
      upsertDiscoveredModels(db, 'antigravity', [
        { name: 'gemini-3.5-flash-medium', label: 'Slug', provider: 'antigravity', vision: true, steer: false },
      ]),
    ).not.toThrow();

    const rows = db.prepare(
      "SELECT model_name, enabled_flag FROM agent_models WHERE agent_id='antigravity' ORDER BY model_name",
    ).all() as { model_name: string; enabled_flag: number }[];
    expect(rows.map((r) => r.model_name)).toEqual([
      'Gemini 3.5 Flash (Medium)', // kept (FK-referenced), but disabled
      'gemini-3.5-flash-medium',
    ]);
    const legacy = rows.find((r) => r.model_name === 'Gemini 3.5 Flash (Medium)')!;
    const slug = rows.find((r) => r.model_name === 'gemini-3.5-flash-medium')!;
    expect(legacy.enabled_flag).toBe(0);
    expect(slug.enabled_flag).toBe(1);
  });

  // ── FW-7: descriptor context windows are persisted ────────────────────────

  it('persists descriptor.contextWindow on insert', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'hermes', label: 'Hermes' });
    upsertDiscoveredModels(db, 'hermes', [
      { name: 'GLM-5.2', label: 'GLM 5.2', provider: 'zai', vision: false, steer: false, contextWindow: 1_000_000 },
    ]);
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='hermes' AND model_name='GLM-5.2'"
    ).get() as { w: number | null };
    expect(row.w).toBe(1_000_000);
  });

  it('leaves context_window NULL when the descriptor omits it', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [
      { name: 'ollama/qwen', label: 'Qwen', provider: 'ollama', vision: false, steer: false },
    ]);
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='pi' AND model_name='ollama/qwen'"
    ).get() as { w: number | null };
    expect(row.w).toBeNull();
  });

  it('refreshes context_window when re-discovery reports a new value', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'hermes', label: 'Hermes' });
    upsertDiscoveredModels(db, 'hermes', [
      { name: 'GLM-5.2', label: 'GLM 5.2', provider: 'zai', vision: false, steer: false, contextWindow: 200_000 },
    ]);
    upsertDiscoveredModels(db, 'hermes', [
      { name: 'GLM-5.2', label: 'GLM 5.2', provider: 'zai', vision: false, steer: false, contextWindow: 1_000_000 },
    ]);
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='hermes' AND model_name='GLM-5.2'"
    ).get() as { w: number | null };
    expect(row.w).toBe(1_000_000);
  });

  it('preserves a known context_window when a later descriptor omits it (FW-7 D3)', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'hermes', label: 'Hermes' });
    upsertDiscoveredModels(db, 'hermes', [
      { name: 'GLM-5.2', label: 'GLM 5.2', provider: 'zai', vision: false, steer: false, contextWindow: 1_000_000 },
    ]);
    // Thinner descriptor (adapter upgrade / partial CLI output): must not wipe.
    upsertDiscoveredModels(db, 'hermes', [
      { name: 'GLM-5.2', label: 'GLM 5.2', provider: 'zai', vision: false, steer: false },
    ]);
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='hermes' AND model_name='GLM-5.2'"
    ).get() as { w: number | null };
    expect(row.w).toBe(1_000_000);
  });

  it('never stores a non-positive descriptor contextWindow', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'pi', label: 'Pi' });
    upsertDiscoveredModels(db, 'pi', [
      { name: 'weird', label: 'Weird', provider: 'ollama', vision: false, steer: false, contextWindow: 0 },
    ]);
    const row = db.prepare("SELECT context_window w FROM agent_models WHERE id='pi:weird'")
      .get() as { w: number | null };
    expect(row.w).toBeNull();
  });

  it('empty descriptor list is a no-op and cannot wipe a stored window', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'hermes', label: 'Hermes' });
    upsertDiscoveredModels(db, 'hermes', [
      { name: 'GLM-5.2', label: 'GLM 5.2', provider: 'zai', vision: false, steer: false, contextWindow: 1_000_000 },
    ]);
    upsertDiscoveredModels(db, 'hermes', []);   // transient CLI failure
    const row = db.prepare(
      "SELECT context_window w FROM agent_models WHERE agent_id='hermes' AND model_name='GLM-5.2'"
    ).get() as { w: number | null };
    expect(row.w).toBe(1_000_000);
  });

  it('upsertDiscoveredModels survives a derived id held by a different model_name', () => {
    const db = freshDb();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, vision_flag, steer_flag, enabled_flag, description, source, created_at)
       VALUES ('claude-code:claude-opus-5','claude-code','claude-sonnet-5-5','Sonnet 5.5',0,1,1,'','user',0)`,
    ).run();
    const pull = () => upsertDiscoveredModels(db, 'claude-code', [
      { name: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { name: 'claude-opus-5', label: 'Opus 5' },
    ]);
    pull();
    pull(); // idempotent: second pull reuses the allocated ids
    const rows = db.prepare("SELECT id, model_name FROM agent_models WHERE agent_id='claude-code' ORDER BY model_name").all();
    expect(rows).toEqual([
      { id: 'claude-code:claude-opus-5~2', model_name: 'claude-opus-5' },
      { id: 'claude-code:claude-opus-5', model_name: 'claude-sonnet-5-5' },
    ]);
  });
});
