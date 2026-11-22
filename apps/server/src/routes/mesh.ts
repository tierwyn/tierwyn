import type { Express, Request } from 'express';
import express from 'express';
import type { Database } from 'better-sqlite3';
import type { AgentStatus, MeshPeer } from '@tierwyn/shared';
import { peekSpawnToken } from '../spawn/tokens.js';
import { getCompactionSettings } from '../repositories/settings.js';
import { getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { projectAwareness } from '../mesh/awareness.js';
import { canMintEdge } from '../mesh/policy.js';
import {
  mintMeshEdge, revokeMeshEdge, listMeshEdges, listMeshMessages, insertMeshAudit,
  countLiveOutbound, getLiveEdge,
} from '../mesh/edges.js';
import { tryMeshPeerListRate } from '../mesh/rate.js';
import { helpHint } from '../spawn/agentHelp.js';

/** Titles alone are ambiguous, so add project/role detail and the tree relation of the pair. */
function describePair(db: Database, fromId: string, toId: string) {
  const f = getConversation(db, fromId);
  const t = getConversation(db, toId);
  const detail = (c: typeof f) =>
    c ? [getProject(db, c.projectId)?.name, c.designation ?? c.templateName].filter(Boolean).join(' · ') || undefined : undefined;
  let relation: string | undefined;
  if (f && t) {
    if (t.parentConversationId === f.id) relation = 'parent → child';
    else if (f.parentConversationId === t.id) relation = 'child → parent';
    else if (f.parentConversationId && f.parentConversationId === t.parentConversationId) relation = 'siblings';
  }
  return { fromTitle: f?.title, toTitle: t?.title, fromDetail: detail(f), toDetail: detail(t), fromDescription: f?.description || undefined, toDescription: t?.description || undefined, relation };
}

export type MeshCaller =
  | { kind: 'agent'; conversationId: string; sessionId: string }
  | { kind: 'operator' };

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Dual-auth: live spawn token (any scope) wins over cookie. Mesh-scope is
 *  required for mint/send (Phase 2); awareness is a read of server-authored
 *  structured data, so any live token of the conversation is enough — otherwise
 *  T1 cannot run while messaging is still off. */
export function resolveMeshCaller(req: Request, isAuthed: (req: Request) => boolean): MeshCaller | null {
  const entry = peekSpawnToken(bearerToken(req));
  if (entry) {
    return { kind: 'agent', conversationId: entry.conversationId, sessionId: entry.sessionId };
  }
  if (isAuthed(req)) return { kind: 'operator' };
  return null;
}

export function resolveMeshCallerRequiringMesh(
  req: Request,
  isAuthed: (req: Request) => boolean,
): MeshCaller | null {
  const entry = peekSpawnToken(bearerToken(req));
  if (entry && entry.scope.has('mesh')) {
    return { kind: 'agent', conversationId: entry.conversationId, sessionId: entry.sessionId };
  }
  if (isAuthed(req)) return { kind: 'operator' };
  return null;
}

interface Deps {
  getDb: () => Database;
  isAuthed: (req: Request) => boolean;
  activeSessions: () => { conversationId: string; lastStatus?: AgentStatus; startedAt: number }[];
  hasLiveEdge?: (fromId: string, toId: string) => boolean;
}

export function registerMeshRoutes(app: Express, deps: Deps): void {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  r.get('/agent/mesh/peers', (req, res) => {
    const caller = resolveMeshCaller(req, deps.isAuthed);
    if (!caller) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const db = deps.getDb();
    const settings = getCompactionSettings(db);
    if (settings.meshAwareness === 'off') {
      res.status(403).json({ error: 'mesh awareness is off', ...helpHint('mesh') });
      return;
    }
    const conversationId = caller.kind === 'agent'
      ? caller.conversationId
      : String(req.query.conversationId ?? '');
    if (!conversationId || !getConversation(db, conversationId)) {
      res.status(400).json({ error: 'conversationId required', ...helpHint('mesh') });
      return;
    }
    const bucketKey = caller.kind === 'agent' ? caller.conversationId : 'operator';
    const gate = tryMeshPeerListRate({ callerId: bucketKey });
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      res.status(429).json({ error: 'rate limited', retryAfter: gate.retryAfter });
      return;
    }
    const peers: MeshPeer[] = projectAwareness({
      db,
      conversationId,
      active: deps.activeSessions().map((s) => ({
        conversationId: s.conversationId,
        status: s.lastStatus,
        startedAt: s.startedAt,
      })),
      hasLiveEdge: settings.meshMessaging === 'tree' && deps.hasLiveEdge
        ? (to) => deps.hasLiveEdge!(conversationId, to)
        : undefined,
    });
    res.json({ peers });
  });

  r.post('/mesh/edges', (req, res) => {
    const entry = peekSpawnToken(bearerToken(req));
    if (entry && !entry.scope.has('mesh')) {
      res.status(403).json({ error: 'token lacks mesh capability' });
      return;
    }
    const caller = resolveMeshCallerRequiringMesh(req, deps.isAuthed);
    if (!caller) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const db = deps.getDb();
    const settings = getCompactionSettings(db);
    if (settings.meshMessaging !== 'tree') {
      res.status(403).json({ error: 'mesh messaging is off' });
      return;
    }
    const body = req.body as {
      fromConversationId?: string;
      toConversationId?: string;
      allowReplies?: boolean;
      note?: string;
    };
    const fromId = caller.kind === 'agent'
      ? (body.fromConversationId ?? caller.conversationId)
      : (body.fromConversationId ?? '');
    const toId = body.toConversationId ?? '';
    if (!fromId || !toId) {
      res.status(400).json({ error: 'fromConversationId and toConversationId required' });
      return;
    }
    const mintCheck = canMintEdge(db, {
      callerKind: caller.kind,
      callerConversationId: caller.kind === 'agent' ? caller.conversationId : undefined,
      fromId,
      toId,
    });
    if (!mintCheck.ok) {
      insertMeshAudit(db, {
        callerKind: caller.kind,
        fromConversation: fromId,
        toConversation: toId,
        decision: mintCheck.reason,
      });
      res.status(mintCheck.status).json({ error: mintCheck.error });
      return;
    }
    if (countLiveOutbound(db, fromId) >= settings.meshMaxPeersPerConversation) {
      insertMeshAudit(db, {
        callerKind: caller.kind,
        fromConversation: fromId,
        toConversation: toId,
        decision: 'denied_rate',
      });
      res.status(400).json({ error: 'peer cap reached', decision: 'denied_rate' });
      return;
    }
    try {
      const mintedBy = caller.kind === 'agent' ? `agent:${caller.conversationId}` : 'operator';
      const edge = mintMeshEdge(db, { fromConversation: fromId, toConversation: toId, mintedBy, note: body.note });
      insertMeshAudit(db, {
        callerKind: caller.kind,
        fromConversation: fromId,
        toConversation: toId,
        edgeId: edge.id,
        decision: 'mint',
      });
      let reverse: { id: string } | undefined;
      if (body.allowReplies !== false) {
        if (countLiveOutbound(db, toId) < settings.meshMaxPeersPerConversation && !getLiveEdge(db, toId, fromId)) {
          reverse = mintMeshEdge(db, { fromConversation: toId, toConversation: fromId, mintedBy, note: body.note });
          insertMeshAudit(db, {
            callerKind: caller.kind,
            fromConversation: toId,
            toConversation: fromId,
            edgeId: reverse.id,
            decision: 'mint',
          });
        }
      }
      res.status(201).json({ edge, reverse });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg.includes('UNIQUE') ? 'live edge already exists' : msg });
    }
  });

  r.delete('/mesh/edges/:id', (req, res) => {
    if (!deps.isAuthed(req)) {
      res.status(401).json({ error: 'operator session required' });
      return;
    }
    const ok = revokeMeshEdge(deps.getDb(), req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'edge not found or already revoked' });
      return;
    }
    res.json({ ok: true });
  });

  r.get('/mesh/edges', (req, res) => {
    if (!deps.isAuthed(req)) {
      res.status(401).json({ error: 'operator session required' });
      return;
    }
    const db = deps.getDb();
    const edges = listMeshEdges(db).map((e) => ({
      ...e,
      ...describePair(db, e.fromConversation, e.toConversation),
    }));
    res.json({ edges });
  });

  r.get('/mesh/messages', (req, res) => {
    if (!deps.isAuthed(req)) {
      res.status(401).json({ error: 'operator session required' });
      return;
    }
    const db = deps.getDb();
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 1000) : 300;
    const messages = listMeshMessages(db, limit).map((m) => ({
      ...m,
      ...describePair(db, m.fromConversation, m.toConversation),
    }));
    res.json({ messages });
  });

  app.use(r);
}
