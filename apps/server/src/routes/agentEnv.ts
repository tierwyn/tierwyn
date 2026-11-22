import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Database } from 'better-sqlite3';
import { AGENT_BINARIES } from '../discovery.js';
import { AGENT_ENV_NAME_RE, isDeniedAgentEnvName, isValidAgentEnvName } from '../childEnv.js';
import { MIN_SECRET_LEN } from '../plugins/host.js';
import { vaultAvailable, vaultClear, vaultSet, vaultStatus, vaultUnavailableReason } from '../plugins/vault.js';
import { AGENT_VAULT_ID, refreshMcpRedactSet } from '../secrets/mcpRedact.js';
import { agentEnvVaultKey, listAgentEnvVars } from '../secrets/agentEnv.js';

const MAX_SECRET_LEN = 8192;

export interface AgentEnvRouteDeps {
  getDb: () => Database;
  sessionManager?: {
    reapParkedSessionsByAgent(agentType: string): Promise<void>;
  };
  /** Fan the new env out to remote-host nodes (best-effort; failures are logged only). */
  syncRemoteHosts?: () => Promise<void>;
}

function knownAgentType(agentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_BINARIES, agentType);
}

function parseName(name: string): { ok: true } | { ok: false; error: string } {
  if (!AGENT_ENV_NAME_RE.test(name)) {
    return { ok: false, error: 'name must match ^[A-Z_][A-Z0-9_]{0,127}$' };
  }
  if (isDeniedAgentEnvName(name) || !isValidAgentEnvName(name)) {
    return { ok: false, error: `name '${name}' is reserved` };
  }
  return { ok: true };
}

async function afterMutation(db: Database, deps: AgentEnvRouteDeps, agentType: string): Promise<void> {
  refreshMcpRedactSet(db);
  try {
    await deps.syncRemoteHosts?.();
  } catch (e) {
    console.warn('[agent-env] remote-host sync failed: %s', e instanceof Error ? e.message : String(e));
  }
  await deps.sessionManager?.reapParkedSessionsByAgent(agentType);
}

export function registerAgentEnvRoutes(app: Express, deps: AgentEnvRouteDeps): void {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));

  r.get('/agent-env', (_req, res) => {
    const available = vaultAvailable();
    res.json({
      vaultAvailable: available,
      ...(available ? {} : { vaultUnavailableReason: vaultUnavailableReason() }),
      vars: listAgentEnvVars(deps.getDb()),
    });
  });

  r.put('/agent-env/:agentType/:name', async (req: Request, res: Response) => {
    try {
      const agentType = String(req.params.agentType ?? '');
      const name = String(req.params.name ?? '');
      if (!knownAgentType(agentType)) {
        res.status(400).json({ error: `unknown agentType '${agentType}'` });
        return;
      }
      const parsed = parseName(name);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
      if (value.length < MIN_SECRET_LEN || value.length > MAX_SECRET_LEN) {
        res.status(400).json({ error: `value must be ${MIN_SECRET_LEN}–${MAX_SECRET_LEN} characters` });
        return;
      }
      if (!vaultAvailable()) {
        res.status(503).json({ error: vaultUnavailableReason() });
        return;
      }
      const db = deps.getDb();
      const key = agentEnvVaultKey(agentType, name);
      vaultSet(db, AGENT_VAULT_ID, key, value);
      await afterMutation(db, deps, agentType);
      res.json({
        agentType,
        name,
        updatedAt: vaultStatus(db, AGENT_VAULT_ID, key)?.updatedAt ?? null,
        vaultAvailable: true,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  r.delete('/agent-env/:agentType/:name', async (req: Request, res: Response) => {
    try {
      const agentType = String(req.params.agentType ?? '');
      const name = String(req.params.name ?? '');
      if (!knownAgentType(agentType)) {
        res.status(400).json({ error: `unknown agentType '${agentType}'` });
        return;
      }
      const parsed = parseName(name);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const db = deps.getDb();
      vaultClear(db, AGENT_VAULT_ID, agentEnvVaultKey(agentType, name));
      await afterMutation(db, deps, agentType);
      res.json({ ok: true, vaultAvailable: vaultAvailable() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use('/settings', r);
}
