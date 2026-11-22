import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export interface OverflowPos {
  id: string;
  triggerRect: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  };
}

function calculateMenuStyle(
  r: OverflowPos['triggerRect'],
  el: HTMLElement | null,
): CSSProperties {
  const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const winHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

  // Measure actual rendered dimensions if available; fallback to sensible bounds
  const menuW = el?.offsetWidth || 190;
  const menuH = el?.offsetHeight || 200;

  // Horizontally: align menu's right edge with the button's right edge,
  // clamped strictly within viewport margins [8, winWidth - 8].
  let left = r.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > winWidth - 8) {
    left = Math.max(8, winWidth - 8 - menuW);
  }

  const spaceBelow = winHeight - r.bottom - 8;
  const spaceAbove = r.top - 8;

  // Prefer opening downwards if there is room below (at least menuH + 4).
  // If not, flip upwards if spaceAbove allows.
  const fitsBelow = spaceBelow >= menuH + 4;
  const fitsAbove = spaceAbove >= menuH + 4;

  const style: CSSProperties = {
    position: 'fixed',
    left: `${left}px`,
    width: 'max-content',
    minWidth: '170px',
    maxWidth: 'min(280px, calc(100vw - 16px))',
    zIndex: 1001,
  };

  if (fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove)) {
    // Open downwards: anchor top directly below the button
    style.top = `${r.bottom + 4}px`;
    style.bottom = 'auto';
    style.maxHeight = `${Math.max(100, spaceBelow - 4)}px`;
  } else {
    // Open upwards: anchor bottom directly above the button
    style.bottom = `${winHeight - r.top + 4}px`;
    style.top = 'auto';
    style.maxHeight = `${Math.max(100, spaceAbove - 4)}px`;
  }

  return style;
}

export function ConvOverflowMenu({
  convId,
  pos,
  onToggle,
  onClose,
  children,
}: {
  convId: string;
  pos: OverflowPos | null;
  onToggle: (id: string, btn: HTMLElement) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const open = pos?.id === convId;
  const menuRef = useRef<HTMLDivElement>(null);

  // Compute an initial synchronous style if pos is available so the menu is
  // never mounted invisible (visibility: hidden) while waiting for layout effects.
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(() => {
    if (open && pos) {
      return calculateMenuStyle(pos.triggerRect, null);
    }
    return null;
  });

  useLayoutEffect(() => {
    if (!open || !pos) {
      setMenuStyle(null);
      return;
    }

    setMenuStyle(calculateMenuStyle(pos.triggerRect, menuRef.current));
  }, [open, pos, children]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className="conversation-actions">
      <button
        type="button"
        className="conv-action-btn conv-overflow-btn"
        aria-label="Conversation actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(convId, e.currentTarget);
        }}
        onPointerDown={(e) => {
          // Prevent touch / pointer gestures on parent row from stealing focus or triggering row select
          e.stopPropagation();
        }}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <>
            <div
              className="dropdown-backdrop"
              style={{ zIndex: 1000 }}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
            />
            <div
              ref={menuRef}
              className="session-actions-dropdown conversation-overflow-menu"
              role="menu"
              style={menuStyle ?? calculateMenuStyle(pos.triggerRect, null)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {children}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
