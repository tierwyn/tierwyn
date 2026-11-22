import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import type {
  AgentsResponse, CatalogueResponse, AgentRecord,
  CreateAgentRequest, UpdateAgentRequest, CreateModelRequest, UpdateModelRequest,
  CreateCommandRequest, UpdateCommandRequest, CommandResponse,
  PullModelsResponse, CommandsResponse, PullCommandsResponse,
  UpgradeAgentResponse, AgentsInstallAllResponse, InstallAllMode, InstallAllSkip,
  VersionsRefreshResponse, RemoteHostLoginState,
} from '@tierwyn/shared';
import { isRemoteLoginAgent, REMOTE_LOGIN_AGENTS } from '@tierwyn/shared';
import {
  listAgents, getAgent, createAgent, updateAgent, deleteAgent, ensureAgent,
  listModels, createModel, updateModel, deleteModel, getModel,
  upsertDiscoveredModels,
} from '../repositories/models.js';
import {
  listCommandsForAgent, listAllCommandsForAgent, upsertDiscoveredCommands,
  getCommand, createCommand, updateCommand, deleteCommand, normaliseCommandName,
} from '../repositories/commands.js';
import { AGENT_BINARIES, binaryOnPath, discoverInstalledAgents, DYNAMIC_MODEL_DISCOVERY } from '../discovery.js';
import { registry } from '../registry.js';
import { remoteHostIdFor } from '../repositories/remoteHosts.js';
import { createAdapterFor } from '../node/proxyAdapter.js';
import { mergeRemoteCommands } from '../node/remoteCommands.js';
import { seedCatalogue } from '../db/seed.js';
import { buildChildEnv } from '../childEnv.js';
import { buildPrereqPrefix, withWritableNpmPrefix } from '../node/install.js';
import { loadVersionCache, refreshAgentVersions, isBehind } from '../versions.js';
import type { AgentProfile, CommandDescriptor } from '@tierwyn/shared';
import { SANDBOX_PROFILES } from '../sandbox/profiles.js';
import { bwrapAvailable } from '../sandbox/bwrap.js';
import { isClaudePasteCode } from '../node/claudeAuth.js';
import { LoginRunner } from '../node/loginRunner.js';
import { probeLogin } from '../node/loginProbe.js';
import { listAgentEnvVars } from '../secrets/agentEnv.js';

const MANUAL_AGENTS = new Set(['claude-code', 'hermes', 'codex']);

/** Max bytes of install output kept per agent (same cap the route used inline before). */
const MAX_TAIL = 4096;

/** Agent types currently undergoing a background upgrade. */
const upgrading = new Set<string>();
/** Outcome of the last finished upgrade/install command per agent type (in-memory). */
const lastResult = new Map<string, { ok: boolean; tail: string; at: number }>();
/** Sequential bulk install queue — remaining agent types, in order. Empty = idle. */
let batchRemaining: string[] = [];
let batchRunning = false;
/** true while a forced version refresh (POST /agents/versions/refresh) is in flight. */
let versionsRefreshing = false;
/** In-flight or failed hub-local interactive logins (Settings → Agents). In-memory. */
const localLogins = new Map<string, RemoteHostLoginState>();
let loginRunner: LoginRunner | undefined;

function localLoggedIn(db: Database, type: string): boolean | undefined {
  const vault = Object.fromEntries(
    listAgentEnvVars(db).filter((v) => v.agentType === type && !v.denied).map((v) => [v.name, '1']),
  );
  return probeLogin(type, homedir(), { ...process.env, ...vault });
}

function loginFields(db: Database, type: string, installed: boolean | undefined): Pick<AgentRecord, 'loggedIn' | 'login'> {
  if (!installed) return {};
  const login = localLogins.get(type);
  return {
    loggedIn: localLoggedIn(db, type),
    ...(login ? { login } : {}),
  };
}

export function disposeCatalogueLogin(): void {
  loginRunner?.dispose();
  loginRunner = undefined;
  localLogins.clear();
}

