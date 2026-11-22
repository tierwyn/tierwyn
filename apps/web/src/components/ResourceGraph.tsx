import { useId, useMemo } from 'react';
import { computeSparkline } from './connectionQuality.js';

export interface ResourceGraphProps {
  title: string;
  values: (number | null)[];
  color?: string;
  unit?: string;
  fixedMin?: number;
  fixedMax?: number;
  height?: number;
  formatValue?: (val: number) => string;
  currentLabel?: string;
}

export function ResourceGraph({
  title,
  values,
  color = 'var(--accent)',
  unit = '',
  fixedMin,
  fixedMax,
  height = 48,
  formatValue = (v: number) => `${Math.round(v)}${unit}`,
  currentLabel,
}: ResourceGraphProps) {
  const width = 300;
  const spark = useMemo(
    () => computeSparkline(values, { width, height, fixedMin, fixedMax, maxPoints: 30 }),
    [values, width, height, fixedMin, fixedMax],
  );

  const gradId = useId();
  const latestVal = spark.latest?.value ?? null;
  const displayCurrent = currentLabel ?? (latestVal !== null ? formatValue(latestVal) : '—');

  const valids = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const minVal = valids.length > 0 ? Math.min(...valids) : null;
  const maxVal = valids.length > 0 ? Math.max(...valids) : null;

  return (
    <div className="conn-graph-card">
      <div className="conn-graph-header">
        <span className="conn-graph-title">{title}</span>
        <span className="conn-graph-stat">
          <strong style={{ color }}>{displayCurrent}</strong>
          {minVal !== null && maxVal !== null && valids.length > 1 && (
            <span className="conn-graph-range">
              (min {formatValue(minVal)} · max {formatValue(maxVal)})
            </span>
          )}
        </span>
      </div>

      <div className="conn-graph-svg-wrap">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="conn-graph-svg"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title} chart`}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Background reference grid */}
          <line
            x1="0"
            y1={height * 0.25}
            x2={width}
            y2={height * 0.25}
            stroke="var(--border)"
            strokeDasharray="2 3"
            strokeOpacity="0.6"
          />
          <line
            x1="0"
            y1={height * 0.75}
            x2={width}
            y2={height * 0.75}
            stroke="var(--border)"
            strokeDasharray="2 3"
            strokeOpacity="0.6"
          />

          {/* Area fill */}
          {spark.areaPath && <path d={spark.areaPath} fill={`url(#${gradId})`} />}

          {/* Line stroke */}
          {spark.linePath && (
            <path
              d={spark.linePath}
              fill="none"
              stroke={color}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Latest reading dot */}
          {spark.latest && (
            <circle
              cx={spark.latest.x}
              cy={spark.latest.y}
              r="3"
              fill={color}
              stroke="var(--surface-2)"
              strokeWidth="1.5"
            />
          )}
        </svg>

        <span className="conn-graph-y-max">{formatValue(spark.max)}</span>
        <span className="conn-graph-y-min">{formatValue(spark.min)}</span>
      </div>

      <div className="conn-graph-footer">
        <span>60s window (2s poll)</span>
        <span>{valids.length} sample{valids.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
