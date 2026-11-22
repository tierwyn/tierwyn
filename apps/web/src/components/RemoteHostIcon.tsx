import type { CSSProperties } from 'react';

export interface RemoteHostIconProps {
  className?: string;
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

/**
 * Crisp vector SVG representation of a connected Remote Host node / satellite icon,
 * designed for seamless display in the sidebar host tree and header.
 *
 * Replaces standard browser satellite emoji (🛰) with a consistent,
 * modern vector graphic depicting an orbital satellite node with solar wings,
 * uplink dish, and telemetry downlink.
 */
export function RemoteHostIcon({
  className = 'host-icon host-icon--remote',
  width = 14,
  height = 14,
  style,
}: RemoteHostIconProps) {
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
      {/* Left solar array wing */}
      <rect
        x={1.5}
        y={5}
        width={3.5}
        height={6}
        rx={0.8}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      {/* Right solar array wing */}
      <rect
        x={11}
        y={5}
        width={3.5}
        height={6}
        rx={0.8}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      {/* Central satellite bus / chassis */}
      <rect
        x={6}
        y={4.5}
        width={4}
        height={7}
        rx={1}
        fill="currentColor"
        fillOpacity={0.18}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      {/* Solar cell grid divisions & connector struts */}
      <path
        d="M1.5 8H6M10 8H14.5"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Antenna mast and communication dish */}
      <path
        d="M8 4.5V2.5M5.5 2.5A3 3 0 0 1 10.5 2.5"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Downlink sensor and broadcast telemetry wave */}
      <path
        d="M8 11.5V13M6 13.8C6.8 14.8 9.2 14.8 10 13.8"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </svg>
  );
}