export type UpgradeRunner = (cmd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

function defaultRunner(prereqs?: readonly string[]): UpgradeRunner {
  return (cmd: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const fullCmd = `${buildPrereqPrefix(prereqs)}${withWritableNpmPrefix(cmd)}`;
      const child = spawn('/bin/sh', ['-c', fullCmd], { env: buildChildEnv(), cwd: process.cwd() });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > MAX_TAIL * 2) stdout = stdout.slice(-MAX_TAIL);
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > MAX_TAIL * 2) stderr = stderr.slice(-MAX_TAIL);
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, 10 * 60 * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: stdout.slice(-MAX_TAIL), stderr: stderr.slice(-MAX_TAIL) });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout: '', stderr: String(err) });
      });
    });
}

/**
 * Run one install/upgrade command for `type`, record the outcome (lastResult),
 * and — after a fresh install (binary was missing before) — pull the agent's
 * model list so the catalogue fills in without a manual refresh. Never throws.
 */
async function runUpgradeOnce(
  db: Database,
  reload: () => void,
  type: string,
  install: string,
  prereqs: readonly string[] | undefined,
  run: UpgradeRunner,
): Promise<void> {
  const wasInstalled = AGENT_BINARIES[type] ? binaryOnPath(AGENT_BINARIES[type]!.bin || type) : false;
  // The single-agent route pre-marks + reloads before responding; only reload again
  // when this call is the one that flips the flag (install-all loop progress).
  if (!upgrading.has(type)) {
    upgrading.add(type);
    reload();
  }
  let outcome: { code: number | null; stdout: string; stderr: string };
  try {
    outcome = await run(install);
  } catch (err) {
    outcome = { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  } finally {
    upgrading.delete(type);
  }
  const ok = outcome.code === 0;
  if (ok) console.log(`[catalogue] upgrade ${type} exit 0`);
  else console.warn(`[catalogue] upgrade ${type} failed (code ${outcome.code}):\n${outcome.stderr}`);
  const tail = ok
    ? outcome.stdout.trim().slice(-MAX_TAIL)
    : `${outcome.stdout}${outcome.stderr ? `\n${outcome.stderr}` : ''}`.trim().slice(-MAX_TAIL);
  lastResult.set(type, { ok, tail, at: Date.now() });
  if (ok && !wasInstalled && registry.has(type)) {
    try {
      const agent = listAgents(db).find((a) => a.type === type);
      if (agent) {
        // Bounded so a hung model listing cannot stall an install-all batch.
        const models = await Promise.race([
          registry.create(type).listModels(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('model discovery timed out after 60 s')), 60_000);
            t.unref?.();
          }),
        ]);
        upsertDiscoveredModels(db, agent.id, models);
      }
    } catch (err) {
      console.warn(`[catalogue] post-install model discovery for ${type} failed:`, err);
    }
  }
  reload();
}

/**
 * Merge stored agents with live install-state from host discovery. The result is
 * the UNION of stored agents and every known-but-not-yet-stored agent type, so the
 * UI can surface "missing + install hint" for agents whose binary isn't installed
 * (and which therefore never produced a discovered model / agent row).
 */
function agentsWithInstallState(db: Database): AgentRecord[] {
  const stored = new Map(listAgents(db).map((a) => [a.type, a]));
  const versions = loadVersionCache(db);
  const out: AgentRecord[] = [];
  const seen = new Set<string>();
  for (const d of discoverInstalledAgents(db)) {
    seen.add(d.agentType);
    const a = stored.get(d.agentType);
    const supportsModelDiscovery = DYNAMIC_MODEL_DISCOVERY[d.agentType] ?? true;
    const v = versions[d.agentType];
    const result = lastResult.get(d.agentType);
    const versionProps = {
      installedVersion: v?.installed,
      latestVersion: v?.latest,
      behind: isBehind(v?.installed, v?.latest),
      upgradeable: Boolean(AGENT_BINARIES[d.agentType]?.install),
      upgrading: upgrading.has(d.agentType),
      versionCheckedAt: v?.checkedAt,
      ...(result ? { upgradeResult: result } : {}),
    };
    const login = loginFields(db, d.agentType, d.installed);
    out.push(
      a
        ? { ...a, installed: d.installed, installHint: d.installHint, supportsModelDiscovery, ...versionProps, ...login }
        : { id: d.agentType, type: d.agentType, label: d.agentType, description: '',
            executablePath: null, envVars: {}, enabled: false,
            installed: d.installed, installHint: d.installHint, supportsModelDiscovery, ...versionProps, ...login },
    );
  }
  // Any stored agent whose type discovery didn't enumerate (custom type).
  for (const a of stored.values()) {
    if (!seen.has(a.type)) {
      const v = versions[a.type];
      const result = lastResult.get(a.type);
      out.push({
        ...a,
        installed: false,
        supportsModelDiscovery: DYNAMIC_MODEL_DISCOVERY[a.type] ?? true,
        installedVersion: v?.installed,
        latestVersion: v?.latest,
        behind: isBehind(v?.installed, v?.latest),
        upgradeable: Boolean(AGENT_BINARIES[a.type]?.install),
        upgrading: upgrading.has(a.type),
        versionCheckedAt: v?.checkedAt,
        ...(result ? { upgradeResult: result } : {}),
      });
    }
  }
  return out;
}

