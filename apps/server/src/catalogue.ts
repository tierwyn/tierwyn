import type { Database } from 'better-sqlite3';
import type { AgentProfile } from '@tierwyn/shared';

interface ModelRow {
  id: string;
  agent_id: string;
  model_name: string;
  label: string;
  provider: string | null;
  vision_flag: number;
  steer_flag: number;
  enabled_flag: number;
  agent_enabled_flag: number;
  description: string;
  context_window: number | null;
  max_concurrent_spawns: number | null;
  max_grandchild_spawns: number | null;
}

function toProfile(r: ModelRow): AgentProfile {
  return {
    id: r.id,
    agentType: r.agent_id,
    model: r.model_name,
    provider: r.provider ?? undefined,
    label: r.label,
    description: r.description,
    vision: r.vision_flag === 1,
    steer: r.steer_flag === 1,
    // Agent-level switch folded into the model-level one. Every downstream gate
    // (sessionManager, spawn, schedules, GET /profiles) already checks
    // profile.enabled, so a disabled agent fails closed everywhere for free.
    enabled: r.enabled_flag === 1 && r.agent_enabled_flag === 1,
    contextWindow: r.context_window ?? undefined,
    maxConcurrentSpawns: r.max_concurrent_spawns ?? undefined,
    maxGrandchildSpawns: r.max_grandchild_spawns ?? undefined,
  };
}

export class ProfileCatalogue {
  private profiles = new Map<string, AgentProfile>();

  load(db: Database): void {
    const rows = db.prepare(
      `SELECT m.*, COALESCE(a.enabled_flag, 0) AS agent_enabled_flag
         FROM agent_models m
         LEFT JOIN agents a ON a.id = m.agent_id`
    ).all() as ModelRow[];
    this.profiles.clear();
    for (const r of rows) this.profiles.set(r.id, toProfile(r));
  }

  listProfiles(): AgentProfile[] {
    return [...this.profiles.values()].filter((p) => p.enabled);
  }

  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  profilesForAgent(agentType: string): AgentProfile[] {
    return this.listProfiles().filter((p) => p.agentType === agentType);
  }

  validateAgentTypes(registeredTypes: Set<string>): void {
    for (const p of this.profiles.values()) {
      if (!registeredTypes.has(p.agentType)) {
        throw new Error(
          `Profile "${p.id}" references unregistered agentType "${p.agentType}". ` +
          `Register an adapter for it in the adapter registry.`
        );
      }
    }
  }
}

export const catalogue = new ProfileCatalogue();
