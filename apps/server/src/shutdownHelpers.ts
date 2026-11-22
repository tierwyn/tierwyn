/**
 * Await stop promises up to `budgetMs` so session end broadcasts can flush
 * before WebSocket clients are terminated. Never hangs: budget always wins.
 * Individual rejections are swallowed so one hung adapter does not block others.
 */
export async function awaitStopsWithBudget(
  stops: Promise<unknown>[],
  budgetMs: number,
): Promise<'completed' | 'timeout'> {
  if (stops.length === 0) return 'completed';
  return Promise.race([
    Promise.all(stops.map((p) => Promise.resolve(p).catch(() => {}))).then(
      () => 'completed' as const,
    ),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), budgetMs);
    }),
  ]);
}
