import type { NormalisedEvent } from '@tierwyn/shared';

/** Merge a freshly fetched transcript page with events already in state
 *  (live WS arrivals during the fetch, or pre-disconnect state on reconnect).
 *  Page is authoritative and comes first. A live event survives only if it is
 *  not in the page (by id) AND is not older than the page's last event —
 *  older id-bearing events not in the page are deleted/out-of-range and must
 *  not be re-appended out of order. Arrival order of survivors is kept. */
export function mergeTranscriptWithLive(page: NormalisedEvent[], live: NormalisedEvent[]): NormalisedEvent[] {
  if (live.length === 0) return page;
  const ids = new Set<string>();
  for (const e of page) if (e.id) ids.add(e.id);
  const lastTs = page.length ? page[page.length - 1]!.ts : -Infinity;
  const tail = live.filter((e) => (!e.id || !ids.has(e.id)) && e.ts >= lastTs);
  return tail.length ? [...page, ...tail] : page;
}
