import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { TranscriptEvent } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent, listEventsForConversation } from '../repositories/events.js';
import { collectHandoffAttachments, collectAllHandoffAttachments, mergePromptAttachments } from './handoffAttachments.js';

function promptEvent(attachments?: { base64: string; mediaType: string; name?: string }[]): TranscriptEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    type: 'prompt',
    seq: 0,
    ts: 1,
    sender: 'user',
    payload: { text: 'look at this', attachments },
  };
}

describe('collectHandoffAttachments', () => {
  it('collects image attachments from prior prompts in order', () => {
    const img1 = { base64: 'aGVsbG8=', mediaType: 'image/png', name: 'a.png' };
    const img2 = { base64: 'd29ybGQ=', mediaType: 'image/jpeg', name: 'b.jpg' };
    const events = [
      promptEvent([img1]),
      promptEvent([{ base64: 'cGRm', mediaType: 'application/pdf', name: 'doc.pdf' }]),
      promptEvent([img2]),
    ];
    expect(collectHandoffAttachments(events)).toEqual([img1, img2]);
  });

  it('dedupes identical images', () => {
    const img = { base64: 'aGVsbG8=', mediaType: 'image/png' };
    const events = [promptEvent([img]), promptEvent([img])];
    expect(collectHandoffAttachments(events)).toEqual([img]);
  });
});

describe('mergePromptAttachments', () => {
  it('merges priming and current-turn attachments without duplicates', () => {
    const shared = { base64: 'aGVsbG8=', mediaType: 'image/png', name: 'shared.png' };
    const current = { base64: 'd29ybGQ=', mediaType: 'image/png', name: 'new.png' };
    expect(mergePromptAttachments([shared], [shared, current])).toEqual([shared, current]);
  });
});

describe('collectAllHandoffAttachments', () => {
  it('includes images from the current handoff prompt session', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'C' });
    createSession(db, { id: 's1', conversationId: c.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    createSession(db, { id: 's2', conversationId: c.id, agentId: 'cursor', agentModelId: 'cursor:composer-2.5' });
    const priorImg = { base64: 'cHJpb3I=', mediaType: 'image/png', name: 'prior.png' };
    const handoffImg = { base64: 'aGFuZA==', mediaType: 'image/png', name: 'handoff.png' };
    appendEvent(db, { sessionId: 's1', type: 'prompt', sender: 'user', ts: 1, payload: { text: 'before', attachments: [priorImg] } });
    appendEvent(db, { sessionId: 's2', type: 'prompt', sender: 'user', ts: 2, payload: { text: 'handoff', attachments: [handoffImg] } });
    const priorEvents = listEventsForConversation(db, c.id).filter((e) => e.sessionId !== 's2');
    expect(collectAllHandoffAttachments(priorEvents, db, 's2')).toEqual([priorImg, handoffImg]);
  });
});
