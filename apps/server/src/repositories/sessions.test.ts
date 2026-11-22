import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import { createSession, getSession, lastSessionForConversation, setNativeSessionId, setSessionUsage, setSessionUsageInflight, getConversationUsage, applyStatusLineUsage, applyGrokSignalsUsage, applyLiveAdapterContextUsage } from './sessions.js';
import type { ConversationUsage } from '@tierwyn/shared';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, conversationId: c.id };
}

describe('sessions repository', () => {
  it('creates a session and finds the latest for a conversation', () => {
    const { db, conversationId } = setup();
    const s1 = createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    const s2 = createSession(db, { id: 's2', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    expect(getSession(db, 's1')?.id).toBe('s1');
    expect(lastSessionForConversation(db, conversationId)?.id).toBe(s2.id);
  });

  it('stores the native session id', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setNativeSessionId(db, 's1', 'native-abc');
    expect(getSession(db, 's1')?.nativeSessionId).toBe('native-abc');
  });

  it('persists tokensEstimated via setSessionUsage and surfaces it in getConversationUsage', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsage(db, 's1', { inputTokens: 42, outputTokens: 17, tokensEstimated: true });
    expect(getSession(db, 's1')?.tokensEstimated).toBe(true);
    const usage = getConversationUsage(db, conversationId);
    expect(usage.totalInputTokens).toBe(42);
    expect(usage.outputTokens).toBe(17);
    expect(usage.tokensEstimated).toBe(true);
  });

  it('setSessionUsageInflight updates token counts when still estimated', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsageInflight(db, 's1', { inputTokens: 20, outputTokens: 15 });
    const meta = getSession(db, 's1');
    expect(meta?.inputTokens).toBe(20);
    expect(meta?.outputTokens).toBe(15);
    expect(meta?.tokensEstimated).toBe(true);
  });

  it('setSessionUsageInflight does not clobber CLI-reported counts', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsage(db, 's1', {
      inputTokens: 10, outputTokens: 5, costUsd: 0.01, cacheReadTokens: 3, tokensEstimated: false,
    });
    setSessionUsageInflight(db, 's1', { inputTokens: 20, outputTokens: 15 });
    const meta = getSession(db, 's1');
    expect(meta?.inputTokens).toBe(10);
    expect(meta?.outputTokens).toBe(5);
    expect(meta?.tokensEstimated).toBe(false);
    expect(meta?.costUsd).toBe(0.01);
    expect(meta?.cacheReadTokens).toBe(3);
  });

  it('keeps a prior context_window_pct when a later turn omits it', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsage(db, 's1', { inputTokens: 10, outputTokens: 5, contextWindowPct: 32, fiveHourPct: 9 });
    createSession(db, { id: 's2', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsage(db, 's2', { inputTokens: 100, outputTokens: 20, fiveHourPct: 100, sevenDayPct: 52 });
    const usage = getConversationUsage(db, conversationId);
    expect(usage.contextWindowPct).toBe(32);
    expect(usage.fiveHourPct).toBe(100);
  });

  it('backfills contextWindowPct from the latest token breakdown when pct was omitted', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's1', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsage(db, 's1', {
      inputTokens: 2600,
      outputTokens: 500,
      cacheReadTokens: 639_139,
      cacheCreationTokens: 156_794,
      fiveHourPct: 100,
    });
    const usage = getConversationUsage(db, conversationId, { contextWindowSize: 1_000_000 });
    expect(usage.contextWindowPct).toBe(80);
    expect(usage.fiveHourPct).toBe(100);
  });

  it('does not seed rate limits from a prior agent after switching (e.g. Claude → Grok)', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's-claude', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    setSessionUsage(db, 's-claude', {
      inputTokens: 10, outputTokens: 5,
      fiveHourPct: 87, fiveHourResetsAt: 1_700_000_000_000,
      sevenDayPct: 40,
    });
    createSession(db, { id: 's-grok', conversationId, agentId: 'grok-build', agentModelId: 'grok-build:grok-4.6' });
    setSessionUsage(db, 's-grok', { inputTokens: 100, outputTokens: 20, contextWindowPct: 29 });

    const leaked = getConversationUsage(db, conversationId);
    expect(leaked.fiveHourPct).toBe(87);
    expect(leaked.contextWindowPct).toBe(29);

    const scoped = getConversationUsage(db, conversationId, { agentId: 'grok-build' });
    expect(scoped.fiveHourPct).toBeUndefined();
    expect(scoped.sevenDayPct).toBeUndefined();
    expect(scoped.contextWindowPct).toBe(29);
  });

  it('does not backfill context % from a prior agent on handoff before target runs', () => {
    const { db, conversationId } = setup();
    createSession(db, { id: 's-claude', conversationId, agentId: 'claude-code', agentModelId: 'claude-code:sonnet-4.6' });
    setSessionUsage(db, 's-claude', { inputTokens: 50_000, outputTokens: 1000 });

    createSession(db, { id: 's-deepseek', conversationId, agentId: 'deepseek', agentModelId: 'deepseek:GLM-5.3' });

    // Target agent (deepseek) has no turns yet; must not backfill from claude's tokens
    const scoped = getConversationUsage(db, conversationId, { agentId: 'deepseek', contextWindowSize: 1_000_000 });
    expect(scoped.contextWindowPct).toBeUndefined();

    // Once target agent has its own turn, backfill works for target agent
    setSessionUsage(db, 's-deepseek', { inputTokens: 100_000, outputTokens: 2000 });
    const scopedAfter = getConversationUsage(db, conversationId, { agentId: 'deepseek', contextWindowSize: 1_000_000 });
    expect(scopedAfter.contextWindowPct).toBe(10);
  });
});

