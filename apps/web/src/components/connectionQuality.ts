export type Grade = 'excellent' | 'good' | 'fair' | 'poor' | 'offline';

export interface SampleSummary {
  /** Mean of the successful samples; null when every sample was lost. */
  avg: number | null;
  min: number | null;
  max: number | null;
  /** max - min across successful samples; null when fewer than 2 succeeded. */
  jitter: number | null;
  /** 0-100. */
  lossPct: number;
  ok: number;
  total: number;
}

export function summariseSamples(samples: (number | null)[]): SampleSummary {
  const ok = samples.filter((s): s is number => s !== null && Number.isFinite(s));
  const total = samples.length;
  const lossPct = total === 0 ? 0 : ((total - ok.length) / total) * 100;
  if (ok.length === 0) return { avg: null, min: null, max: null, jitter: null, lossPct, ok: 0, total };
  const min = Math.min(...ok);
  const max = Math.max(...ok);
  return {
    avg: ok.reduce((a, b) => a + b, 0) / ok.length,
    min, max,
    jitter: ok.length > 1 ? max - min : null,
    lossPct, ok: ok.length, total,
  };
}

export const summarisePingSamples = summariseSamples;

export interface GradeInfo { grade: Grade; label: string; color: string; }

/** Thresholds: <50 excellent, <150 good, <300 fair, else poor.
 *  Any packet loss caps the grade at 'fair'; total loss is 'offline'. */
export function classifyRtt(avg: number | null, lossPct: number): GradeInfo {
  if (avg === null || lossPct >= 100) {
    return { grade: 'offline', label: 'Offline', color: 'var(--red)' };
  }
  let grade: Grade =
    avg < 50 ? 'excellent' :
    avg < 150 ? 'good' :
    avg < 300 ? 'fair' : 'poor';
  if (lossPct > 0 && (grade === 'excellent' || grade === 'good')) grade = 'fair';
  const table: Record<Grade, GradeInfo> = {
    excellent: { grade: 'excellent', label: 'Excellent', color: 'var(--green)' },
    good:      { grade: 'good',      label: 'Good',      color: 'var(--green)' },
    fair:      { grade: 'fair',      label: 'Fair',      color: 'var(--amber)' },
    poor:      { grade: 'poor',      label: 'Poor',      color: 'var(--red)' },
    offline:   { grade: 'offline',   label: 'Offline',   color: 'var(--red)' },
  };
  return table[grade];
}

export const classifyRttQuality = classifyRtt;

/** 0-100, clamped. Returns null when the denominator is unusable. */
export function pct(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

export function cpuLoadPercent(load1: number, cores: number): number | null {
  return pct(load1, cores);
}

export function ramUsedPercent(used: number, total: number): number | null {
  return pct(used, total);
}

export function diskUsedPercent(used: number, available: number): number | null {
  return pct(used, used + available);
}

/** Colour for a utilisation bar: green <70, amber <90, red above. */
export function usageColor(percent: number | null): string {
  if (percent === null) return 'var(--text-3)';
  if (percent < 70) return 'var(--green)';
  if (percent < 90) return 'var(--amber)';
  return 'var(--red)';
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** ponytail: local copy — SettingsModal has a private MB-capped formatBytes.
 *  Not refactoring that one here; this needs GB/TB for disk. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  let v = n, i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${UNITS[i]}`;
}

/** "3d 4h", "4h 12m", "12m 5s". */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

export interface SparklinePoint {
  x: number;
  y: number;
  value: number | null;
}

export interface SparklineResult {
  linePath: string;
  areaPath: string;
  points: SparklinePoint[];
  latest: SparklinePoint | null;
  min: number;
  max: number;
}

export interface SparklineOptions {
  width?: number;
  height?: number;
  maxPoints?: number;
  padTop?: number;
  padBottom?: number;
  fixedMin?: number;
  fixedMax?: number;
}

export function computeSparkline(
  values: (number | null)[],
  options: SparklineOptions = {},
): SparklineResult {
  const width = options.width ?? 300;
  const height = options.height ?? 48;
  const maxPoints = options.maxPoints ?? 30;
  const padTop = options.padTop ?? 4;
  const padBottom = options.padBottom ?? 4;
  const usableHeight = Math.max(1, height - padTop - padBottom);

  const slice = values.slice(-maxPoints);
  const N = slice.length;

  const valids = slice.filter((v): v is number => v !== null && Number.isFinite(v));

  let min = options.fixedMin !== undefined ? options.fixedMin : (valids.length > 0 ? Math.min(0, ...valids) : 0);
  let max = options.fixedMax !== undefined
    ? Math.max(options.fixedMax, ...valids)
    : (valids.length > 0 ? Math.max(10, Math.ceil(Math.max(...valids) * 1.2)) : 50);

  if (max <= min) {
    max = min + 1;
  }

  if (N === 0) {
    return { linePath: '', areaPath: '', points: [], latest: null, min, max };
  }

  const points: SparklinePoint[] = [];
  for (let i = 0; i < N; i += 1) {
    const v = slice[i];
    const x = N > 1 ? (i / (N - 1)) * width : width / 2;
    if (v === null || !Number.isFinite(v)) {
      points.push({ x, y: height - padBottom, value: null });
    } else {
      const clamped = Math.max(min, Math.min(max, v));
      const norm = (clamped - min) / (max - min);
      const y = height - padBottom - norm * usableHeight;
      points.push({ x, y, value: v });
    }
  }

  // Build linePath (handles gaps if null)
  let linePath = '';
  let inSegment = false;
  for (const pt of points) {
    if (pt.value === null) {
      inSegment = false;
      continue;
    }
    if (!inSegment) {
      linePath += `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      inSegment = true;
    } else {
      linePath += ` L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    }
  }

  // Build areaPath
  let areaPath = '';
  let segment: SparklinePoint[] = [];
  const baselineY = height - padBottom;

  const closeSegment = (seg: SparklinePoint[]) => {
    if (seg.length < 2) return '';
    let p = `M ${seg[0].x.toFixed(1)} ${seg[0].y.toFixed(1)}`;
    for (let j = 1; j < seg.length; j += 1) {
      p += ` L ${seg[j].x.toFixed(1)} ${seg[j].y.toFixed(1)}`;
    }
    p += ` L ${seg[seg.length - 1].x.toFixed(1)} ${baselineY.toFixed(1)}`;
    p += ` L ${seg[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z `;
    return p;
  };

  for (const pt of points) {
    if (pt.value === null) {
      if (segment.length > 0) {
        areaPath += closeSegment(segment);
        segment = [];
      }
    } else {
      segment.push(pt);
    }
  }
  if (segment.length > 0) {
    areaPath += closeSegment(segment);
  }

  const latest = [...points].reverse().find((p) => p.value !== null) ?? null;

  return { linePath, areaPath, points, latest, min, max };
}

