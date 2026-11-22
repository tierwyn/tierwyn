import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, setDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { SCHEDULE_INHERIT_PROFILE_ID, type RemoteHostView } from '@tierwyn/shared';
import { createProject } from '../repositories/projects.js';
import { upsertDiscoveredModels } from '../repositories/models.js';
import { getProject } from '../repositories/projects.js';
import {
  createConversation,
  createScheduleHomeConversation,
  setConversationArchived,
} from '../repositories/conversations.js';
import { createSession, setNativeSessionId } from '../repositories/sessions.js';
import { createRemoteAgentConversation } from '../repositories/remoteAgents.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { validateScheduleTarget, validateScheduleTargetPatch } from './target.js';

function hostView(over: {
  id?: string;
  name?: string;
  installed?: boolean;
  state?: RemoteHostView['state'];
  models?: string[];
} = {}): RemoteHostView {
  const installed = over.installed ?? true;
  const models = over.models ?? ['claude-opus-4-8'];
  return {
    id: over.id ?? 'host-1',
    name: over.name ?? 'box',
    state: over.state ?? 'connected',
    hello: {
      agents: { 'claude-code': { installed, methods: [] } },
      models: { 'claude-code': models },
    },
    allowMcpSecrets: true,
    createdAt: Date.now(),
  };
}

const BOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BOT_OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GROK_PROFILE = `grok-bot:${BOT}`;
const GROK_OTHER = `grok-bot:${BOT_OTHER}`;
const CLAUDE = 'claude-code:opus-4.8';

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db);
  enableAllAgents(db);
  upsertDiscoveredModels(db, 'grok-bot', [
    { name: BOT, label: 'Grok Bot · Test', provider: 'xai', vision: false, steer: true },
    { name: BOT_OTHER, label: 'Grok Bot · Other', provider: 'xai', vision: false, steer: true },
  ]);
  setDb(db);
  catalogue.load(db);
});

function project(overrides: { remoteAgents?: boolean } = {}) {
  if (overrides.remoteAgents) {
    ensureRemoteAgentsProject(db);
    return getProject(db, REMOTE_AGENTS_PROJECT_ID)!;
  }
  return createProject(db, { name: 'p', rootPath: '/tmp/p' });
}

/** Seed a grok-bot session on a conversation (native_session_id = bot pin). */
function bindBot(conversationId: string, botId = BOT, agentModelId = `grok-bot:${botId}`) {
  const sessionId = `s-${conversationId.slice(0, 8)}-${botId.slice(0, 8)}`;
  createSession(db, {
    id: sessionId,
    conversationId,
    agentId: 'grok-bot',
    agentModelId,
  });
  setNativeSessionId(db, sessionId, botId);
  return sessionId;
}

