import { describe, it, expect } from 'vitest';
import type { NormalisedEvent } from '@tierwyn/shared';
import type { MergedItem } from './groupTurns.js';
import {
  formatAgentHeader,
  splitAgentModel,
  showTurnResponseAgentLabel,
  hasTurnVisibleMessageOrCard,
  hasTurnTools,
  hasTurnVisibleBody,
  lastTurnMustRerender,
} from './components/OutputPane.js';

function makeItem(event: { type: string; payload?: Record<string, unknown>; seq?: number }): MergedItem {
  return {
    event: {
      id: 'e1',
      sessionId: 's1',
      ts: 1000,
      payload: {},
      ...event,
    } as unknown as NormalisedEvent,
  };
}

describe('formatAgentHeader', () => {
  it('formats dot-separated profile labels into Agent and Model', () => {
    expect(formatAgentHeader('Cursor · Composer 2.5')).toBe('Agent: Cursor - Model: Composer 2.5');
    expect(formatAgentHeader('Claude Code · Sonnet 4.6')).toBe('Agent: Claude Code - Model: Sonnet 4.6');
    expect(formatAgentHeader('Antigravity • Gemini 2.5 Pro')).toBe('Agent: Antigravity - Model: Gemini 2.5 Pro');
  });

  it('formats colon-separated profile IDs into Agent and Model', () => {
    expect(formatAgentHeader('cursor:composer-2.5')).toBe('Agent: cursor - Model: composer-2.5');
    expect(formatAgentHeader('grok-bot:default')).toBe('Agent: grok-bot - Model: default');
  });

  it('preserves labels without separator as Agent name', () => {
    expect(formatAgentHeader('claude-code')).toBe('Agent: claude-code');
    expect(formatAgentHeader('OpenCode')).toBe('Agent: OpenCode');
  });
});

describe('splitAgentModel', () => {
  it('splits dot-separated labels into agent and model', () => {
    expect(splitAgentModel('Cursor · Claude Opus 5 1M Low')).toEqual({
      agent: 'Cursor',
      model: 'Claude Opus 5 1M Low',
    });
    expect(splitAgentModel('Antigravity · Gemini 3.7 Flash (Medium)')).toEqual({
      agent: 'Antigravity',
      model: 'Gemini 3.7 Flash (Medium)',
    });
    expect(splitAgentModel('Grok Bot · Inbox Triage')).toEqual({
      agent: 'Grok Bot',
      model: 'Inbox Triage',
    });
  });

  it('splits formatted Agent: X - Model: Y strings', () => {
    expect(splitAgentModel('Agent: Cursor - Model: Claude Opus 5 1M Low')).toEqual({
      agent: 'Cursor',
      model: 'Claude Opus 5 1M Low',
    });
  });

  it('splits colon-separated profile IDs', () => {
    expect(splitAgentModel('cursor:composer-2.5')).toEqual({
      agent: 'cursor',
      model: 'composer-2.5',
    });
  });

  it('handles label without separator', () => {
    expect(splitAgentModel('claude-code')).toEqual({
      agent: 'claude-code',
      model: undefined,
    });
  });
});

describe('showTurnResponseAgentLabel', () => {
  it('hides the response header badge when Sent to is already on the user echo', () => {
    expect(showTurnResponseAgentLabel({
      isHandoff: false,
      hasUserPrompt: true,
      hasRecipientLabel: true,
    })).toBe(false);
  });

  it('keeps the badge on a handoff and when there is no user echo', () => {
    expect(showTurnResponseAgentLabel({
      isHandoff: true,
      hasUserPrompt: true,
      hasRecipientLabel: true,
    })).toBe(true);
    expect(showTurnResponseAgentLabel({
      isHandoff: false,
      hasUserPrompt: false,
      hasRecipientLabel: true,
    })).toBe(true);
  });
});

