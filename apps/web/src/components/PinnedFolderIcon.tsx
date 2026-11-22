import type { CSSProperties } from 'react';

export interface PinnedFolderIconProps {
  className?: string;
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

/**
 * Crisp vector SVG representation of a pushpin icon, designed for seamless
 * display in the sidebar project tree matching Tierwyn's project folder icon
 * and GrokBotIcon styling (`--accent`, `--accent-dim`).
 */
export function PinnedFolderIcon({
  className = 'project-folder-icon',
  width = 16,
  height = 14,
  style,
}: PinnedFolderIconProps) {
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
      {/* Pin head and body matching folder stroke and fill */}
      <path
        d="M4.5 1.2H11.5C12 1.2 12.3 1.6 12.3 2.1C12.3 2.6 12 3 11.5 3H10.2V5.5L12.8 8.5C13.1 8.8 12.9 9.4 12.4 9.4H3.6C3.1 9.4 2.9 8.8 3.2 8.5L5.8 5.5V3H4.5C4 3 3.7 2.6 3.7 2.1C3.7 1.6 4 1.2 4.5 1.2Z"
        fill="var(--accent-dim)"
        fillOpacity={0.25}
        stroke="var(--accent)"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      {/* Pin needle */}
      <line
        x1={8}
        y1={9.4}
        x2={8}
        y2={13.5}
        stroke="var(--accent)"
        strokeWidth={1.3}
        strokeLinecap="round"
      />
    </svg>
  );
}
