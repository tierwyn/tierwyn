import { useEffect, useState, type FormEvent } from 'react';
import type { CompactionSettings, Conversation, MeshPeer, SpawnTemplate, Workdir } from '@tierwyn/shared';
import { api } from '../api.js';
import { SelectDropdown } from './SelectDropdown.js';

export function AddSubagentModal(props: {
  conversation: Conversation;
  template?: SpawnTemplate;
  conversationPin?: Workdir | null;
  globalDefault?: Workdir;
  onClose: () => void;
  onCreated: (child: Conversation) => void;
}) {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState(props.conversation.templateName ?? '');
  const [workdir, setWorkdir] = useState<'' | Workdir>(props.conversation.spawnWorkdir ?? '');
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [mesh, setMesh] = useState<Pick<CompactionSettings, 'meshMessaging' | 'meshMaxPeersPerConversation'> | null>(null);
  const [allowReplies, setAllowReplies] = useState(true);

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
    api.getCompaction().then((s) => {
      setMesh({ meshMessaging: s.meshMessaging, meshMaxPeersPerConversation: s.meshMaxPeersPerConversation });
    }).catch(() => setMesh(null));
    api.listMeshPeers(props.conversation.id).then((r) => setPeers(r.peers)).catch(() => setPeers([]));
  }, [props.conversation.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createConversation(
        props.conversation.projectId,
        trimmed,
        template || undefined,
        workdir || undefined,
        props.conversation.id,
      );
      props.onCreated(created);
      props.onClose();
    } catch (err) {
      setError(`Failed to create subagent: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <form
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { void submit(e); }}
      >
        <div className="modal-header">Add Subagent</div>
        <div className="modal-body">
          <div className="modal-field">
            <label className="modal-label">Subagent name</label>
            <input
              type="text"
              className="modal-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Code Reviewer, Research Assistant…"
              required
              autoFocus
              disabled={busy}
            />
            <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
              Creates an empty subagent conversation linked to this parent, ready for manual prompting.
            </div>
          </div>

          {templates.length > 0 && (
            <div className="modal-field">
              <label className="modal-label">Delegation template</label>
              <SelectDropdown
                options={[
                  { value: '', label: 'None (inherit/plain)' },
                  ...templates.map((t) => ({ value: t.name, label: t.name })),
                ]}
                value={template}
                onChange={setTemplate}
                placement="bottom"
                searchable
              />
            </div>
          )}

          <div className="modal-field">
            <label className="modal-label">Delegate workdir</label>
            <SelectDropdown
              options={[
                { value: '', label: 'Per-role (roster defaults)' },
                { value: 'shared', label: 'Pinned shared' },
                { value: 'worktree', label: 'Pinned worktree' },
              ]}
              value={workdir}
              onChange={(val) => setWorkdir(val as '' | Workdir)}
              placement="bottom"
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">
              Peers {mesh ? `(${peers.filter((p) => p.canMessage).length} / ${mesh.meshMaxPeersPerConversation} outbound)` : ''}
            </label>
            {mesh?.meshMessaging === 'off' && (
              <div className="modal-hint" style={{ opacity: 0.7, marginBottom: 8 }}>
                Mesh messaging is off — turn it on in Settings → Agent Mesh. The picker stays visible so you know where the switch lives.
              </div>
            )}
            <label className="modal-hint" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={allowReplies} onChange={(e) => setAllowReplies(e.target.checked)}
                disabled={mesh?.meshMessaging === 'off' || busy} />
              Allow replies (mint the reverse edge)
            </label>
            {peers.length === 0 && <div className="modal-hint" style={{ opacity: 0.7 }}>No tree neighbours yet.</div>}
            {peers.map((p) => (
              <div key={p.conversationId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13 }}>{p.relation} · {p.role} · {p.status}</span>
                <button
                  type="button"
                  className="modal-btn"
                  disabled={mesh?.meshMessaging === 'off' || busy || p.canMessage}
                  onClick={() => {
                    setBusy(true);
                    api.mintMeshEdge({
                      fromConversationId: props.conversation.id,
                      toConversationId: p.conversationId,
                      allowReplies,
                    }).then(() => api.listMeshPeers(props.conversation.id).then((r) => setPeers(r.peers)))
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'mint failed'))
                      .finally(() => setBusy(false));
                  }}
                >
                  {p.canMessage ? 'Linked' : 'Mint edge'}
                </button>
              </div>
            ))}
          </div>

          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="modal-btn primary" disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Add subagent'}
          </button>
        </div>
      </form>
    </div>
  );
}