/**
 * Catalogue management routes (Phase 5). Mirrors registerConversationMutationRoutes.
 * `reloadCatalogue` is invoked after every mutation so /profiles and the selector
 * reflect changes instantly. The registry powers on-demand model pulls for every
 * registered adapter (INV-2: adapter-only, no per-agent route code).
 */
export function registerCatalogueRoutes(
  app: Express,
  getDb: () => Database,
  reloadCatalogue: () => void,
  opts?: {
    /** Live/parked sessions — upgrade refuses while any session of the agent type is active. */
    getActiveSessions?: () => Array<{ agentType: string }>;
    /** Injectable command runner for tests. Default: /bin/sh -c with buildChildEnv(). */
    runUpgrade?: (cmd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
    /** Test seam for hub-local agent login (avoids a real CLI). */
    spawnLogin?: (argv: string[], agentType: string) => ChildProcess;
  },
): void {
  loginRunner?.dispose();
  localLogins.clear();
  loginRunner = new LoginRunner({
    spawn: opts?.spawnLogin,
    emit: (ev) => {
      if (!isRemoteLoginAgent(ev.agentType)) return;
      const cur = localLogins.get(ev.agentType);
      if (ev.phase === 'done') localLogins.delete(ev.agentType);
      else if (ev.phase === 'error') {
        if (cur?.running) {
          localLogins.set(ev.agentType, {
            agentType: ev.agentType,
            running: false,
            error: (ev.message ?? 'login failed').slice(0, 300),
          });
        }
      } else if (cur?.running) {
        localLogins.set(ev.agentType, {
          agentType: ev.agentType,
          running: true,
          url: ev.url,
          userCode: ev.userCode,
        });
      }
      reloadCatalogue();
    },
  });

  // ── Read ──────────────────────────────────────────────────────────────────
  const batchState = (): AgentsResponse['batch'] =>
    batchRunning ? { running: true, remaining: [...batchRemaining] } : undefined;

  app.get('/agents', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const batch = batchState();
    const body: AgentsResponse = {
      agents: agentsWithInstallState(getDb()),
      ...(batch ? { batch } : {}),
      ...(versionsRefreshing ? { versionsRefreshing: true } : {}),
      supportedSandboxAgents: Object.keys(SANDBOX_PROFILES),
      sandboxAvailable: bwrapAvailable(),
    };
    res.json(body);
  });

  app.get('/catalogue', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const db = getDb();
    const batch = batchState();
    const body: CatalogueResponse = {
      agents: agentsWithInstallState(db),
      models: listModels(db),
      ...(batch ? { batch } : {}),
      ...(versionsRefreshing ? { versionsRefreshing: true } : {}),
      supportedSandboxAgents: Object.keys(SANDBOX_PROFILES),
      sandboxAvailable: bwrapAvailable(),
    };
    res.json(body);
  });

  // ── Agent CRUD ────────────────────────────────────────────────────────────
  app.post('/agents', (req, res) => {
    const body = req.body as CreateAgentRequest;
    if (!body.type || !body.label) { res.status(400).json({ error: 'type and label required' }); return; }
    if (!registry.has(body.type)) {
      res.status(400).json({ error: `no adapter registered for type "${body.type}"` });
      return;
    }
    const id = body.id ?? body.type;
    if (getAgent(getDb(), id)) { res.status(409).json({ error: `agent "${id}" already exists` }); return; }
    const agent = createAgent(getDb(), body);
    reloadCatalogue();
    res.json({ agent });
  });

  app.patch('/agents/:id', (req, res) => {
    const db = getDb();
    const patch = req.body as UpdateAgentRequest;

    // Known-but-unstored types (pi, antigravity, kilocode, …) are rendered by the
    // catalogue UI as virtual rows with no DB row. Persist before patching so the
    // first toggle click writes somewhere instead of 404-ing.
    if (!getAgent(db, req.params.id) && registry.has(req.params.id)) {
      ensureAgent(db, { id: req.params.id, label: req.params.id });
    }

    if (!getAgent(db, req.params.id)) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }

    // Persist executablePath before the install probe so a combined PATCH
    // { executablePath, enabled: true } uses the new path, not a stale one.
    if (patch.executablePath !== undefined) {
      updateAgent(db, req.params.id, { executablePath: patch.executablePath });
    }

    if (patch.enabled === true) {
      const row = getAgent(db, req.params.id)!;
      const bin = row.executablePath?.trim() || AGENT_BINARIES[row.type]?.bin || row.type;
      if (!binaryOnPath(bin)) {
        res.status(400).json({
          error: `"${req.params.id}" is not installed — cannot enable`,
          installHint: AGENT_BINARIES[row.type]?.hint ?? `Install "${row.type}" — binary "${bin}" not found on PATH`,
        });
        return;
      }
    }

    const updated = updateAgent(db, req.params.id, patch);
    if (!updated) { res.status(404).json({ error: 'no such agent' }); return; }
    reloadCatalogue();
    res.json({ agent: updated });
  });

  app.delete('/agents/:id', (req, res) => {
    if (!deleteAgent(getDb(), req.params.id)) { res.status(404).json({ error: 'no such agent' }); return; }
    reloadCatalogue();
    res.json({ ok: true });
  });

  // ── Model CRUD ────────────────────────────────────────────────────────────
  app.post('/agents/:id/models', (req, res) => {
    const agent = getAgent(getDb(), req.params.id);
    if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
    const body = req.body as CreateModelRequest;
    if (!body.modelName || !body.label) { res.status(400).json({ error: 'modelName and label required' }); return; }
    const model = createModel(getDb(), req.params.id, body);
    reloadCatalogue();
    res.json({ model });
  });

  app.patch('/models/:id', (req, res) => {
    const updated = updateModel(getDb(), req.params.id, req.body as UpdateModelRequest);
    if (!updated) { res.status(404).json({ error: 'no such model' }); return; }
    reloadCatalogue();
    res.json({ model: updated });
  });

  app.delete('/models/:id', (req, res) => {
    if (!getModel(getDb(), req.params.id)) { res.status(404).json({ error: 'no such model' }); return; }
    deleteModel(getDb(), req.params.id);
    reloadCatalogue();
    res.json({ ok: true });
  });

  // ── On-demand model pull (FR-26.1) ─────────────────────────────────────────
  app.post('/agents/:id/pull-models', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const db = getDb();
    const agent = getAgent(db, req.params.id);
    if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
    if (!registry.has(agent.type)) {
      res.status(400).json({ error: `no adapter registered for type "${agent.type}"` });
      return;
    }
    try {
      const models = await registry.create(agent.type).listModels();
      upsertDiscoveredModels(db, agent.id, models);
      reloadCatalogue();
      const body: PullModelsResponse = { models };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `model pull failed: ${message}` });
    }
  });

  // ── Commands catalogue ─────────────────────────────────────────────────────
  app.get('/agents/:id/commands', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    try {
      const db = getDb();
      const agent = getAgent(db, req.params.id);
      if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
      const all = req.query.includeDisabled === '1' || req.query.includeDisabled === 'true';
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      // Remote-host project: ask the host's adapter; never touch the global table.
      if (!all && projectId && remoteHostIdFor(db, { projectId })) {
        let remote: CommandDescriptor[] = [];
        let hostOffline = false;
        try {
          const adapter = createAdapterFor(db, agent.type, { projectId });
          // ponytail: no per-host cache; listCommands is a cheap dir scan.
          // Missing method = hello not yet received (host down since hub boot), old node, or agent not allowed.
          if (!adapter.listCommands) throw new Error('unavailable');
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 10_000); });
          try { remote = await Promise.race([adapter.listCommands(), timeout]); } finally { clearTimeout(timer); }
        } catch {
          hostOffline = true;
        }
        const body: CommandsResponse = {
          commands: mergeRemoteCommands(listAllCommandsForAgent(db, agent.id), remote, agent.id),
          ...(hostOffline ? { hostOffline: true } : {}),
        };
        res.json(body);
        return;
      }
      const commands = all ? listAllCommandsForAgent(db, agent.id) : listCommandsForAgent(db, agent.id);
      const body: CommandsResponse = { commands };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/agents/:id/commands', (req, res) => {
    const agent = getAgent(getDb(), req.params.id);
    if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
    const body = req.body as CreateCommandRequest;
    const name = typeof body?.name === 'string' ? normaliseCommandName(body.name) : null;
    if (!name) {
      res.status(400).json({ error: 'invalid command name — use letters, digits, . _ : - and no spaces' });
      return;
    }
    try {
      const command = createCommand(getDb(), agent.id, { ...body, name });
      const out: CommandResponse = { command };
      res.json(out);
    } catch (e) {
      if ((e as Error).message === 'duplicate') {
        res.status(409).json({ error: `command "${name}" already exists for this agent` });
        return;
      }
      throw e;
    }
  });

  app.patch('/agents/:id/commands/:cmdId', (req, res) => {
    const agent = getAgent(getDb(), req.params.id);
    if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
    const existing = getCommand(getDb(), req.params.cmdId);
    if (!existing || existing.agentId !== agent.id) {
      res.status(404).json({ error: 'no such command' });
      return;
    }
    const body = (req.body ?? {}) as UpdateCommandRequest;
    let name = body.name;
    if (name !== undefined) {
      const normalised = typeof name === 'string' ? normaliseCommandName(name) : null;
      if (!normalised) {
        res.status(400).json({ error: 'invalid command name — use letters, digits, . _ : - and no spaces' });
        return;
      }
      name = normalised;
    }
    if (existing.source !== 'user' && (body.name !== undefined || body.label !== undefined || body.description !== undefined)) {
      res.status(400).json({ error: `only user commands can be renamed or re-described (source=${existing.source})` });
      return;
    }
    try {
      const command = updateCommand(getDb(), existing.id, { ...body, name });
      const out: CommandResponse = { command: command! };
      res.json(out);
    } catch (e) {
      if ((e as Error).message === 'duplicate') {
        res.status(409).json({ error: `command "${name}" already exists for this agent` });
        return;
      }
      throw e;
    }
  });

  app.delete('/agents/:id/commands/:cmdId', (req, res) => {
    const agent = getAgent(getDb(), req.params.id);
    if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
    const existing = getCommand(getDb(), req.params.cmdId);
    if (!existing || existing.agentId !== agent.id) {
      res.status(404).json({ error: 'no such command' });
      return;
    }
    if (existing.source !== 'user') {
      res.status(400).json({ error: `cannot delete a ${existing.source} command — disable it instead` });
      return;
    }
    deleteCommand(getDb(), existing.id);
    res.json({ ok: true });
  });

  app.post('/agents/:id/pull-commands', async (req, res) => {
    const db = getDb();
    const agent = getAgent(db, req.params.id);
    if (!agent) { res.status(404).json({ error: 'no such agent' }); return; }
    if (!registry.has(agent.type)) {
      res.status(400).json({ error: `no adapter registered for type "${agent.type}"` });
      return;
    }
    const adapter = registry.create(agent.type);
    if (!adapter.listCommands) {
      res.status(400).json({ error: `adapter "${agent.type}" does not support command discovery` });
      return;
    }
    try {
      const commands = await adapter.listCommands();
      upsertDiscoveredCommands(db, agent.id, commands);
      const body: PullCommandsResponse = { commands };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `command pull failed: ${message}` });
    }
  });

  const loginAgentList = (): string => Object.keys(REMOTE_LOGIN_AGENTS).join(', ');

  app.post('/agents/:type/login', (req, res) => {
    const agentType = req.params.type;
    if (!isRemoteLoginAgent(agentType)) {
      res.status(400).json({ error: `login is only implemented for ${loginAgentList()}` });
      return;
    }
    const bin = AGENT_BINARIES[agentType]?.bin;
    if (!bin || !binaryOnPath(bin)) {
      res.status(400).json({ error: `${agentType} is not installed` });
      return;
    }
    const loggedIn = localLoggedIn(getDb(), agentType);
    if (agentType === 'claude-code' && loggedIn !== false) {
      res.status(409).json({ error: 'already logged in' });
      return;
    }
    if (agentType !== 'codex' && agentType !== 'claude-code' && loggedIn === true) {
      res.status(409).json({ error: 'already logged in' });
      return;
    }
    for (const [t, s] of localLogins) {
      if (t !== agentType && s.running) {
        res.status(409).json({ error: 'another login is running' });
        return;
      }
    }
    localLogins.set(agentType, { agentType, running: true });
    reloadCatalogue();
    res.status(202).json({ ok: true, started: true });
    try {
      loginRunner!.start(agentType);
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      localLogins.set(agentType, { agentType, running: false, error: message });
      reloadCatalogue();
    }
  });

  app.post('/agents/:type/login/cancel', (req, res) => {
    const agentType = req.params.type;
    if (!isRemoteLoginAgent(agentType)) {
      res.status(400).json({ error: `login is only implemented for ${loginAgentList()}` });
      return;
    }
    localLogins.delete(agentType);
    loginRunner?.cancel(agentType);
    reloadCatalogue();
    res.json({ ok: true, cancelled: true });
  });

  app.post('/agents/:type/login/code', (req, res) => {
    const agentType = req.params.type;
    if (agentType !== 'claude-code') {
      res.status(400).json({ error: 'sign-in code is only implemented for claude-code' });
      return;
    }
    const raw = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof raw !== 'string' || !isClaudePasteCode(raw.trim())) {
      res.status(400).json({ error: 'invalid sign-in code' });
      return;
    }
    const code = raw.trim();
    const cur = localLogins.get('claude-code');
    if (!cur || !cur.running) {
      res.status(409).json({ error: 'no login in progress' });
      return;
    }
    if (!cur.url) {
      res.status(409).json({ error: 'sign-in URL is not ready' });
      return;
    }
    if (cur.codeSubmitted) {
      res.status(409).json({ error: 'code already submitted' });
      return;
    }
    localLogins.set('claude-code', { ...cur, codeSubmitted: true });
    reloadCatalogue();
    try {
      loginRunner!.submit('claude-code', code);
      res.json({ ok: true });
    } catch {
      const still = localLogins.get('claude-code');
      if (still) localLogins.set('claude-code', { ...still, codeSubmitted: false });
      reloadCatalogue();
      res.status(502).json({ error: 'could not submit the code' });
    }
  });

    // ── Agent Upgrade (WP-2.3) ────────────────────────────────────────────────
  app.post('/agents/:id/upgrade', (req, res) => {
    const db = getDb();
    const stored = getAgent(db, req.params.id);
    const known = AGENT_BINARIES[req.params.id];
    if (!stored && !known) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    const type = stored ? stored.type : req.params.id;
    const install = AGENT_BINARIES[type]?.install;
    const prereqs = AGENT_BINARIES[type]?.prereqs;
    if (!install) {
      res.status(400).json({ error: 'no scripted install/upgrade for this agent' });
      return;
    }
    if (batchRunning) {
      res.status(409).json({ error: 'install-all batch running — wait for it to finish' });
      return;
    }
    if (upgrading.has(type)) {
      res.status(409).json({ error: 'upgrade already running' });
      return;
    }
    if (opts?.getActiveSessions?.().some((s) => s.agentType === type)) {
      res.status(409).json({ error: 'agent has live sessions — stop them before upgrading' });
      return;
    }

    upgrading.add(type);
    reloadCatalogue();
    res.json({ ok: true, started: true } satisfies UpgradeAgentResponse);

    const runner = opts?.runUpgrade ?? defaultRunner(prereqs);
    void (async () => {
      try {
        await runUpgradeOnce(db, reloadCatalogue, type, install, prereqs, runner);
        await refreshAgentVersions(getDb(), { force: true }).catch((err) => {
          console.warn(`[catalogue] refreshAgentVersions after upgrade failed:`, err);
        });
      } catch (err) {
        console.warn(`[catalogue] upgrade runner error for ${type}:`, err);
      } finally {
        reloadCatalogue();
      }
    })();
  });

  // ── Bulk install / update (sequential; skips live-session agents) ──────────
  app.post('/agents/install-all', (req, res) => {
    if (batchRunning) {
      res.status(409).json({ error: 'install-all already running' });
      return;
    }
    const db = getDb();
    const mode: InstallAllMode = req.body?.mode === 'missing' ? 'missing' : 'missing+behind';
    const liveTypes = new Set(opts?.getActiveSessions?.().map((s) => s.agentType) ?? []);
    const targets: string[] = [];
    const skipped: InstallAllSkip[] = [];
    for (const a of agentsWithInstallState(db)) {
      if (!AGENT_BINARIES[a.type]?.install) continue; // grok-bot etc: never offered
      const wanted = mode === 'missing' ? !a.installed : !a.installed || a.behind === true;
      if (!wanted) continue;
      if (liveTypes.has(a.type)) { skipped.push({ type: a.type, reason: 'agent has live sessions' }); continue; }
      if (upgrading.has(a.type)) { skipped.push({ type: a.type, reason: 'upgrade already running' }); continue; }
      targets.push(a.type);
    }
    if (!targets.length) {
      const body: AgentsInstallAllResponse = { ok: true, started: false, targets, skipped };
      res.json(body);
      return;
    }
    batchRemaining = [...targets];
    batchRunning = true;
    reloadCatalogue();
    const body: AgentsInstallAllResponse = { ok: true, started: true, targets, skipped };
    res.json(body);

    const runner = opts?.runUpgrade ?? defaultRunner();
    void (async () => {
      try {
        for (const type of targets) {
          batchRemaining = batchRemaining.filter((t) => t !== type);
          // A session can start while earlier items install — re-check per item
          // so the batch never replaces a binary under a live agent.
          if (opts?.getActiveSessions?.().some((s) => s.agentType === type)) {
            lastResult.set(type, { ok: false, tail: 'skipped — agent has live sessions', at: Date.now() });
            console.log(`[catalogue] install-all: skipping ${type} (live sessions appeared mid-batch)`);
            reloadCatalogue();
            continue;
          }
          const meta = AGENT_BINARIES[type]!;
          // Prereqs are prefixed at the call site so injected test runners observe
          // the exact command the batch runs (defaultRunner would hide them).
          const cmd = `${buildPrereqPrefix(meta.prereqs)}${meta.install!}`;
          await runUpgradeOnce(db, reloadCatalogue, type, cmd, meta.prereqs, runner);
        }
      } finally {
        // Re-probe BEFORE clearing the batch: otherwise the UI briefly reverts to
        // the pre-batch `behind` flags and the button jumps back to the old count.
        await refreshAgentVersions(db, { force: true }).catch((err) => {
          console.warn('[catalogue] refreshAgentVersions after install-all failed:', err);
        });
        batchRemaining = [];
        batchRunning = false;
        reloadCatalogue();
      }
    })();
  });

  // ── Version refresh (forced re-probe of installed + latest for every agent) ─
  app.post('/agents/versions/refresh', (req, res) => {
    if (versionsRefreshing) {
      res.status(409).json({ error: 'version refresh already running' });
      return;
    }
    versionsRefreshing = true;
    reloadCatalogue();
    res.json({ ok: true, started: true } satisfies VersionsRefreshResponse);
    void (async () => {
      try {
        await refreshAgentVersions(getDb(), { force: true });
      } catch (err) {
        console.warn('[catalogue] versions refresh failed:', err);
      } finally {
        versionsRefreshing = false;
        reloadCatalogue();
      }
    })();
  });
}

