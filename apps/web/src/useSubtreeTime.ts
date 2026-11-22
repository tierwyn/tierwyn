import { useState, useEffect, useRef, useMemo } from 'react';
import type { SubtreeTimeSummary } from '@tierwyn/shared';
import { getSubtreeTime } from './api.js';

const CACHE_MAX = 50;
const summaryCache = new Map<string, SubtreeTimeSummary>();

function setCachedSummary(id: string, summary: SubtreeTimeSummary): void {
  summaryCache.delete(id);
  summaryCache.set(id, summary);
  while (summaryCache.size > CACHE_MAX) {
    const oldest = summaryCache.keys().next().value;
    if (oldest !== undefined) {
      summaryCache.delete(oldest);
    } else {
      break;
    }
  }
}

export function runningDescendantCount(
  s: SubtreeTimeSummary | null,
  active: ReadonlySet<string>,
): number {
  if (!s || !s.nodes) return 0;
  let count = 0;
  for (const n of s.nodes) {
    if (n.depth > 0 && active.has(n.conversationId)) {
      count++;
    }
  }
  return count;
}

export function shouldRefetchOnActiveChange(prevRunning: number, nextRunning: number): boolean {
  return nextRunning < prevRunning;
}

export function useSubtreeTime(
  conversationId: string | undefined,
  enabled: boolean,
  activeConversationIds: readonly string[] = [],
): { summary: SubtreeTimeSummary | null; runningCount: number } {
  const [summary, setSummary] = useState<SubtreeTimeSummary | null>(() => {
    return conversationId ? (summaryCache.get(conversationId) ?? null) : null;
  });

  const activeSet = useMemo(() => new Set(activeConversationIds), [activeConversationIds]);
  const runningCount = useMemo(() => runningDescendantCount(summary, activeSet), [summary, activeSet]);

  const prevConversationIdRef = useRef<string | undefined>(conversationId);
  const lastSeenConvIdRef = useRef<string | undefined>(conversationId);
  const prevEnabledRef = useRef<boolean>(enabled);
  const prevRunningCountRef = useRef<number>(runningCount);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const doFetch = (id: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ac = new AbortController();
    abortControllerRef.current = ac;

    getSubtreeTime(id, ac.signal)
      .then((data) => {
        if (ac.signal.aborted) return;
        setCachedSummary(id, data);
        setSummary(data);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || ac.signal.aborted) return;
        setSummary(null);
      });
  };

  const scheduleDebouncedFetch = (id: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      doFetch(id);
    }, 1500);
  };

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (conversationId !== prevConversationIdRef.current) {
      prevConversationIdRef.current = conversationId;
      setSummary(conversationId ? (summaryCache.get(conversationId) ?? null) : null);
      prevRunningCountRef.current = 0;
    }

    if (!conversationId) {
      setSummary(null);
      return;
    }

    doFetch(conversationId);

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;

    if (conversationId !== lastSeenConvIdRef.current) {
      lastSeenConvIdRef.current = conversationId;
      prevEnabledRef.current = enabled;
      prevRunningCountRef.current = runningCount;
      return;
    }

    const enabledFlippedTrue = enabled && !prevEnabledRef.current;
    prevEnabledRef.current = enabled;

    const runningDecreased = shouldRefetchOnActiveChange(prevRunningCountRef.current, runningCount);
    prevRunningCountRef.current = runningCount;

    if (enabled && (enabledFlippedTrue || runningDecreased)) {
      scheduleDebouncedFetch(conversationId);
    }
  }, [enabled, runningCount, conversationId]);

  return { summary, runningCount };
}
