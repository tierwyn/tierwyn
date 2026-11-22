import { useCallback, useEffect, useRef, useState, type MouseEventHandler } from 'react';
import { fileUrl } from '../api.js';

const MAX_AUTO_RETRIES = 2;
const RETRY_DELAYS_MS = [400, 900];

interface FileImageProps {
  path: string;
  conversationId?: string;
  /** Relative-path base when no conversation (e.g. schedule browser). */
  projectId?: string;
  alt: string;
  className?: string;
  onError?: (status: number | null, message: string) => void;
  /** Called once when the image bytes are ready to paint. */
  onReady?: () => void;
  /** Render nothing while loading or after failure (preview strip). */
  failQuiet?: boolean;
  /**
   * Keep the previous image visible while the next `path` loads and decodes,
   * then swap cleanly (avoids a blank loading flash in album/gallery views).
   */
  keepPrevious?: boolean;
  onClick?: MouseEventHandler<HTMLImageElement>;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; objectUrl: string; loadedPath: string }
  | { kind: 'error'; message: string; status?: number | null };

/**
 * Loads an allowlisted file via authenticated fetch and renders it from a blob
 * URL. Direct `<img src="/files?...">` can fail silently (cookies, lazy load);
 * this surfaces errors and retries instead of a broken icon.
 */
export function FileImage({ path, conversationId, projectId, alt, className, onError, onReady, failQuiet, keepPrevious, onClick }: FileImageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const objectUrlRef = useRef<string | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // Inline in fetch deps via conversationId/projectId — avoid new object each render.

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  // Always revoke any active blob URL on unmount.
  useEffect(() => revokeObjectUrl, [revokeObjectUrl]);

  useEffect(() => {
    let cancelled = false;

    const clearRetryTimer = () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const load = async (retryIndex: number) => {
      if (!keepPrevious) {
        revokeObjectUrl();
        if (!cancelled) setState({ kind: 'loading' });
      }

      try {
        const r = await fetch(
          fileUrl(path, conversationId || projectId ? { conversationId, projectId } : undefined),
          { credentials: 'include' },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        // Some proxies omit Content-Type; fall back to path extension for SVG/PNG.
        const looksImage = blob.type.startsWith('image/')
          || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path);
        if (!blob.size || !looksImage) {
          throw new Error('Empty or non-image response');
        }
        if (cancelled) return;
        const isSvg = blob.type === 'image/svg+xml' || /\.svg$/i.test(path);
        const nextUrl = isSvg
          // Security (F5): Never wrap SVG bytes in a blob: URL. A blob URL inherits
          // this page's origin, bypassing the /files endpoint's `CSP: sandbox` if
          // opened in a new tab or copied. Render direct /files URL for SVGs.
          ? fileUrl(path, conversationId || projectId ? { conversationId, projectId } : undefined)
          : URL.createObjectURL(blob);

        if (keepPrevious && !isSvg) {
          // Pre-decode offscreen so the swap has zero paint/decode flicker.
          const probe = new Image();
          probe.src = nextUrl;
          await probe.decode().catch(() => {});
          if (cancelled) {
            URL.revokeObjectURL(nextUrl);
            return;
          }
        }

        const prevBlobUrl = objectUrlRef.current;
        objectUrlRef.current = isSvg ? null : nextUrl;
        setState({ kind: 'ready', objectUrl: nextUrl, loadedPath: path });
        if (prevBlobUrl && prevBlobUrl !== nextUrl) {
          URL.revokeObjectURL(prevBlobUrl);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (!failQuiet && retryIndex < MAX_AUTO_RETRIES) {
          const delay = RETRY_DELAYS_MS[retryIndex] ?? RETRY_DELAYS_MS.at(-1)!;
          retryTimerRef.current = window.setTimeout(() => {
            if (!cancelled) void load(retryIndex + 1);
          }, delay);
          return;
        }
        const statusMatch = /HTTP (\d{3})/.exec(message);
        const status = statusMatch ? Number(statusMatch[1]) : null;
        if (keepPrevious) revokeObjectUrl();
        setState({ kind: 'error', message, status });
        onErrorRef.current?.(status, message);
      }
    };

    void load(0);

    return () => {
      cancelled = true;
      clearRetryTimer();
      if (!keepPrevious) revokeObjectUrl();
    };
  }, [path, conversationId, projectId, attempt, revokeObjectUrl, failQuiet, keepPrevious]);

  useEffect(() => {
    if (state.kind === 'ready') onReadyRef.current?.();
  }, [state]);

  const retry = () => setAttempt((n) => n + 1);

  if (state.kind === 'loading') {
    if (failQuiet) return null;
    return (
      <div className={`file-image file-image--loading ${className ?? ''}`.trim()} aria-busy="true">
        <span className="file-image-status">Loading…</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    if (failQuiet) return null;
    return (
      <div className={`file-image file-image--error ${className ?? ''}`.trim()} role="alert">
        <span className="file-image-status">Image failed ({state.message})</span>
        {state.status === 403 && (
          <span style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>This file isn't in an allowed location.</span>
        )}
        {state.status === 404 && (
          <span style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>File doesn't exist (may have been deleted).</span>
        )}
        <button type="button" className="file-image-retry" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <img
      key={keepPrevious ? state.loadedPath : undefined}
      className={className}
      src={state.objectUrl}
      alt={alt}
      onClick={onClick}
    />
  );
}
