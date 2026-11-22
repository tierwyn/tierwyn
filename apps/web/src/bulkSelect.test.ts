import { describe, it, expect } from 'vitest';
import { bulkCountLabel, canPin, summariseBulkResults, summariseScheduleBulkResults } from './bulkSelect.js';

describe('bulkCountLabel', () => {
  it('reports a plain count when nothing is hidden', () => {
    expect(bulkCountLabel(3, 0)).toBe('3 selected');
    expect(bulkCountLabel(1, 0)).toBe('1 selected');
  });

  it('appends the hidden-by-filter count when rows are filtered out', () => {
    expect(bulkCountLabel(3, 1)).toBe('3 selected (1 hidden by filter)');
    expect(bulkCountLabel(12, 5)).toBe('12 selected (5 hidden by filter)');
  });

  it('never reports a negative or zero hidden count', () => {
    expect(bulkCountLabel(2, -1)).toBe('2 selected');
  });
});

describe('canPin', () => {
  it('is true when the selection contains at least one root', () => {
    expect(canPin([{ parentConversationId: 'p' }, {}])).toBe(true);
    expect(canPin([{}])).toBe(true);
  });

  it('is false for a children-only selection', () => {
    expect(canPin([{ parentConversationId: 'p' }, { parentConversationId: 'q' }])).toBe(false);
  });

  it('is false for an empty selection', () => {
    expect(canPin([])).toBe(false);
  });
});

describe('summariseBulkResults', () => {
  it('separates successes, skips and failures', () => {
    const out = summariseBulkResults([
      { id: 'a', ok: true },
      { id: 'b', ok: true, skipped: 'not a root' },
      { id: 'c', ok: false, error: 'no such conversation' },
      { id: 'd', ok: true },
    ]);
    expect(out).toEqual({ okCount: 2, skipCount: 1, failCount: 1 });
  });

  it('handles an empty result list', () => {
    expect(summariseBulkResults([])).toEqual({ okCount: 0, skipCount: 0, failCount: 0 });
  });
});

describe('summariseScheduleBulkResults', () => {
  it('formats enable and disable results', () => {
    expect(summariseScheduleBulkResults('enable', [{ id: '1', ok: true }, { id: '2', ok: true }]))
      .toBe('Enabled 2 schedules');
    expect(summariseScheduleBulkResults('enable', [{ id: '1', ok: true }]))
      .toBe('Enabled 1 schedule');
    expect(summariseScheduleBulkResults('disable', [{ id: '1', ok: true }, { id: '2', ok: false }]))
      .toBe('Disabled 1 schedule; 1 failed');
  });

  it('formats archive results', () => {
    expect(summariseScheduleBulkResults('archive', [{ id: '1', ok: true }, { id: '2', ok: true }]))
      .toBe('Archived 2 schedules');
    expect(summariseScheduleBulkResults('archive', [{ id: '1', ok: false }]))
      .toBe('Archived 0 schedules; 1 failed');
  });

  it('formats delete results', () => {
    expect(summariseScheduleBulkResults('delete', [{ id: '1', ok: true }, { id: '2', ok: true }]))
      .toBe('2 schedules deleted.');
    expect(summariseScheduleBulkResults('delete', [{ id: '1', ok: true }]))
      .toBe('1 schedule deleted.');
    expect(summariseScheduleBulkResults('delete', [{ id: '1', ok: true }, { id: '2', ok: false }]))
      .toBe('1 schedule deleted; 1 failed');
  });
});
