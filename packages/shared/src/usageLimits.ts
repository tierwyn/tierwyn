/**
 * One quota-language regex shared by the claude-code adapter (benign-interrupt
 * exclusion) and the usage-watcher (layer-1 arming). Adapters must not grow
 * private copies — add quota language here once and every consumer sees it.
 * The cursor adapter deliberately keeps its own narrower fatal-stderr regex
 * (broad quota words like "credit" would latch its first-match fatal detection
 * on harmless chatter — see [S2-3]).
 */
export const QUOTA_SHAPE =
  /usage limit|rate.?limit|quota|credit|billing|overloaded|capacity|529|too many requests|quota exceeded|hit your session limit/i;

export function matchesQuotaShape(text: string): boolean {
  return QUOTA_SHAPE.test(text);
}
