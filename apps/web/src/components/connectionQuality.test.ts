import { describe, it, expect } from 'vitest';
import {
  summariseSamples, summarisePingSamples, classifyRtt, classifyRttQuality, pct,
  cpuLoadPercent, ramUsedPercent, diskUsedPercent,
  usageColor, formatBytes, formatUptime, formatMs,
  computeSparkline,
} from './connectionQuality.js';

describe('summariseSamples', () => {
  it('aggregates successful samples', () => {
    const s = summariseSamples([10, 30, 20]);
    expect(s.avg).toBe(20);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.jitter).toBe(20);
    expect(s.lossPct).toBe(0);
    expect(s.ok).toBe(3);
  });

  it('counts nulls as loss and ignores them in the average', () => {
    const s = summariseSamples([10, null, 30]);
    expect(s.avg).toBe(20);
    expect(s.lossPct).toBeCloseTo(33.33, 1);
    expect(s.ok).toBe(2);
  });

  it('handles total loss without NaN', () => {
    const s = summariseSamples([null, null, null]);
    expect(s.avg).toBeNull();
    expect(s.jitter).toBeNull();
    expect(s.lossPct).toBe(100);
  });

  it('reports no jitter from a single sample', () => {
    expect(summariseSamples([42]).jitter).toBeNull();
  });

  it('summarisePingSamples alias behaves identically', () => {
    expect(summarisePingSamples([10, 20])).toEqual(summariseSamples([10, 20]));
  });
});

describe('classifyRtt', () => {
  it('grades by latency', () => {
    expect(classifyRtt(20, 0).grade).toBe('excellent');
    expect(classifyRtt(100, 0).grade).toBe('good');
    expect(classifyRtt(200, 0).grade).toBe('fair');
    expect(classifyRtt(900, 0).grade).toBe('poor');
  });

  it('caps a fast-but-lossy link at fair', () => {
    expect(classifyRtt(20, 33).grade).toBe('fair');
  });

  it('is offline with no samples or full loss', () => {
    expect(classifyRtt(null, 100).grade).toBe('offline');
    expect(classifyRtt(10, 100).grade).toBe('offline');
  });

  it('does not upgrade a poor link because it was lossless', () => {
    expect(classifyRtt(500, 0).grade).toBe('poor');
  });

  it('classifyRttQuality alias behaves identically', () => {
    expect(classifyRttQuality(25, 0)).toEqual(classifyRtt(25, 0));
  });
});

describe('pct / usageColor / helper calculations', () => {
  it('computes and clamps', () => {
    expect(pct(50, 100)).toBe(50);
    expect(pct(200, 100)).toBe(100);
    expect(pct(1, 0)).toBeNull();
  });

  it('calculates cpu, ram, disk percentages', () => {
    expect(cpuLoadPercent(2, 4)).toBe(50);
    expect(ramUsedPercent(4, 16)).toBe(25);
    // df semantics: used / (used + available)
    expect(diskUsedPercent(50, 50)).toBe(50);
  });

  it('colours by band', () => {
    expect(usageColor(10)).toBe('var(--green)');
    expect(usageColor(80)).toBe('var(--amber)');
    expect(usageColor(95)).toBe('var(--red)');
    expect(usageColor(null)).toBe('var(--text-3)');
  });
});

describe('formatters', () => {
  it('scales bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(-1)).toBe('—');
  });
  it('formats uptime', () => {
    expect(formatUptime(90)).toBe('1m 30s');
    expect(formatUptime(3700)).toBe('1h 1m');
    expect(formatUptime(90000)).toBe('1d 1h');
  });
  it('formats latency', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(123.6)).toBe('124 ms');
    expect(formatMs(4.25)).toBe('4.3 ms');
  });
});

describe('computeSparkline', () => {
  it('returns empty paths for empty values', () => {
    const res = computeSparkline([], { fixedMin: 0, fixedMax: 100 });
    expect(res.points).toEqual([]);
    expect(res.linePath).toBe('');
    expect(res.areaPath).toBe('');
    expect(res.latest).toBeNull();
    expect(res.min).toBe(0);
    expect(res.max).toBe(100);
  });

  it('handles single sample gracefully', () => {
    const res = computeSparkline([50], { fixedMin: 0, fixedMax: 100, width: 300, height: 48, padTop: 0, padBottom: 0 });
    expect(res.points.length).toBe(1);
    expect(res.points[0].x).toBe(150);
    expect(res.points[0].y).toBe(24);
    expect(res.points[0].value).toBe(50);
    expect(res.latest?.value).toBe(50);
    expect(res.linePath).toBe('M 150.0 24.0');
    expect(res.areaPath).toBe('');
  });

  it('computes line and area paths for multi-point series', () => {
    const res = computeSparkline([0, 100], { fixedMin: 0, fixedMax: 100, width: 300, height: 50, padTop: 0, padBottom: 0 });
    expect(res.points.length).toBe(2);
    expect(res.points[0].x).toBe(0);
    expect(res.points[0].y).toBe(50);
    expect(res.points[1].x).toBe(300);
    expect(res.points[1].y).toBe(0);
    expect(res.linePath).toBe('M 0.0 50.0 L 300.0 0.0');
    expect(res.areaPath).toContain('M 0.0 50.0 L 300.0 0.0 L 300.0 50.0 L 0.0 50.0 Z');
    expect(res.latest?.value).toBe(100);
  });

  it('handles gaps (packet loss or nulls) without NaN', () => {
    const res = computeSparkline([20, null, 40], { width: 300, height: 50 });
    expect(res.points.length).toBe(3);
    expect(res.points[1].value).toBeNull();
    // Line breaks across the null sample
    expect(res.linePath).toContain('M');
    expect(res.linePath).not.toContain('NaN');
    expect(res.latest?.value).toBe(40);
  });

  it('clamps to maxPoints sliding window', () => {
    const vals = Array.from({ length: 50 }, (_, i) => i);
    const res = computeSparkline(vals, { maxPoints: 30 });
    expect(res.points.length).toBe(30);
    expect(res.points[0].value).toBe(20);
    expect(res.points[29].value).toBe(49);
  });
});

