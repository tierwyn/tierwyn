import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Conversation, FileBrowserListing, Project, RemoteHostView, VoiceTtsSettings } from '@tierwyn/shared';
import { api, listFiles, UnauthorizedError } from '../api.js';
import { remoteHostLabel } from '../remoteHostLabel.js';
import {
  breadcrumbs, defaultBrowserRoot, filterEntries, joinRel, parentRel, rootOptions,
  type FileBrowserRoot,
} from '../fileBrowser.js';
import { formatBytes } from './connectionQuality.js';
import { Modal } from './Modal.js';
import { FileModal } from './FileModal.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  selectedConversation: Conversation | null;
  selectedProject: Project | null;
  remoteHosts?: RemoteHostView[];
  onClose: () => void;
  onUnauthorized?: () => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
  fileEditsEnabled?: boolean;
  agentRunning?: boolean;
}

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

export function FileBrowserModal({
  selectedConversation,
  selectedProject,
  remoteHosts = [],
  onClose,
  onUnauthorized,
  tts,
  ttsSummarizeAvailable = false,
  fileEditsEnabled,
  agentRunning = false,
}: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [root, setRoot] = useState<FileBrowserRoot | null>(
    () => defaultBrowserRoot(selectedConversation, selectedProject, []),
  );
  const [dir, setDir] = useState('');
  const [listing, setListing] = useState<FileBrowserListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openFile, setOpenFile] = useState<{ path: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const reqId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((ps) => {
        if (cancelled) return;
        setProjects(ps);
        setRoot((curr) => curr ?? defaultBrowserRoot(selectedConversation, selectedProject, ps));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) onUnauthorized?.();
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setProjectsLoaded(true); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once on mount

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!root) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    listFiles({ conversationId: root.conversationId, projectId: root.projectId, path: dir })
      .then((res) => { if (id === reqId.current) setListing(res); })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
        setListing(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [root, dir, nonce, onUnauthorized]);

  const options = useMemo(() => {
    const opts = rootOptions(selectedConversation, projects);
    if (root && !opts.some((o) => o.key === root.key)) opts.unshift(root);
    return opts;
  }, [selectedConversation, projects, root]);

  const rootSelectOptions = useMemo((): SelectDropdownOption[] =>
    options.map((o) => ({ value: o.key, label: o.label })),
  [options]);

  const navigate = (next: string) => { setFilter(''); setDir(next); };
  const changeRoot = (key: string) => {
    const next = options.find((o) => o.key === key);
    if (!next) return;
    setRoot(next);
    setFilter('');
    setDir('');
    setListing(null);
  };

  const crumbs = breadcrumbs(dir, root?.label ?? '');
  const visible = listing ? filterEntries(listing.entries, filter) : [];

  const activeHostId = useMemo(() => {
    const pid = root?.conversationId ? selectedConversation?.projectId : root?.projectId;
    return pid ? projects.find((p) => p.id === pid)?.remoteHostId : undefined;
  }, [root, selectedConversation, projects]);
  const hostLabel = remoteHostLabel(activeHostId, remoteHosts);

  const subHeader = root ? (
    <div className="file-browser-subheader">
      <div className="file-browser-root-picker" role="group" aria-label="Browse root">
        <SelectDropdown
          options={rootSelectOptions}
          value={root.key}
          onChange={changeRoot}
          placement="bottom"
        />
      </div>
      <nav aria-label="Path" className="file-browser-crumbs" title={listing?.root}>
        {crumbs.map((c, i) => (
          <span key={c.path}>
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
      <input
        type="search"
        className="modal-input"
        placeholder="Filter"
        aria-label="Filter files in this folder"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
    </div>
  ) : undefined;

  let body: ReactNode;
  if (!root) {
    body = <p className="git-wt-empty">{projectsLoaded ? 'No projects yet.' : 'Loading…'}</p>;
  } else if (error) {
    body = <p className="git-wt-empty" role="alert">{error}</p>;
  } else if (!listing) {
    body = <p className="git-wt-empty">{loading ? 'Loading…' : ''}</p>;
  } else {
    body = (
      <>
        <ul className="file-browser-list" role="list">
          {dir !== '' && (
            <li>
              <button type="button" className="file-browser-row" onClick={() => navigate(parentRel(dir))}>
                <FolderIcon />
                <span className="file-browser-name">..</span>
                <span className="file-browser-meta" />
                <span className="file-browser-meta file-browser-meta--date" />
              </button>
            </li>
          )}
          {visible.map((e) => {
            const isDir = e.kind === 'dir';
            const canOpen = isDir || (e.kind === 'file' && e.openable === true);
            return (
              <li key={e.name}>
                <button
                  type="button"
                  className="file-browser-row"
                  disabled={!canOpen}
                  title={canOpen ? undefined : "Can't open this file type"}
                  onClick={() => {
                    if (isDir) navigate(joinRel(dir, e.name));
                    else setOpenFile({ path: joinRel(dir, e.name) });
                  }}
                >
                  {isDir ? <FolderIcon /> : <FileIcon />}
                  <span className="file-browser-name">{e.name}{e.symlink ? ' ↪' : ''}</span>
                  <span className="file-browser-meta">{isDir ? '' : formatBytes(e.size)}</span>
                  <span className="file-browser-meta file-browser-meta--date">
                    {e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {listing.entries.length === 0 && <p className="git-wt-empty">Empty folder</p>}
        {listing.entries.length > 0 && visible.length === 0 && <p className="git-wt-empty">No matches</p>}
        {listing.truncated && <p className="file-browser-meta">Showing first 2000 entries.</p>}
      </>
    );
  }

  return (
    <>
      <Modal
        title="File browser"
        onClose={() => { if (!openFile) onClose(); }}
        className="file-browser-modal"
        subHeader={subHeader}
        headerActions={(
          <>
            {hostLabel && <span className="host-chip" title={`Read-only — file on ${hostLabel}`}>{hostLabel}</span>}
            <button
              type="button"
              className="icon-btn"
              onClick={refetch}
              disabled={!root || loading}
              title="Refresh"
              aria-label="Refresh"
            >
              ↻
            </button>
          </>
        )}
      >
        {body}
      </Modal>
      {openFile && root && (
        <FileModal
          path={openFile.path}
          conversationId={root.conversationId}
          projectId={root.conversationId ? undefined : root.projectId}
          remoteHostName={hostLabel}
          onClose={() => { setOpenFile(null); refetch(); }}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          fileEditsEnabled={fileEditsEnabled}
          agentRunning={agentRunning && root.conversationId === selectedConversation?.id}
        />
      )}
    </>
  );
}
