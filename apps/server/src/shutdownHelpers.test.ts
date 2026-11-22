import { describe, it, expect, vi } from 'vitest';
import { awaitStopsWithBudget } from './shutdownHelpers.js';

describe('awaitStopsWithBudget', () => {
  it('returns completed when all stops finish before the budget', async () => {
    const order: string[] = [];
    const stop = async () => {
      order.push('stop');
    };
    const result = await awaitStopsWithBudget([stop()], 200);
    expect(result).toBe('completed');
    expect(order).toEqual(['stop']);
  });

  it('returns timeout when a stop hangs past the budget', async () => {
    vi.useFakeTimers();
    try {
      const hang = new Promise<void>(() => { /* never resolves */ });
      const pending = awaitStopsWithBudget([hang], 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows individual stop rejections and still completes', async () => {
    const result = await awaitStopsWithBudget(
      [Promise.reject(new Error('adapter boom')), Promise.resolve()],
      200,
    );
    expect(result).toBe('completed');
  });

  it('returns completed immediately when there are no stops', async () => {
    await expect(awaitStopsWithBudget([], 1000)).resolves.toBe('completed');
  });

  it('orders: all stops settle (or budget) before a subsequent terminate step', async () => {
    const events: string[] = [];
    const stopA = async () => {
      events.push('stopA');
    };
    const stopB = async () => {
      events.push('stopB');
    };
    await awaitStopsWithBudget([stopA(), stopB()], 200);
    events.push('terminate');
    expect(events).toEqual(['stopA', 'stopB', 'terminate']);
  });
});
