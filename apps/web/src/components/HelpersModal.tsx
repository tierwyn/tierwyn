import { useEffect, useMemo, useRef, useState } from 'react';
import { formatElapsedMs, type NormalisedEvent } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { EventItem } from './EventItem.js';
import { MarkdownBody } from './MarkdownBody.js';
import { mergeMessageChunks } from '../groupTurns.js';
import { helperThread, type HelperRun } from '../subagents.js';
import { highlightSegments } from '../commandPalette.js';

interface Props {
  runs: HelperRun[];
  events: NormalisedEvent[];
  focusKey?: string;
  highlightQuery?: string;
  canStop: boolean;
  onStop: (taskId: string) => void;
  onClose: () => void;
}

function renderHighlighted(text: string, query?: string) {
  if (!query?.trim()) return text;
  const segs = highlightSegments(text, query);
  if (segs.length === 0) return text;
  return segs.map((s, i) =>
    s.hit ? <mark key={i} className="transcript-find-hit">{s.text}</mark> : s.text
  );
}

function helperElapsed(run: HelperRun, now: number): number {
  return run.durationMs ?? ((run.endedAt ?? now) - (run.startedAt ?? now));
}

function defaultKey(runs: HelperRun[], focusKey?: string): string | undefined {
  if (focusKey && runs.some((r) => r.key === focusKey)) return focusKey;
  return runs.find((r) => r.status === 'running')?.key ?? runs[0]?.key;
}

function HelperElapsed({ run }: { run: HelperRun }) {
  const [, setTick] = useState(0);
  const running = run.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return <>{formatElapsedMs(Math.max(0, helperElapsed(run, Date.now())))}</>;
}

export function HelpersModal({ runs, events, focusKey, highlightQuery, canStop, onStop, onClose }: Props) {
  const [selectedKey, setSelectedKey] = useState(() => defaultKey(runs, focusKey));
  const [stopping, setStopping] = useState<Record<string, true>>({});
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedKey((prev) => {
      const next = defaultKey(runs, focusKey);
      if (focusKey && focusKey !== prev) return focusKey;
      if (prev && runs.some((r) => r.key === prev)) return prev;
      return next;
    });
  }, [focusKey, runs]);

  const selected = runs.find((r) => r.key === selectedKey) ?? runs[0];
  const thread = useMemo(
    () => (selected?.toolUseId ? mergeMessageChunks(helperThread(events, selected.toolUseId)) : []),
    [events, selected?.toolUseId],
  );

  useEffect(() => {
    if (!highlightQuery?.trim()) return;
    const raf = requestAnimationFrame(() => {
      const firstMark = threadRef.current?.querySelector('mark.transcript-find-hit');
      if (firstMark) firstMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightQuery, selected?.key]);

  const handleStop = (taskId: string) => {
    setStopping((s) => ({ ...s, [taskId]: true }));
    onStop(taskId);
    window.setTimeout(() => {
      setStopping((s) => {
        if (!s[taskId]) return s;
        const next = { ...s };
        delete next[taskId];
        return next;
      });
    }, 10_000);
  };

  return (
    <Modal title={`Helpers (${runs.length})`} className="helpers-modal" onClose={onClose}>
      <div className="helpers-list">
        {runs.map((r) => {
          const meta: string[] = [];
          if (r.totalTokens != null) meta.push(`${r.totalTokens} tok`);
          if (r.toolUses > 0) meta.push(`${r.toolUses} tools`);
          return (
            <button
              key={r.key}
              type="button"
              className={`helpers-list-row${r.key === selected?.key ? ' selected' : ''}`}
              style={{ paddingLeft: 10 + r.depth * 12 }}
              onClick={() => setSelectedKey(r.key)}
            >
              <span className={`subagent-dot ${r.status}`} />
              <span className="helpers-list-body">
                <span className="helpers-list-label">{r.label}</span>
                {r.description && <span className="helpers-list-desc"> · {r.description}</span>}
                <span className="helpers-list-meta">
                  {' '}· <HelperElapsed run={r} />
                  {meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="helpers-thread" ref={threadRef}>
        {selected ? (
          <>
            <div className="helpers-thread-header">
              <div>
                <strong>{renderHighlighted(selected.label, highlightQuery)}</strong>
                {selected.description && <span className="helpers-thread-desc"> · {renderHighlighted(selected.description, highlightQuery)}</span>}
                <span className={`helpers-thread-status ${selected.status}`}> · {selected.status === 'completed' ? 'done' : selected.status}</span>
              </div>
              {canStop && selected.source === 'adapter' && selected.status === 'running' && (
                <button
                  type="button"
                  className="helpers-stop-btn"
                  disabled={!!stopping[selected.key]}
                  onClick={() => handleStop(selected.key)}
                >
                  {stopping[selected.key] ? 'stopping…' : 'Stop'}
                </button>
              )}
            </div>
            {selected.prompt && (
              <details className="helpers-task">
                <summary>Task given to helper</summary>
                <div className="helpers-task-body">{renderHighlighted(selected.prompt, highlightQuery)}</div>
              </details>
            )}
            {selected.summary && (
              <div className={`helpers-result${selected.status === 'running' ? ' running' : ''}`}>
                <div className="helpers-block-label">{selected.status === 'running' ? 'Now doing' : 'Result'}</div>
                <MarkdownBody highlightQuery={highlightQuery}>{selected.summary}</MarkdownBody>
              </div>
            )}
            {thread.length === 0 ? (
              <p className="helpers-empty">No inner activity forwarded by the CLI.</p>
            ) : (
              thread.map((m, i) => (
                <EventItem key={m.event.id ?? `${m.event.seq}-${i}`} event={m.event} highlightQuery={highlightQuery} />
              ))
            )}
          </>
        ) : (
          <p className="helpers-empty">No helpers in this conversation.</p>
        )}
      </div>
    </Modal>
  );
}
