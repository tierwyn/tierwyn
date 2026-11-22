/** FW-18 — pure helpers for Sidebar multi-select. Extracted from Sidebar.tsx
 *  purely so the locked user-facing copy and the children-only pin rule have a
 *  test: web Vitest is node-env (no jsdom), so this is the only testable seam.
 *  ponytail: everything else about select mode lives inline in Sidebar.tsx. */

export interface BulkResultRow { id: string; ok: boolean; error?: string; skipped?: string }

/** Floating-bar count. `hidden` = selected rows the current search/tag/recency
 *  filter is not rendering — they stay selected, so the count must say so. */
export function bulkCountLabel(selected: number, hidden: number): string {
  return hidden > 0
    ? `${selected} selected (${hidden} hidden by filter)`
    : `${selected} selected`;
}

/** Pin/unpin/archive/unarchive are depth-0 only (server skips spawn children),
 *  so a children-only selection has nothing to do — the bar disables those buttons. */
export function canPin(selected: { parentConversationId?: string }[]): boolean {
  return selected.some((c) => !c.parentConversationId);
}

/** `skipped` rows are neither wins nor losses — they let a toast say
 *  "Pinned 2 (skipped 1 child)" instead of lying in either direction. */
export function summariseBulkResults(
  results: BulkResultRow[],
): { okCount: number; skipCount: number; failCount: number } {
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (!r.ok) failCount += 1;
    else if (r.skipped) skipCount += 1;
    else okCount += 1;
  }
  return { okCount, skipCount, failCount };
}

export function summariseScheduleBulkResults(
  action: 'enable' | 'disable' | 'archive' | 'unarchive' | 'delete',
  results: BulkResultRow[],
): string {
  const { okCount, failCount } = summariseBulkResults(results);
  const noun = okCount === 1 ? 'schedule' : 'schedules';
  const pastAction =
    action === 'enable'
      ? 'Enabled'
      : action === 'disable'
        ? 'Disabled'
        : action === 'archive'
          ? 'Archived'
          : action === 'unarchive'
            ? 'Unarchived'
            : 'deleted';

  if (action === 'delete') {
    return failCount > 0
      ? `${okCount} ${noun} deleted; ${failCount} failed`
      : `${okCount} ${noun} deleted.`;
  }

  return failCount > 0
    ? `${pastAction} ${okCount} ${noun}; ${failCount} failed`
    : `${pastAction} ${okCount} ${noun}`;
}

