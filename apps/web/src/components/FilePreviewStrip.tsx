import { useMemo, useState } from 'react';
import { FileImage } from './FileImage.js';
import { imagePathsForPreviewStrip } from '../markdownPaths.js';

interface FilePreviewStripProps {
  /** Full text of the turn — image paths are extracted from this. */
  text: string;
  /** Open the modal at the given path. Optionally accepts the turn's gallery paths for browsing. */
  onOpen?: (path: string, gallery?: string[]) => void;
  /** Active conversation id, forwarded to fileUrl for relative-path resolution. */
  conversationId?: string;
}

/**
 * Horizontal thumbnail strip at the bottom of an assistant turn.
 * Only files that actually load are shown. Markdown images stay inline
 * (not repeated here). Missing files omit the tile instead of a 404 box.
 */
export function FilePreviewStrip({ text, onOpen, conversationId }: FilePreviewStripProps) {
  const candidates = useMemo(() => imagePathsForPreviewStrip(text), [text]);
  const [ready, setReady] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const shown = candidates.filter((p) => ready.has(p) && !failed.has(p));

  if (!onOpen || candidates.length === 0) return null;

  return (
    <div
      className={`file-preview-strip${shown.length === 0 ? ' file-preview-strip--empty' : ''}`}
      hidden={shown.length === 0}
      aria-hidden={shown.length === 0}
    >
      {candidates.map((p) => {
        if (failed.has(p)) return null;
        const name = p.split('/').pop() ?? p;
        const isReady = ready.has(p);
        return (
          <button
            key={p}
            className="file-preview-thumb"
            title={p}
            hidden={!isReady}
            onClick={() => onOpen(p, shown)}
            type="button"
          >
            <FileImage
              path={p}
              conversationId={conversationId}
              alt={name}
              failQuiet
              onReady={() => setReady((prev) => (prev.has(p) ? prev : new Set(prev).add(p)))}
              onError={() => setFailed((prev) => (prev.has(p) ? prev : new Set(prev).add(p)))}
            />
          </button>
        );
      })}
    </div>
  );
}
