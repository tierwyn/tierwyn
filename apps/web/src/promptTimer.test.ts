import { describe, it, expect } from 'vitest';
import {
  TIMER_MIN_MINUTES, TIMER_MAX_MINUTES, TIMER_DEFAULT_MINUTES,
  TIMER_PRESET_MINUTES, TIMER_NUDGE_MINUTES,
  clampTimerMinutes, draftsFromTotal, totalFromDrafts, durationLabel,
  datetimeLocalToEpoch, epochToDatetimeLocal, countdownLabel, fireAtLabel,
  optionChipLabels, timerOriginBadge,
} from './promptTimer.js';

describe('timer bounds', () => {
  it('floors at one minute and ceilings at seven days', () => {
    expect(TIMER_MIN_MINUTES).toBe(1);
    expect(TIMER_MAX_MINUTES).toBe(7 * 24 * 60);
    expect(TIMER_DEFAULT_MINUTES).toBe(5);
  });

  it('offers the locked presets and nudges', () => {
    expect([...TIMER_PRESET_MINUTES]).toEqual([1, 5, 15, 30, 60, 180]);
    expect([...TIMER_NUDGE_MINUTES]).toEqual([5, 15, 60]);
  });
});

describe('clampTimerMinutes', () => {
  it('clamps below the floor and above the ceiling', () => {
    expect(clampTimerMinutes(0)).toBe(1);
    expect(clampTimerMinutes(-90)).toBe(1);
    expect(clampTimerMinutes(TIMER_MAX_MINUTES + 1)).toBe(TIMER_MAX_MINUTES);
  });

  it('floors fractions and rejects non-finite input', () => {
    expect(clampTimerMinutes(5.9)).toBe(5);
    expect(clampTimerMinutes(Number.NaN)).toBe(1);
    expect(clampTimerMinutes(Number.POSITIVE_INFINITY)).toBe(TIMER_MAX_MINUTES);
  });
});

describe('draftsFromTotal / totalFromDrafts', () => {
  it('splits a total into a zero-padded H : MM pair', () => {
    expect(draftsFromTotal(5)).toEqual({ hours: '0', minutes: '05' });
    expect(draftsFromTotal(90)).toEqual({ hours: '1', minutes: '30' });
    expect(draftsFromTotal(TIMER_MAX_MINUTES)).toEqual({ hours: '168', minutes: '00' });
  });

  it('carries minutes past 59 into hours', () => {
    expect(totalFromDrafts('0', '90')).toBe(90);
    expect(draftsFromTotal(totalFromDrafts('0', '90'))).toEqual({ hours: '1', minutes: '30' });
  });

  it('treats blank and junk segments as zero and clamps the result', () => {
    expect(totalFromDrafts('', '')).toBe(1);
    expect(totalFromDrafts('', '5')).toBe(5);
    expect(totalFromDrafts('abc', '5')).toBe(5);
    expect(totalFromDrafts('999', '0')).toBe(TIMER_MAX_MINUTES);
  });
});

describe('durationLabel', () => {
  it('reads in minutes, hours, or both — never in seconds or days', () => {
    expect(durationLabel(1)).toBe('1 minute');
    expect(durationLabel(5)).toBe('5 minutes');
    expect(durationLabel(60)).toBe('1 hour');
    expect(durationLabel(180)).toBe('3 hours');
    expect(durationLabel(90)).toBe('1h 30m');
    expect(durationLabel(TIMER_MAX_MINUTES)).toBe('168 hours');
  });
});

describe('datetimeLocalToEpoch / epochToDatetimeLocal', () => {
  it('parses a datetime-local value in the browser-local zone', () => {
    expect(datetimeLocalToEpoch('2026-09-18T14:30'))
      .toBe(new Date(2026, 8, 18, 14, 30, 0, 0).getTime());
  });

  it('round-trips an epoch through the input value', () => {
    const ms = new Date(2026, 8, 18, 14, 30, 0, 0).getTime();
    expect(epochToDatetimeLocal(ms)).toBe('2026-09-18T14:30');
    expect(datetimeLocalToEpoch(epochToDatetimeLocal(ms))).toBe(ms);
  });

  it('drops seconds when formatting', () => {
    const ms = new Date(2026, 8, 18, 14, 30, 45, 0).getTime();
    expect(epochToDatetimeLocal(ms)).toBe('2026-09-18T14:30');
  });

  it('returns null for empty or unparseable input', () => {
    expect(datetimeLocalToEpoch('')).toBeNull();
    expect(datetimeLocalToEpoch('not-a-date')).toBeNull();
    expect(datetimeLocalToEpoch('2026-13-45T99:99')).toBeNull();
  });
});

describe('countdownLabel', () => {
  it('renders minute precision with no seconds anywhere', () => {
    expect(countdownLabel(90_000_000)).toBe('1d 1h');   // 1500 minutes
    expect(countdownLabel(3_600_000)).toBe('1h 0m');
    expect(countdownLabel(5_400_000)).toBe('1h 30m');
    expect(countdownLabel(300_000)).toBe('5m');
    expect(countdownLabel(60_000)).toBe('1m');
  });

  it('collapses anything under a minute to <1m, including the past', () => {
    expect(countdownLabel(59_999)).toBe('<1m');
    expect(countdownLabel(0)).toBe('<1m');
    expect(countdownLabel(-5_000)).toBe('<1m');
  });
});

describe('fireAtLabel', () => {
  it('formats to the minute and never emits a seconds field', () => {
    const label = fireAtLabel(new Date(2026, 8, 18, 14, 30, 45, 0).getTime());
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('distinguishes two instants an hour apart', () => {
    const base = new Date(2026, 8, 18, 14, 30, 0, 0).getTime();
    expect(fireAtLabel(base)).not.toBe(fireAtLabel(base + 3_600_000));
  });
});

describe('optionChipLabels', () => {
  it('returns nothing for an empty or null snapshot', () => {
    expect(optionChipLabels('claude-code', null)).toEqual([]);
    expect(optionChipLabels('claude-code', {})).toEqual([]);
  });

  it('labels a boolean option as "<label> on"', () => {
    const [chip] = optionChipLabels('claude-code', { disableSlashCommands: true });
    expect(chip).toMatch(/ on$/);
  });

  it('labels a valued option as "<label>: <value>" and falls back to the raw key', () => {
    expect(optionChipLabels('claude-code', { notADescriptor: 'x' })).toEqual(['notADescriptor: x']);
  });
});

describe('timerOriginBadge', () => {
  it('hides operator timers', () => {
    expect(timerOriginBadge('operator')).toBeNull();
    expect(timerOriginBadge(undefined)).toBeNull();
  });
  it('labels agent-resume and auto-resume', () => {
    expect(timerOriginBadge('agent-resume')).toEqual({
      label: 'agent',
      title: 'Scheduled by a parent agent (deferred resume)',
    });
    expect(timerOriginBadge('auto-resume')).toEqual({
      label: 'auto',
      title: 'Scheduled by the usage-limit watcher',
    });
  });
  it('labels agent-self distinctly from agent-resume and operator', () => {
    expect(timerOriginBadge('agent-self')).toEqual({
      label: 'self',
      title: "Scheduled by this conversation's own agent (self wake-up)",
    });
    expect(timerOriginBadge('agent-resume')?.label).toBe('agent');
    expect(timerOriginBadge('operator')).toBeNull();
  });
});

