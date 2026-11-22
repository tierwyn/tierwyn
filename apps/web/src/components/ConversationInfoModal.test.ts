import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationInfoModal } from './ConversationInfoModal.js';
import type { NormalisedEvent } from '@tierwyn/shared';

if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = {
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

function ev(partial: Record<string, unknown> & { type: NormalisedEvent['type'] }): NormalisedEvent {
  return {
    id: partial.id ?? `ev-${partial.seq ?? partial.ts ?? 0}`,
    sessionId: partial.sessionId ?? 's1',
    seq: partial.seq ?? 1,
    ts: partial.ts ?? 1_000,
    ...partial,
  } as unknown as NormalisedEvent;
}

describe('ConversationInfoModal', () => {
  it('renders tokens card without cache hint when cache tokens are absent', () => {
    const events: NormalisedEvent[] = [
      ev({ type: 'prompt', id: 'p1', seq: 1, ts: 1_000, payload: { text: 'hello' } }),
      ev({
        type: 'status',
        id: 'st1',
        seq: 2,
        ts: 1_200,
        payload: {
          status: 'done',
          inputTokens: 1000,
          outputTokens: 250,
        },
      }),
    ];

    const html = renderToStaticMarkup(
      React.createElement(ConversationInfoModal, {
        events,
        onClose: () => {},
      })
    );

    expect(html).toContain('Tokens (In / Out)');
    expect(html).toContain('1,000 / 250');
    expect(html).not.toContain('Cache read');
    expect(html).not.toContain('Cache write');
  });

  it('renders tokens card with cache read and cache write hints when present', () => {
    const events: NormalisedEvent[] = [
      ev({ type: 'prompt', id: 'p1', seq: 1, ts: 1_000, payload: { text: 'turn 1' } }),
      ev({
        type: 'status',
        id: 'st1',
        seq: 2,
        ts: 1_200,
        payload: {
          status: 'done',
          inputTokens: 1000,
          outputTokens: 250,
          cacheReadTokens: 4000,
          cacheCreationTokens: 800,
        },
      }),
      ev({ type: 'prompt', id: 'p2', seq: 3, ts: 2_000, payload: { text: 'turn 2' } }),
      ev({
        type: 'status',
        id: 'st2',
        seq: 4,
        ts: 2_200,
        payload: {
          status: 'done',
          inputTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 2000,
        },
      }),
    ];

    const html = renderToStaticMarkup(
      React.createElement(ConversationInfoModal, {
        events,
        onClose: () => {},
      })
    );

    expect(html).toContain('Tokens (In / Out)');
    expect(html).toContain('1,500 / 350');
    expect(html).toContain('Cache read: 6,000 · write: 800');
  });

  it('renders tokens card with cache read only when only cacheReadTokens was reported', () => {
    const events: NormalisedEvent[] = [
      ev({ type: 'prompt', id: 'p1', seq: 1, ts: 1_000, payload: { text: 'turn 1' } }),
      ev({
        type: 'status',
        id: 'st1',
        seq: 2,
        ts: 1_200,
        payload: {
          status: 'done',
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 3500,
        },
      }),
    ];

    const html = renderToStaticMarkup(
      React.createElement(ConversationInfoModal, {
        events,
        onClose: () => {},
      })
    );

    expect(html).toContain('Tokens (In / Out)');
    expect(html).toContain('1,000 / 200');
    expect(html).toContain('Cache read: 3,500');
    expect(html).not.toContain('write:');
  });
});
