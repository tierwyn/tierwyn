import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { patchConversationInList } from './conversationPatch.js';
import type { Conversation, SandboxSetting } from '@tierwyn/shared';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('sandbox button memoization and persistence wiring', () => {
  it('App.tsx updates conversation sandbox in selection and patches directoryRef immediately on toggle', () => {
    const app = src('./App.tsx');
    expect(app).toContain('void api.updateConversation(conversation.id, { sandbox: v })');
    expect(app).toContain('return { ...cur, conversation: { ...cur.conversation, sandbox: updated.sandbox } };');
    expect(app).toContain('patchConversationInList(directoryRef.current.conversations[pid], { id: updated.id, sandbox: updated.sandbox ?? undefined })');
  });

  it('App.tsx onConversationMeta handles live sandbox frames over WebSocket', () => {
    const app = src('./App.tsx');
    expect(app).toContain('if (meta.sandbox !== undefined) patch.sandbox = meta.sandbox ?? undefined;');
  });

  it('App.tsx re-reads fresh conversation state including sandbox when selecting a conversation', () => {
    const app = src('./App.tsx');
    expect(app).toContain('sandbox: c.sandbox,');
    expect(app).toContain('effort: c.effort,');
    expect(app).toContain('conversation: { ...cur.conversation, ...composerSettingsOf(fresh) }');
  });

  it('Sidebar.tsx consumes liveConversationMeta sandbox update in sidebar conversations list', () => {
    const sidebar = src('./components/Sidebar.tsx');
    expect(sidebar).toContain('if (sandbox !== undefined) patch.sandbox = sandbox ?? undefined;');
  });

  it('ws.ts extracts sandbox from conversation_updated frames into onConversationMeta', () => {
    const ws = src('./ws.ts');
    expect(ws).toContain('frame.sandbox !== undefined');
    expect(ws).toContain('sandbox: frame.sandbox');
  });

  it('patchConversationInList updates sandbox property on conversation correctly', () => {
    const initial: Conversation[] = [
      {
        id: 'c1',
        projectId: 'p1',
        title: 'Conv 1',
        createdAt: 1000,
        updatedAt: 1000,
        sandbox: 'off',
      },
    ];
    const patchedOn = patchConversationInList(initial, { id: 'c1', sandbox: 'on' as SandboxSetting });
    expect(patchedOn?.[0].sandbox).toBe('on');

    const patchedNull = patchConversationInList(patchedOn, { id: 'c1', sandbox: undefined });
    expect(patchedNull?.[0].sandbox).toBeUndefined();
  });
});
