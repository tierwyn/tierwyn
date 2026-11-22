/**
 * 1:1 Remote Agents conversations keyed by sessions.native_session_id.
 * Thin SQL over existing repo fns — no new table.
 */
import type { Database } from 'better-sqlite3';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { createConversation, getConversation, setConversationArchived } from './conversations.js';
import { grokBotEnabled } from '../adapters/grok-bot/supervisor.js';
import { getAgent } from './models.js';
import { lastSessionForConversation } from './sessions.js';
import { ensureWatcherSession } from './grokBotWatch.js';
import { getGeneralSettings } from './settings.js';

export const BOT_MODEL_PREFIX = 'grok-bot:';
const BOT_ID_RE = /^grok-bot:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function findRemoteAgentConversation(
  db: Database,
  botId: string,
): { id: string; archived: boolean } | undefined {
  const r = db.prepare(
    `SELECT c.id AS id, COALESCE(c.archived, 0) AS archived
       FROM conversations c
       JOIN sessions s ON s.conversation_id = c.id
      WHERE c.project_id = ?
        AND s.agent_id = 'grok-bot'
        AND s.native_session_id = ?
        AND (s.agent_model_id IS NULL OR s.agent_model_id = 'grok-bot:' || s.native_session_id)
      LIMIT 1`,
  ).get(REMOTE_AGENTS_PROJECT_ID, botId) as { id: string; archived: number } | undefined;
  if (!r) return undefined;
  return { id: r.id, archived: r.archived === 1 };
}

export function createRemoteAgentConversation(db: Database, botId: string, name: string): string {
  return db.transaction(() => {
    const conv = createConversation(db, {
      projectId: REMOTE_AGENTS_PROJECT_ID,
      title: name || botId,
    });
    ensureWatcherSession(db, conv.id, botId, `grok-bot:${botId}`);
    return conv.id;
  })();
}

export function listRemoteAgentConversations(
  db: Database,
  options: { archived: boolean },
): { id: string; botId: string }[] {
  const archivedClause = options.archived
    ? 'AND c.archived = 1'
    : 'AND (c.archived IS NULL OR c.archived = 0)';
  const rows = db.prepare(
    `SELECT c.id AS id, s.native_session_id AS botId, MAX(s.created_at) AS created_at
       FROM conversations c
       JOIN sessions s ON s.conversation_id = c.id
      WHERE c.project_id = ?
        AND s.agent_id = 'grok-bot'
        AND s.native_session_id IS NOT NULL
        AND s.native_session_id <> ''
        AND (s.agent_model_id IS NULL OR s.agent_model_id = 'grok-bot:' || s.native_session_id)
        ${archivedClause}
      GROUP BY c.id
     HAVING s.created_at = MAX(s.created_at)`,
  ).all(REMOTE_AGENTS_PROJECT_ID) as { id: string; botId: string }[];
  return rows.map((r) => ({ id: r.id, botId: r.botId }));
}

export function retireRemoteAgentConversation(db: Database, conversationId: string): void {
  setConversationArchived(db, conversationId, true);
}

export function getRemoteAgentBotId(db: Database, conversationId: string): string | undefined {
  const row = db.prepare(
    `SELECT s.native_session_id AS botId
       FROM sessions s
       JOIN conversations c ON c.id = s.conversation_id
      WHERE c.id = ?
        AND c.project_id = ?
        AND s.agent_id = 'grok-bot'
        AND s.native_session_id IS NOT NULL
        AND s.native_session_id <> ''
        AND (s.agent_model_id IS NULL OR s.agent_model_id = 'grok-bot:' || s.native_session_id)
      ORDER BY s.created_at ASC
      LIMIT 1`,
  ).get(conversationId, REMOTE_AGENTS_PROJECT_ID) as { botId: string } | undefined;
  return row?.botId;
}

export function assertValidRemoteAgentProfile(
  db: Database,
  conversationId: string,
  projectId: string | undefined,
  profileId: string | undefined,
): void {
  const conv = getConversation(db, conversationId);
  const effectiveProjectId = conv?.projectId ?? projectId;
  if (effectiveProjectId !== REMOTE_AGENTS_PROJECT_ID) return;

  if (profileId === 'grok-bot:default') {
    throw new Error('Active chat profile (grok-bot:default) cannot be used in Remote Agents container');
  }
  const match = profileId ? BOT_ID_RE.exec(profileId) : null;
  if (!match) {
    throw new Error('Model cannot be changed for Remote Agents conversations: must be grok-bot:<botId>');
  }
  const requestedBotId = match[1];
  const boundBotId = getRemoteAgentBotId(db, conversationId);
  if (boundBotId && boundBotId.toLowerCase() !== requestedBotId.toLowerCase()) {
    throw new Error(`Conversation is permanently bound to grok-bot:${boundBotId}`);
  }
}

const GROK_DISABLED = 'Grok Bot is disabled — enable in Settings → Grok Bot';

/** Block prompts/commands to grok-bot conversations while the agent is disabled,
 *  even if the client fell back to another profile. */
export function assertGrokBotConversationWritable(
  db: Database,
  conversationId: string,
  projectId: string | undefined,
  profileId: string | undefined,
  agent?: string,
): void {
  if (grokBotEnabled(db)) return;
  const conv = getConversation(db, conversationId);
  const effectiveProjectId = conv?.projectId ?? projectId;
  if (effectiveProjectId === REMOTE_AGENTS_PROJECT_ID) throw new Error(GROK_DISABLED);
  if ((profileId ?? '').startsWith('grok-bot:') || agent === 'grok-bot') throw new Error(GROK_DISABLED);
  const last = lastSessionForConversation(db, conversationId);
  if (last?.agentId !== 'grok-bot') return;
  if (namesEnabledNonGrok(db, profileId, agent)) return;
  throw new Error(GROK_DISABLED);
}

function namesEnabledNonGrok(
  db: Database,
  profileId: string | undefined,
  agent: string | undefined,
): boolean {
  if ((profileId ?? '').startsWith('grok-bot:') || agent === 'grok-bot') return false;
  const agentId = agent || (profileId ? profileId.split(':')[0] : '');
  if (!agentId) return false;
  return getAgent(db, agentId)?.enabled === true;
}

const GROK_PROJECT_CHATS_OFF =
  'Grok Bot in project chats is off — enable in Settings → Grok Bot, or use a Grok Bots conversation';

/** When grokBotInProjectChats is off, block grok-bot prompts outside Remote Agents. */
export function assertGrokBotAllowedInProject(
  db: Database,
  conversationId: string,
  projectId: string | undefined,
  profileId: string | undefined,
  agent?: string,
): void {
  const targetingGrok = agent === 'grok-bot' || (profileId ?? '').startsWith('grok-bot:');
  if (!targetingGrok) return;
  const conv = getConversation(db, conversationId);
  const effectiveProjectId = conv?.projectId ?? projectId;
  if (effectiveProjectId === REMOTE_AGENTS_PROJECT_ID) return;
  if (getGeneralSettings(db).grokBotInProjectChats) return;
  throw new Error(GROK_PROJECT_CHATS_OFF);
}

/** True when bare-prompt (grok-bot) handoff priming + host/CWD note should be sent. */
export function grokBotBarePrimingEnabled(
  db: Database,
  conversationId: string,
  projectId: string | undefined,
): boolean {
  if (getGeneralSettings(db).grokBotInProjectChats) return true;
  const conv = getConversation(db, conversationId);
  return (conv?.projectId ?? projectId) === REMOTE_AGENTS_PROJECT_ID;
}

