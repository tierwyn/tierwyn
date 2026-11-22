import type { Database } from 'better-sqlite3';
import type { AgentAdapter } from '@tierwyn/shared';
import { ensureAgent, upsertDiscoveredModels } from './repositories/models.js';
import { upsertDiscoveredCommands } from './repositories/commands.js';
import { refreshAgentVersions } from './versions.js';

export const DISCOVERY_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const DISCOVERY_ADAPTER_TIMEOUT_MS = 30_000; // 30s per adapter

export interface DiscoverableAgent {
  label: string;
  create: () => AgentAdapter;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runModelDiscovery(
  db: Database,
  agents: Record<string, DiscoverableAgent>,
  timeoutMs = DISCOVERY_ADAPTER_TIMEOUT_MS,
): Promise<void> {
  await Promise.allSettled(
    Object.entries(agents).map(async ([agentId, def]) => {
      try {
        const models = await withTimeout(def.create().listModels(), timeoutMs, agentId);
        if (models.length === 0) return;
        ensureAgent(db, { id: agentId, label: def.label });
        upsertDiscoveredModels(db, agentId, models);
        console.log(`[Tierwyn] discovered ${models.length} models for "${agentId}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Tierwyn] model discovery skipped for "${agentId}": ${msg}`);
      }
    }),
  );
}

export async function runCommandDiscovery(
  db: Database,
  agents: Record<string, DiscoverableAgent>,
  timeoutMs = DISCOVERY_ADAPTER_TIMEOUT_MS,
): Promise<void> {
  await Promise.allSettled(
    Object.entries(agents).map(async ([agentId, def]) => {
      try {
        const adapter = def.create();
        if (!adapter.listCommands) return;
        const commands = await withTimeout(adapter.listCommands(), timeoutMs, agentId);
        if (commands.length === 0) return;
        ensureAgent(db, { id: agentId, label: def.label });
        upsertDiscoveredCommands(db, agentId, commands);
        console.log(`[Tierwyn] discovered ${commands.length} commands for "${agentId}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Tierwyn] command discovery skipped for "${agentId}": ${msg}`);
      }
    }),
  );
}

export async function runVersionDiscovery(
  db: Database,
  opts?: Parameters<typeof refreshAgentVersions>[1],
): Promise<void> {
  try {
    await refreshAgentVersions(db, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Tierwyn] version discovery failed: ${msg}`);
  }
}

export function startModelDiscoveryScheduler(
  db: Database,
  agents: Record<string, DiscoverableAgent>,
  onRefreshed?: () => void,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await runModelDiscovery(db, agents);
    await runCommandDiscovery(db, agents);
    await runVersionDiscovery(db);
    onRefreshed?.();
  };
  void tick(); // run once at boot
  const handle = setInterval(() => void tick(), DISCOVERY_INTERVAL_MS);
  return () => { stopped = true; clearInterval(handle); };
}