describe('hasTurnVisibleMessageOrCard', () => {
  it('returns false for empty events or tools-only events', () => {
    expect(hasTurnVisibleMessageOrCard([])).toBe(false);
    expect(
      hasTurnVisibleMessageOrCard([
        makeItem({ type: 'tool_call', payload: { name: 'bash' } }),
        makeItem({ type: 'tool_result', payload: { content: 'ok' } }),
      ])
    ).toBe(false);
  });

  it('returns false for empty chunk messages', () => {
    expect(
      hasTurnVisibleMessageOrCard([
        makeItem({ type: 'message', payload: { chunk: '   ' } }),
      ])
    ).toBe(false);
  });

  it('returns true when non-empty prose message is present', () => {
    expect(
      hasTurnVisibleMessageOrCard([
        makeItem({ type: 'message', payload: { chunk: 'Hello world' } }),
      ])
    ).toBe(true);
  });

  it('respects edited chunk overrides', () => {
    const item = makeItem({ seq: 10, type: 'message', payload: { chunk: '' } });
    expect(
      hasTurnVisibleMessageOrCard([item], (key) => (key === 'event-10' ? 'Now edited' : undefined))
    ).toBe(true);
  });

  it('returns true for non-heartbeat spawn markers', () => {
    expect(
      hasTurnVisibleMessageOrCard([
        makeItem({
          type: 'message',
          payload: { spawnMarker: { kind: 'result', text: 'done' } },
        }),
      ])
    ).toBe(true);
  });

  it('returns false for heartbeat spawn markers', () => {
    expect(
      hasTurnVisibleMessageOrCard([
        makeItem({
          type: 'message',
          payload: { spawnMarker: { kind: 'heartbeat' } },
        }),
      ])
    ).toBe(false);
  });
});

describe('hasTurnTools', () => {
  it('detects tool_call, tool_result, and file_change', () => {
    const events = [
      makeItem({ type: 'tool_call', payload: { name: 'readFile' } }),
      makeItem({ type: 'tool_result', payload: { content: 'data' } }),
      makeItem({ type: 'file_change', payload: { path: 'a.ts' } }),
    ];
    expect(hasTurnTools(events)).toBe(true);
  });

  it('returns false when no tools exist', () => {
    const events = [makeItem({ type: 'message', payload: { chunk: 'hi' } })];
    expect(hasTurnTools(events)).toBe(false);
  });
});

describe('hasTurnVisibleBody', () => {
  it('returns false when there is no message and tools are hidden', () => {
    expect(
      hasTurnVisibleBody({
        hasVisibleMessageOrCard: false,
        hasTools: true,
        hideToolCalls: true,
      })
    ).toBe(false);
  });

  it('returns true when message prose exists', () => {
    expect(
      hasTurnVisibleBody({
        hasVisibleMessageOrCard: true,
        hasTools: true,
        hideToolCalls: true,
      })
    ).toBe(true);
  });

  it('returns true when hideToolCalls is false and tools exist', () => {
    expect(
      hasTurnVisibleBody({
        hasVisibleMessageOrCard: false,
        hasTools: true,
        hideToolCalls: false,
      })
    ).toBe(true);
  });
});

describe('lastTurnMustRerender', () => {
  it('forces the last turn to re-render only while the agent is live', () => {
    expect(lastTurnMustRerender({ isLastTurn: true, agentStatus: 'running' })).toBe(true);
    expect(lastTurnMustRerender({ isLastTurn: true, agentStatus: 'waiting' })).toBe(true);
  });

  it('lets an idle last turn memoize so image-heavy markdown does not remount every parent render', () => {
    expect(lastTurnMustRerender({ isLastTurn: true, agentStatus: 'idle' })).toBe(false);
    expect(lastTurnMustRerender({ isLastTurn: true, agentStatus: 'done' })).toBe(false);
    expect(lastTurnMustRerender({ isLastTurn: false, agentStatus: 'running' })).toBe(false);
  });
});


