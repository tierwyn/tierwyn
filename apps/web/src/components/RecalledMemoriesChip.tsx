import { useState, useEffect } from 'react';
import type { MemoryDto } from '@tierwyn/shared';
import { api } from '../api.js';
import { recalledChipLabel } from '../memories.js';

export interface RecalledMemoriesChipProps {
  ids: string[];
  onOpenMemory?: (id: string) => void;
}

interface LoadedMemory {
  id: string;
  memory: MemoryDto | null;
  status: 'loaded' | 'deleted' | 'unavailable';
}

function formatDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

type FlagUi = 'idle' | 'busy' | 'flagged' | 'failed';

export function RecalledMemoriesChip({ ids, onOpenMemory }: RecalledMemoriesChipProps) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState<LoadedMemory[]>([]);
  const [loading, setLoading] = useState(false);
  const [flagUi, setFlagUi] = useState<Record<string, FlagUi>>({});

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);

    Promise.all(
      ids.map(async (id) => {
        try {
          const m = await api.getMemory(id);
          return { id, memory: m, status: 'loaded' as const };
        } catch (err) {
          const is404 = (err as any)?.status === 404;
          return { id, memory: null, status: is404 ? ('deleted' as const) : ('unavailable' as const) };
        }
      }),
    ).then((res) => {
      if (!cancelled) {
        setLoaded(res);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [expanded, ids]);

  if (!ids || ids.length === 0) return null;

  return (
    <div className="recall-chip-container">
      <button
        type="button"
        className="recall-chip-btn"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="recall-chip-arrow" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="recall-chip-label">{recalledChipLabel(ids)}</span>
      </button>

      {expanded && (
        <div className="recall-chip-details">
          {loading && loaded.length === 0 ? (
            <div className="recall-chip-loading">Loading recalled memories…</div>
          ) : (
            loaded.map((item) => {
              if (item.status !== 'loaded' || !item.memory) {
                const label = item.status === 'deleted' ? '(deleted)' : '(unavailable)';
                return (
                  <div key={item.id} className="recall-item-deleted">
                    <span className="recall-item-id">{item.id}</span>
                    <span className="recall-deleted-tag">{label}</span>
                  </div>
                );
              }
              const m = item.memory;
              return (
                <div key={m.id} className="recall-item-card">
                  <div className="recall-item-head">
                    <button
                      type="button"
                      className="recall-item-link"
                      onClick={() => onOpenMemory?.(m.id)}
                      title={`Open ${m.id} in Memories modal`}
                    >
                      <span className="recall-item-id">{m.id}</span>
                      <span className="recall-item-icon" aria-hidden="true">↗</span>
                    </button>
                    <span className={`mem-pill mem-pill--${m.kind}`}>{m.kind}</span>
                    <span className="recall-item-date">{formatDate(m.createdAt)}</span>
                    {flagUi[m.id] === 'flagged' || m.status === 'flagged' ? (
                      <span className="recall-item-flagged">Flagged</span>
                    ) : (
                      <button
                        type="button"
                        className="recall-item-flag"
                        disabled={flagUi[m.id] === 'busy'}
                        onClick={async () => {
                          setFlagUi((prev) => ({ ...prev, [m.id]: 'busy' }));
                          try {
                            await api.flagMemory(m.id);
                            setFlagUi((prev) => ({ ...prev, [m.id]: 'flagged' }));
                          } catch {
                            setFlagUi((prev) => ({ ...prev, [m.id]: 'failed' }));
                            window.setTimeout(() => {
                              setFlagUi((prev) => (prev[m.id] === 'failed' ? { ...prev, [m.id]: 'idle' } : prev));
                            }, 1500);
                          }
                        }}
                      >
                        {flagUi[m.id] === 'failed' ? 'Failed' : 'Not relevant'}
                      </button>
                    )}
                  </div>
                  <div className="recall-item-text">{m.text}</div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
