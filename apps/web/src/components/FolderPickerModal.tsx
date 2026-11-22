import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProjectBrowseListing } from '@tierwyn/shared';
import { api } from '../api.js';
import { breadcrumbs, parentRel } from '../fileBrowser.js';
import { initialBrowseLocation, joinAbs, rootLabel, visibleDirs } from '../folderPicker.js';
import { Modal } from './Modal.js';

const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export interface FolderPickerModalProps {
  remoteHostId?: string;
  roots: string[];
  homedir?: string;
  initialPath: string;
  onPick(absPath: string): void;
  onClose(): void;
}

export function FolderPickerModal({
  remoteHostId,
  roots,
  homedir,
  initialPath,
  onPick,
  onClose,
}: FolderPickerModalProps) {
  const initial = useMemo(() => initialBrowseLocation(initialPath, roots), [initialPath, roots]);
  const [root, setRoot] = useState<string>(initial.root || roots[0] || '');
  const [rel, setRel] = useState<string>(initial.rel);
  const [listing, setListing] = useState<ProjectBrowseListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listProjectDirs({ remoteHostId, root, path: rel })
      .then((data) => {
        if (cancelled) return;
        setListing(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [remoteHostId, root, rel]);

  const currentDir = joinAbs(root, rel);
  const currentRootLabel = rootLabel(root, homedir);
  const crumbs = breadcrumbs(rel, currentRootLabel);
  const visible = listing ? visibleDirs(listing.dirs, showHidden, filter) : [];

  const trimmedNewName = newFolderName.trim();
  const canUseNewFolder =
    trimmedNewName !== '' &&
    !trimmedNewName.includes('/') &&
    trimmedNewName !== '.' &&
    trimmedNewName !== '..';

  const navigate = (nextRel: string) => {
    setRel(nextRel);
    setFilter('');
    setNewFolderName('');
  };

  const handlePickCurrent = () => {
    onPick(currentDir);
    onClose();
  };

  const handlePickNew = () => {
    if (!canUseNewFolder) return;
    onPick(joinAbs(root, rel, trimmedNewName));
    onClose();
  };

  const subHeader = (
    <div className="file-browser-subheader">
      {roots.length > 1 && (
        <select
          className="modal-input"
          value={root}
          onChange={(e) => {
            setRoot(e.target.value);
            navigate('');
          }}
          aria-label="Root folder"
          style={{ maxWidth: 180 }}
        >
          {roots.map((r) => (
            <option key={r} value={r}>
              {rootLabel(r, homedir)}
            </option>
          ))}
        </select>
      )}
      <nav aria-label="Path" className="file-browser-crumbs" title={currentDir}>
        {crumbs.map((c, i) => (
          <span key={c.path || 'root'}>
            {i > 0 && <span className="file-browser-crumb-sep">/</span>}
            <button
              type="button"
              onClick={() => navigate(c.path)}
              aria-current={i === crumbs.length - 1 ? 'page' : undefined}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
        />
        Show hidden
      </label>
      <input
        type="search"
        className="modal-input"
        placeholder="Filter"
        aria-label="Filter folders"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ maxWidth: 140 }}
      />
    </div>
  );

  let body: ReactNode;
  if (error) {
    body = <p className="git-wt-empty" role="alert" style={{ color: 'var(--red, #e55)' }}>{error}</p>;
  } else if (loading && !listing) {
    body = <p className="git-wt-empty">Loading…</p>;
  } else {
    body = (
      <ul className="file-browser-list" role="list">
        {rel !== '' && (
          <li>
            <button
              type="button"
              className="file-browser-row"
              onClick={() => navigate(parentRel(rel))}
            >
              <FolderIcon />
              <span className="file-browser-name">..</span>
              <span className="file-browser-meta" />
            </button>
          </li>
        )}
        {visible.map((entry) => (
          <li key={entry.name}>
            <button
              type="button"
              className="file-browser-row"
              onClick={() => navigate(rel ? `${rel}/${entry.name}` : entry.name)}
            >
              <FolderIcon />
              <span className="file-browser-name">{entry.name}</span>
              <span className="file-browser-meta">
                {entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleDateString() : ''}
              </span>
            </button>
          </li>
        ))}
        {visible.length === 0 && (
          <li style={{ padding: '16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            {filter ? 'No matching folders' : 'No subfolders'}
          </li>
        )}
      </ul>
    );
  }

  const footer = (
    <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text"
          className="modal-input"
          placeholder="New folder name"
          aria-label="New folder name"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handlePickNew();
            }
          }}
          style={{ width: 160 }}
        />
        <button
          type="button"
          className="modal-btn"
          disabled={!canUseNewFolder}
          onClick={handlePickNew}
        >
          Use new folder here
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn primary"
          onClick={handlePickCurrent}
        >
          Use this folder
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      title="Browse Folders"
      onClose={onClose}
      className="file-browser-modal"
      overlayClassName="modal-overlay--stack-2"
      subHeader={subHeader}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
