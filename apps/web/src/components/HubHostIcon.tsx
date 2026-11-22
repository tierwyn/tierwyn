import type { CSSProperties } from 'react';

export interface HubHostIconProps {
  className?: string;
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

/**
 * Crisp vector SVG representation of the local/central Hub machine icon,
 * designed for seamless display in the sidebar host tree and header.
 *
 * Replaces standard browser desktop computer emoji (🖥) with a consistent,
 * modern vector graphic depicting a central hub terminal workstation.
 */
export function HubHostIcon({
  className = 'host-icon host-icon--hub',
  width = 14,
  height = 14,
  style,
}: HubHostIconProps) {
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      style={{ flexShrink: 0, ...style }}
      aria-hidden
    >
      {/* Screen frame */}
      <rect
        x={1.5}
        y={2}
        width={13}
        height={9}
        rx={1.5}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      {/* Stand neck and base */}
      <path
        d="M8 11V13.5M4.5 13.5H11.5"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Terminal prompt inside screen */}
      <path
        d="M4.5 5L6.5 6.5L4.5 8M8.5 8H11"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