describe('validateScheduleTarget', () => {
  it('rejects bare-prompt + packSlug with bare_prompt_unsupported', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: GROK_PROFILE,
      packSlug: 'evolve-wave',
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/pack is not supported/);
  });

  it('rejects bare-prompt + templateName', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: GROK_PROFILE,
      templateName: 'delegate',
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/delegation template is not supported/);
  });

  it('rejects bare-prompt + non-empty steps', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: GROK_PROFILE,
      steps: [{ title: 'A', body: 'do it' }],
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/plan steps is not supported/);
  });

  it('rejects bare-prompt + workdir worktree', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: GROK_PROFILE,
      workdir: 'worktree',
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/worktree workdir is not supported/);
  });

  it('rejects bare-prompt + agentMayComplete', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: GROK_PROFILE,
      agentMayComplete: true,
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/agent-may-complete is not supported/);
  });

  it('accepts bare-prompt + workdir shared + empty steps on resume with pinned Bot', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot chat' });
    bindBot(bound.id);
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: GROK_PROFILE,
      boundConversationId: bound.id,
      workdir: 'shared',
      steps: [],
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('rejects grok-bot + spawn_child with grok_bot_requires_resume', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: GROK_PROFILE,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: 'grok_bot_requires_resume',
      error: 'Grok Bot schedules must send to an existing conversation',
    });
  });

  it('Remote Agents bound + inherit → profileId rewritten to grok-bot:<botId>', () => {
    const p = project({ remoteAgents: true });
    const boundId = createRemoteAgentConversation(db, BOT, 'Inbox');
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: SCHEDULE_INHERIT_PROFILE_ID,
      boundConversationId: boundId,
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('inherit + steps on a Bot conversation → 400 bare_prompt_unsupported (plan steps)', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot chat' });
    bindBot(bound.id);
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: SCHEDULE_INHERIT_PROFILE_ID,
      boundConversationId: bound.id,
      steps: [{ title: 'A', body: 'do it' }],
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/plan steps is not supported/);
  });

  it('clean inherit create on a Bot conversation still pins', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot chat' });
    bindBot(bound.id);
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: SCHEDULE_INHERIT_PROFILE_ID,
      boundConversationId: bound.id,
      steps: [],
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('rewrites grok-bot:default to the bound conversation Bot id', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot chat' });
    bindBot(bound.id);
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: 'grok-bot:default',
      boundConversationId: bound.id,
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('rejects mismatched grok-bot:<otherId> against the bound Bot', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot chat' });
    bindBot(bound.id);
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: GROK_OTHER,
      boundConversationId: bound.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: `conversation is bound to grok-bot:${BOT}`,
    });
  });

  it('rejects bound conversation without a grok-bot session (grok_bot_unbound)', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'empty chat' });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: GROK_PROFILE,
      boundConversationId: bound.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: 'grok_bot_unbound',
      error: 'bound conversation has no Grok Bot yet — send it a message first',
    });
  });

  it('rejects Remote Agents project + claude-code profile', () => {
    const r = validateScheduleTarget(db, {
      project: project({ remoteAgents: true }),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'Remote Agents project only accepts grok-bot profiles',
    });
  });

  it('accepts non-bare profile + pack + worktree', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
      packSlug: 'evolve-wave',
      workdir: 'worktree',
      templateName: 'some-template',
      steps: [{ title: 'A', body: 'x' }],
      agentMayComplete: true,
    });
    expect(r).toEqual({ ok: true, profileId: CLAUDE });
  });

  it('rejects unknown profile', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'spawn_child',
      profileId: 'no-such:profile',
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'unknown or disabled profile: no-such:profile',
    });
  });

  it('rejects resume_conversation without boundConversationId', () => {
    const r = validateScheduleTarget(db, {
      project: project(),
      executionMode: 'resume_conversation',
      profileId: CLAUDE,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'boundConversationId required for resume_conversation',
    });
  });

  it('rejects bound conversation in another project', () => {
    const p = project();
    const other = createProject(db, { name: 'other', rootPath: '/tmp/other' });
    const bound = createConversation(db, { projectId: other.id, title: 'foreign' });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: CLAUDE,
      boundConversationId: bound.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'bound conversation must belong to this project',
    });
  });

  it('rejects archived bound conversation', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'chat' });
    setConversationArchived(db, bound.id, true);
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: CLAUDE,
      boundConversationId: bound.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'bound conversation is archived',
    });
  });

  it('rejects binding a schedule_home conversation', () => {
    const p = project();
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'job' });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: CLAUDE,
      boundConversationId: home.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'cannot bind a schedule run conversation',
    });
  });

  it('rejects binding a run conversation (child of schedule_home)', () => {
    const p = project();
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'job' });
    const run = createConversation(db, {
      projectId: p.id,
      title: '⏱ run',
      parentConversationId: home.id,
    });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: CLAUDE,
      boundConversationId: run.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'cannot bind a schedule run conversation',
    });
  });

  it('rejects spawn_child with a boundConversationId', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'chat' });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'spawn_child',
      profileId: CLAUDE,
      boundConversationId: bound.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'boundConversationId only valid for resume_conversation',
    });
  });

  it('rejects inherit profile with spawn_child', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'chat' });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'spawn_child',
      profileId: SCHEDULE_INHERIT_PROFILE_ID,
      boundConversationId: bound.id,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'inherit profile requires resume_conversation',
    });
  });

  it('accepts inherit + resume + valid bound (profileId stays inherit)', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'chat' });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: SCHEDULE_INHERIT_PROFILE_ID,
      boundConversationId: bound.id,
    });
    expect(r).toEqual({ ok: true, profileId: SCHEDULE_INHERIT_PROFILE_ID });
  });
});

