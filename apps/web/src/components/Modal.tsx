import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Extra class(es) on `.modal-content` (e.g. size variants). */
  className?: string;
  /** Optional extra class(es) on `.modal-overlay` (e.g. stacking z-index). */
  overlayClassName?: string;
  /** Optional actions rendered in header before the close button. */
  headerActions?: ReactNode;
  /** Optional sub-header rendered between header and body (pinned, non-scrolling). */
  subHeader?: ReactNode;
  /** Optional footer rendered outside modal-body pinned at the bottom. */
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, className, overlayClassName, headerActions, subHeader, footer }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className={['modal-overlay', 'modal-overlay--top', overlayClassName].filter(Boolean).join(' ')}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={['modal-content', className].filter(Boolean).join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header modal-header--with-close">
          <span>{title}</span>
          <div className="modal-header-actions">
            {headerActions}
            <button type="button" className="icon-btn modal-close-btn" onClick={onClose} title="Close" aria-label="Close modal">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        {subHeader}
        <div className="modal-body">
          {children}
        </div>
        {footer}
      </div>
    </div>,
    document.body
  );
}
