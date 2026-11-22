import { useState } from 'react';
import type { SandboxPath } from '@tierwyn/shared';
import { sandboxPathFromDraft } from '../sandboxControl.js';

interface Props {
  paths: SandboxPath[];
  onChange: (next: SandboxPath[]) => void;
  note?: string;
  disabled?: boolean;
}

export function SandboxPathList({ paths, onChange, note, disabled }: Props) {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'ro' | 'rw'>('ro');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const p = sandboxPathFromDraft(draft, mode);
    if (!p) {
      setError('Path must be absolute (start with /), no "..", max 512 characters.');
      return;
    }
    if (paths.some((x) => x.path === p.path)) {
      setError('Path already listed.');
      return;
    }
    if (paths.length >= 32) {
      setError('Max 32 paths.');
      return;
    }
    onChange([...paths, p]);
    setDraft('');
    setError(null);
  };

  return (
    <div className="sandbox-paths">
      {note && <div className="modal-hint">{note}</div>}
      {paths.length === 0 && (
        <div className="modal-hint" style={{ opacity: 0.7 }}>No custom paths.</div>
      )}
      {paths.map((p, i) => (
        <div key={p.path} className="sandbox-path-row">
          <code className="sandbox-path-code">{p.path}</code>
          <button
            type="button"
            className={`sandbox-mode-btn${p.mode === 'rw' ? ' rw' : ''}`}
            disabled={disabled}
            title={p.mode === 'rw' ? 'Agent can modify files here' : 'Read-only bind'}
            onClick={() => onChange(paths.map((x, j) => (
              j === i ? { ...x, mode: x.mode === 'ro' ? 'rw' : 'ro' } : x
            )))}
          >
            {p.mode}
          </button>
          <button
            type="button"
            className="modal-btn"
            disabled={disabled}
            onClick={() => onChange(paths.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="sandbox-path-add">
        <input
          type="text"
          className="modal-input"
          value={draft}
          disabled={disabled}
          placeholder="/absolute/path"
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button
          type="button"
          className={`sandbox-mode-btn${mode === 'rw' ? ' rw' : ''}`}
          disabled={disabled}
          title={mode === 'rw' ? 'Agent can modify files here' : 'Read-only bind (default)'}
          onClick={() => setMode((m) => (m === 'ro' ? 'rw' : 'ro'))}
        >
          {mode}
        </button>
        <button type="button" className="modal-btn" disabled={disabled} onClick={add}>Add</button>
      </div>
      {mode === 'rw' && (
        <div className="modal-hint sandbox-rw-hint">Read-write: the agent can modify files here.</div>
      )}
      {error && <div className="modal-field-error">{error}</div>}
    </div>
  );
}