describe('validateScheduleTargetPatch', () => {
  function resumeBotJob(boundId: string) {
    return {
      profileId: GROK_PROFILE,
      executionMode: 'resume_conversation' as const,
      boundConversationId: boundId,
      workdir: 'shared' as const,
      agentMayComplete: false,
    };
  }

  it('skips when no relevant field changed (legacy steps tolerated)', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: resumeBotJob(bound.id),
      storedSteps: [{ title: 'Legacy', body: 'x' }],
      patch: {},
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('skips when patch restates the same values', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: resumeBotJob(bound.id),
      storedSteps: [{ title: 'Legacy', body: 'x' }],
      patch: { profileId: GROK_PROFILE, workdir: 'shared', agentMayComplete: false },
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('staying bare rejects only newly set templateName', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: resumeBotJob(bound.id),
      storedSteps: [{ title: 'Legacy', body: 'x' }],
      patch: { templateName: 'delegate' },
    });
    expect(r).toMatchObject({ ok: false, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/delegation template/);
  });

  it('moving into bare with stored steps rejects plan steps', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: {
        profileId: CLAUDE,
        executionMode: 'resume_conversation',
        boundConversationId: bound.id,
        workdir: 'shared',
        agentMayComplete: false,
      },
      storedSteps: [{ title: 'A', body: 'do it' }],
      patch: { profileId: GROK_PROFILE },
    });
    expect(r).toMatchObject({ ok: false, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/plan steps/);
  });

  it('moving into bare with steps:[] on a resume job pins the Bot', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: {
        profileId: CLAUDE,
        executionMode: 'resume_conversation',
        boundConversationId: bound.id,
        workdir: 'shared',
        agentMayComplete: false,
      },
      storedSteps: [{ title: 'A', body: 'do it' }],
      patch: { profileId: 'grok-bot:default', steps: [], stepsKeyPresent: true },
    });
    expect(r).toEqual({ ok: true, profileId: GROK_PROFILE });
  });

  it('moving spawn_child job into grok-bot rejects grok_bot_requires_resume', () => {
    const p = project();
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: {
        profileId: CLAUDE,
        executionMode: 'spawn_child',
        workdir: 'shared',
        agentMayComplete: false,
      },
      storedSteps: [],
      patch: { profileId: GROK_PROFILE, steps: [], stepsKeyPresent: true },
    });
    expect(r).toMatchObject({ ok: false, code: 'grok_bot_requires_resume' });
  });

  it('bound-only rebind on pinned Bot job with stored steps → 400 bare_prompt_unsupported', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const other = createConversation(db, { projectId: p.id, title: 'bot-2' });
    bindBot(other.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: resumeBotJob(bound.id),
      storedSteps: [{ title: 'Legacy', body: 'x' }],
      patch: { boundConversationId: other.id },
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/plan steps is not supported/);
  });

  it('PATCH inherit + steps on Bot conversation → 400 bare_prompt_unsupported', () => {
    const p = project();
    const bound = createConversation(db, { projectId: p.id, title: 'bot' });
    bindBot(bound.id);
    const r = validateScheduleTargetPatch(db, {
      project: p,
      job: {
        profileId: CLAUDE,
        executionMode: 'resume_conversation',
        boundConversationId: bound.id,
        workdir: 'shared',
        agentMayComplete: false,
      },
      storedSteps: [],
      patch: {
        profileId: SCHEDULE_INHERIT_PROFILE_ID,
        steps: [{ title: 'A', body: 'x' }],
        stepsKeyPresent: true,
      },
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'bare_prompt_unsupported' });
    if (!r.ok) expect(r.error).toMatch(/plan steps is not supported/);
  });
});

describe('validateScheduleTarget host availability (Task 11)', () => {
  function remoteProject() {
    const host = createPendingHost(db, 'box', `tok-${Math.random()}`, Date.now() + 60_000);
    return createProject(db, { name: 'rp', rootPath: '/tmp/rp', remoteHostId: host.id });
  }

  it('remote project + agent not installed → 400 reason agent_not_installed', () => {
    const r = validateScheduleTarget(db, {
      project: remoteProject(),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
      hostView: hostView({ installed: false }),
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'not available on host',
      reason: 'agent_not_installed',
    });
  });

  it('remote project + disconnected host → 400 reason host_disconnected', () => {
    const r = validateScheduleTarget(db, {
      project: remoteProject(),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
      hostView: hostView({ state: 'disconnected' }),
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'not available on host',
      reason: 'host_disconnected',
    });
  });

  it('remote project + explicit hostView: undefined → 400 reason host_disconnected', () => {
    // Create routes always pass the hostView key (value may be undefined when
    // the deps view is missing). Omitting the key skips the gate (step-replace).
    const r = validateScheduleTarget(db, {
      project: remoteProject(),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
      hostView: undefined,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: 'not available on host',
      reason: 'host_disconnected',
    });
  });

  it('remote project + omitted hostView key skips the host gate', () => {
    const r = validateScheduleTarget(db, {
      project: remoteProject(),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
    });
    expect(r).toMatchObject({ ok: true, profileId: CLAUDE });
  });

  it('remote project + installed + connected → ok', () => {
    const r = validateScheduleTarget(db, {
      project: remoteProject(),
      executionMode: 'spawn_child',
      profileId: CLAUDE,
      hostView: hostView({ installed: true, state: 'connected' }),
    });
    expect(r).toEqual({ ok: true, profileId: CLAUDE });
  });

  it('inherit on remote project skips create-time host check', () => {
    const p = remoteProject();
    const bound = createConversation(db, { projectId: p.id, title: 'chat' });
    createSession(db, {
      id: 's-inh',
      conversationId: bound.id,
      agentId: 'claude-code',
      agentModelId: CLAUDE,
    });
    const r = validateScheduleTarget(db, {
      project: p,
      executionMode: 'resume_conversation',
      profileId: SCHEDULE_INHERIT_PROFILE_ID,
      boundConversationId: bound.id,
      hostView: hostView({ state: 'disconnected' }),
    });
    expect(r).toEqual({ ok: true, profileId: SCHEDULE_INHERIT_PROFILE_ID });
  });
});
