import { useEffect, useMemo, useState } from 'react';
import { extractOpenablePaths, isImageExtension, isSecretPath } from '@tierwyn/shared';
import { canOpenFile } from '../api.js';

interface TextPathStripProps {
  /** Draft / free text to scan for openable non-image paths. */
  text: string;
  /** Open the file modal at the given path. */
  onOpen: (path: string) => void;
  /** Active conversation — needed for relative-path resolution on GET /files. */
  conversationId?: string;
  /** Extra class (e.g. text-path-strip-desktop). */
  className?: string;
}

function iconForName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') return '📝';
  if (ext === 'json') return '🔧';
  return '📄';
}

/**
 * Badge strip of file paths mentioned in draft text. Chips only appear when
 * GET/HEAD /files confirms the path is openable (allow-list + exists + not
 * secret). The strip is height-capped with scroll so many references cannot
 * push input controls off-screen (critical on mobile).
 *
 * Intentionally inactive while the draft is a slash-command (`/…`) or shell
 * (`!…`) picker query — those popups must not share space with file chips.
 */
export function TextPathStrip({ text, onOpen, conversationId, className }: TextPathStripProps) {
  const candidates = useMemo(() => {
    // Leading / or ! is command/shell picker territory — never badge those.
    const trimmed = text.trimStart();
    if (trimmed.startsWith('/') || trimmed.startsWith('!')) return [];

    const all = extractOpenablePaths(text);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of all) {
      if (isSecretPath(p)) continue;
      const dot = p.lastIndexOf('.');
      const ext = dot < 0 ? '' : p.slice(dot + 1).toLowerCase();
      if (isImageExtension(ext)) continue; // images attach; they don't badge
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }, [text]);

  const [openable, setOpenable] = useState<string[]>([]);

  useEffect(() => {
    if (candidates.length === 0) {
      setOpenable([]);
      return;
    }

    let cancelled = false;
    const ac = new AbortController();

    // Debounce while the operator is still typing so we don't fire a probe
    // storm on every keystroke when pasting a long list of paths.
    const timer = window.setTimeout(() => {
      void (async () => {
        const results = await Promise.all(
          candidates.map(async (p) => {
            const ok = await canOpenFile(p, conversationId, ac.signal);
            return ok ? p : null;
          }),
        );
        if (cancelled) return;
        setOpenable(results.filter((p): p is string => p != null));
      })();
    }, 180);

    return () => {
      cancelled = true;
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [candidates, conversationId]);

  // Drop chips as soon as the path leaves the draft (before the next probe
  // round-trip finishes) so paste/delete never leaves stale badges.
  const candidateSet = useMemo(() => new Set(candidates), [candidates]);
  const visible = openable.filter((p) => candidateSet.has(p));

  if (visible.length === 0) return null;

  return (
    <div
      className={`text-path-strip${className ? ` ${className}` : ''}`}
      role="list"
      aria-label={`Openable file references (${visible.length})`}
    >
      {visible.map((p) => {
        const name = p.split(/[\\/]/).pop() ?? p;
        return (
          <button
            key={p}
            type="button"
            role="listitem"
            className="text-path-chip"
            title={p}
            onClick={() => onOpen(p)}
          >
            <span className="text-path-icon" aria-hidden="true">{iconForName(name)}</span>
            <span className="text-path-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