describe('applyStatusLineUsage', () => {
  const base = (): ConversationUsage => ({
    inputTokens: 0, totalInputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, uncachedInputTokens: 0, cachedRatio: 0, costUsd: 0,
    isCached: false, sessionCount: 1,
  });

  it('uses the per-session context_window.used_percentage and overrides a bogus persisted value', () => {
    // Regression: a stale 1448% persisted in the session row must be replaced by
    // the live, session-scoped value from the per-session statusLine file.
    const usage = { ...base(), contextWindowPct: 1448 };
    applyStatusLineUsage(usage, {
      perSession: { context_window: { used_percentage: 49 } },
      global: { context_window: { used_percentage: 99 } },
    });
    expect(usage.contextWindowPct).toBe(49);
  });

  it('never adopts the global context_window (session-scoped, belongs to a different session)', () => {
    const usage = base();
    applyStatusLineUsage(usage, { perSession: null, global: { context_window: { used_percentage: 99 } } });
    expect(usage.contextWindowPct).toBeUndefined();
  });

  it('prefers per-session rate limits and converts resets_at seconds to epoch ms', () => {
    const usage = base();
    applyStatusLineUsage(usage, {
      perSession: {
        rate_limits: {
          five_hour: { used_percentage: 68, resets_at: 1781961600 },
          seven_day: { used_percentage: 6, resets_at: 1782446400 },
        },
      },
      global: {
        rate_limits: {
          five_hour: { used_percentage: 1, resets_at: 1700000000 },
          seven_day: { used_percentage: 1, resets_at: 1700000000 },
        },
      },
    });
    expect(usage.fiveHourPct).toBe(68);
    expect(usage.fiveHourResetsAt).toBe(1781961600000);
    expect(usage.sevenDayPct).toBe(6);
    expect(usage.sevenDayResetsAt).toBe(1782446400000);
  });

  it('falls back to the global rate limits when no per-session file exists', () => {
    // rate_limits are account-wide, so the global TUI cache is a valid fallback.
    const usage = base();
    applyStatusLineUsage(usage, {
      perSession: null,
      global: {
        rate_limits: {
          five_hour: { used_percentage: 42, resets_at: '2026-01-01T00:00:00Z' },
          seven_day: { used_percentage: 7 },
        },
      },
    });
    expect(usage.fiveHourPct).toBe(42);
    expect(usage.fiveHourResetsAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(usage.sevenDayPct).toBe(7);
    // context_window still not adopted from the global file.
    expect(usage.contextWindowPct).toBeUndefined();
  });

  it('rounds a fractional context percentage', () => {
    const usage = base();
    applyStatusLineUsage(usage, { perSession: { context_window: { used_percentage: 48.7 } }, global: null });
    expect(usage.contextWindowPct).toBe(49);
  });

  it('falls back to the global rate limits when per-session file exists but has no rate_limits', () => {
    const usage = base();
    applyStatusLineUsage(usage, {
      perSession: { context_window: { used_percentage: 50 } },
      global: {
        rate_limits: {
          five_hour: { used_percentage: 42, resets_at: '2026-01-01T00:00:00Z' },
          seven_day: { used_percentage: 7 },
        },
      },
    });
    expect(usage.fiveHourPct).toBe(42);
    expect(usage.fiveHourResetsAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(usage.sevenDayPct).toBe(7);
    expect(usage.contextWindowPct).toBe(50);
  });

  it('falls back per-window to global when per-session rate_limits lacks seven_day', () => {
    const usage = base();
    applyStatusLineUsage(usage, {
      perSession: {
        context_window: { used_percentage: 50 },
        rate_limits: { five_hour: { used_percentage: 68, resets_at: 1781961600 } },
      },
      global: {
        rate_limits: {
          five_hour: { used_percentage: 1, resets_at: 1700000000 },
          seven_day: { used_percentage: 7, resets_at: 1782446400 },
        },
      },
    });
    expect(usage.fiveHourPct).toBe(68);          // per-session wins
    expect(usage.sevenDayPct).toBe(7);           // global fills the gap
    expect(usage.sevenDayResetsAt).toBe(1782446400000);
    expect(usage.contextWindowPct).toBe(50);
  });

  it('is a no-op when both sources are absent', () => {
    const usage = base();
    applyStatusLineUsage(usage, { perSession: null, global: null });
    expect(usage.contextWindowPct).toBeUndefined();
    expect(usage.fiveHourPct).toBeUndefined();
    expect(usage.sevenDayPct).toBeUndefined();
  });

  it('does not overwrite live in-band rate limits with a stale file value', () => {
    // In-band data (from the SDK /usage control request) is freshest; the file
    // must only fill gaps, never clobber a value already present on usage.
    const usage = { ...base(), fiveHourPct: 38, fiveHourResetsAt: 111 };
    applyStatusLineUsage(usage, {
      perSession: null,
      global: { rate_limits: {
        five_hour: { used_percentage: 9, resets_at: 1700000000 },
        seven_day: { used_percentage: 7, resets_at: 1782446400 },
      } },
    });
    expect(usage.fiveHourPct).toBe(38);          // in-band preserved
    expect(usage.fiveHourResetsAt).toBe(111);    // in-band preserved
    expect(usage.sevenDayPct).toBe(7);           // file fills the empty window
  });
});

describe('applyGrokSignalsUsage', () => {
  const base = (): ConversationUsage => ({
    inputTokens: 0, totalInputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, uncachedInputTokens: 0, cachedRatio: 0, costUsd: 0,
    isCached: false, sessionCount: 1,
  });

  it('overrides a stale turn-end contextWindowPct with signals contextWindowUsage', () => {
    const usage = { ...base(), contextWindowPct: 5 };
    applyGrokSignalsUsage(usage, { contextWindowUsage: 37, contextWindowTokens: 500_000 });
    expect(usage.contextWindowPct).toBe(37);
    expect(usage.contextWindowSize).toBe(500_000);
  });

  it('derives pct from tokens used / window when usage % is absent', () => {
    const usage = base();
    applyGrokSignalsUsage(usage, { contextTokensUsed: 125_000, contextWindowTokens: 500_000 });
    expect(usage.contextWindowPct).toBe(25);
    expect(usage.contextWindowSize).toBe(500_000);
  });

  it('clamps and rounds contextWindowUsage', () => {
    const usage = base();
    applyGrokSignalsUsage(usage, { contextWindowUsage: 48.7 });
    expect(usage.contextWindowPct).toBe(49);
    applyGrokSignalsUsage(usage, { contextWindowUsage: 150 });
    expect(usage.contextWindowPct).toBe(100);
  });

  it('is a no-op when signals is null', () => {
    const usage = { ...base(), contextWindowPct: 12 };
    applyGrokSignalsUsage(usage, null);
    expect(usage.contextWindowPct).toBe(12);
  });
});

describe('applyLiveAdapterContextUsage', () => {
  const base = (): ConversationUsage => ({
    inputTokens: 0, totalInputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, uncachedInputTokens: 0, cachedRatio: 0, costUsd: 0,
    isCached: false, sessionCount: 1,
  });

  it('overrides a stale persisted contextWindowPct with live adapter occupancy', () => {
    const usage = { ...base(), contextWindowPct: 12, contextWindowSize: 200_000 };
    applyLiveAdapterContextUsage(usage, { contextWindowPct: 47, contextWindowSize: 1_000_000 });
    expect(usage.contextWindowPct).toBe(47);
    expect(usage.contextWindowSize).toBe(1_000_000);
  });

  it('is a no-op when the adapter has not captured occupancy yet this turn', () => {
    const usage = { ...base(), contextWindowPct: 12 };
    applyLiveAdapterContextUsage(usage, {});
    expect(usage.contextWindowPct).toBe(12);
  });
});
