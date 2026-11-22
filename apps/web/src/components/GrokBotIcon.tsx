import type { CSSProperties } from 'react';

export interface GrokBotIconProps {
  className?: string;
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

/**
 * Crisp vector SVG representation of the Grok Bot robot head icon,
 * designed for seamless display in the sidebar project tree matching
 * Tierwyn's project folder icon styling (`--accent`, `--accent-dim`).
 *
 * Captures the distinctive silhouette of Grok Bot: a smooth rounded
 * head dome with two playfully tilted pill-shaped eyes (`\ \`).
 */
export function GrokBotIcon({
  className = 'project-folder-icon',
  width = 16,
  height = 14,
  style,
}: GrokBotIconProps) {
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox="0 0 16 14"
      fill="none"
      style={{ flexShrink: 0, ...style }}
      aria-hidden
    >
      {/* Robot head container (smooth squircle matching folder stroke and fill) */}
      <path
        d="M5 1H11C12.933 1 14.5 2.567 14.5 4.5V9.5C14.5 11.433 12.933 13 11 13H5C3.067 13 1.5 11.433 1.5 9.5V4.5C1.5 2.567 3.067 1 5 1Z"
        fill="var(--accent-dim)"
        fillOpacity={0.25}
        stroke="var(--accent)"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      {/* Two tilted pill-shaped eyes with Grok Bot's signature inquisitive slant */}
      <path
        d="M5.6 5.6L6.8 9.2M9.2 4.8L10.4 8.4"
        stroke="var(--accent)"
        strokeWidth={1.3}
        strokeLinecap="round"
      />
    </svg>
  );
}
