import { useEffect, useState } from 'react';
import type { CompactionSettings } from '@tierwyn/shared';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';
import {
  activeEdgeKeys, convLabel, decisionInfo, filterEdges, filterMessages, formatBytes, mintedByLabel, pairDetail, descLines,
  type AttemptFilter, type EdgeRow, type MsgRow,
} from '../meshView.js';

interface Props {
  settings: CompactionSettings;
  onSave: (patch: Partial<CompactionSettings>) => Promise<void> | void;
}

const awarenessOptions: SelectDropdownOption<CompactionSettings['meshAwareness']>[] = [
  { value: 'off', label: 'Off (no neighbour list)' },
  { value: 'subtree', label: 'Subtree (parent, children, siblings)' },
];

const messagingOptions: SelectDropdownOption<CompactionSettings['meshMessaging']>[] = [
  { value: 'off', label: 'Off (today\'s downward-only talk-back)' },
  { value: 'tree', label: 'Tree (adjacent peers with a minted edge)' },
];

const AWARENESS_BODY = (
  <div>
    <p>
      Agents will learn the ids, roles, and live status of their tree neighbours
      (direct parent, direct children, and siblings).
    </p>
    <p>
      A prompt-injected agent can report those ids into its transcript and to its parent.
      Ids from this list are <strong>not</strong> accepted by any write route on their own —
      minting an edge and sending a message are separate, default-off controls.
    </p>
  </div>
);

const MESSAGING_BODY = (
  <div>
    <p><strong>Agents act on these messages.</strong> A delivered peer message is treated as a prompt or a mid-turn steer.</p>
    <p><strong>A peer message to a permission-mode conversation will pause for approval; a peer message to a bypass conversation will not.</strong> Downward targets (strict descendants) still run bypass. Bypass-only adapters in a permission-mode setting cannot be woken by a peer message.</p>
    <p><strong>A delivered message cannot be retracted.</strong> Revocation is prospective only. Once a steer has accepted text it is in that model&apos;s context for the rest of the turn. Killing the session is the only retraction and it does not retract anything already acted on.</p>
    <p>
      <strong>A busy peer is not interrupted.</strong> If the target is mid-turn and cannot be steered, the message is held in a four-slot mailbox and delivered when that turn ends. A restart drops undelivered mail.
    </p>
  </div>
);

const PAGE = 30;

const attemptFilterOptions: SelectDropdownOption<AttemptFilter>[] = [
  { value: 'all', label: 'All outcomes' },
  { value: 'delivered', label: 'Delivered / queued' },
  { value: 'denied', label: 'Denied / failed' },
  { value: 'mint', label: 'Edge mints' },
];

export function MeshSettings({ settings, onSave }: Props) {
  const [pendingAwareness, setPendingAwareness] = useState<CompactionSettings['meshAwareness'] | null>(null);
  const [pendingMessaging, setPendingMessaging] = useState<CompactionSettings['meshMessaging'] | null>(null);
  const [pendingAutoOff, setPendingAutoOff] = useState(false);
  const [edges, setEdges] = useState<EdgeRow[]>([]);
  const [messages, setMessages] = useState<MsgRow[]>([]);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [attemptFilter, setAttemptFilter] = useState<AttemptFilter>('all');
  const [edgeLimit, setEdgeLimit] = useState(PAGE);
  const [msgLimit, setMsgLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    api.listMeshEdges().then((r) => setEdges(r.edges)).catch(() => setEdges([]));
    api.listMeshMessages().then((r) => setMessages(r.messages)).catch(() => setMessages([]));
  };
  useEffect(() => { reload(); }, []);

  const onAwarenessChange = (next: CompactionSettings['meshAwareness']) => {
    if (settings.meshAwareness === 'off' && next !== 'off') {
      setPendingAwareness(next);
      return;
    }
    void onSave({ meshAwareness: next });
  };
  const onMessagingChange = (next: CompactionSettings['meshMessaging']) => {
    if (settings.meshMessaging === 'off' && next !== 'off') {
      setPendingMessaging(next);
      return;
    }
    void onSave({ meshMessaging: next });
  };

  const liveEdgeCount = edges.filter((e) => !e.revokedAt).length;
  const shownEdges = filterEdges(edges, query, activeOnly ? activeEdgeKeys(messages) : null);
  const shownMessages = filterMessages(messages, query, attemptFilter);
  const onQuery = (v: string) => { setQuery(v); setEdgeLimit(PAGE); setMsgLimit(PAGE); };

  return (
    <div className="mesh-panel">
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Kill switches</span>
          </div>
        </div>
        <div className="settings-card-body" style={{ gap: 12 }}>
          <div className="modal-field">
            <span className="modal-label">Awareness</span>
            <SelectDropdown
              options={awarenessOptions}
              value={settings.meshAwareness}
              onChange={onAwarenessChange}
              placement="bottom"
            />
          </div>
          <div className="modal-field">
            <span className="modal-label">Messaging</span>
            <SelectDropdown
              options={messagingOptions}
              value={settings.meshMessaging}
              onChange={onMessagingChange}
              placement="bottom"
            />
          </div>
          <div className="modal-field modal-field-row">
            <span className="modal-label">Auto-connect spawned children</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.meshAutoEdges}
              className={`toggle-switch${settings.meshAutoEdges ? ' on' : ''}`}
              onClick={() => {
                if (settings.meshAutoEdges) {
                  setPendingAutoOff(true);
                  return;
                }
                void onSave({ meshAutoEdges: true });
              }}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="modal-field" style={{ fontStyle: 'italic', opacity: 0.7, fontSize: '12px' }}>
            Turning either control off is immediate and unconfirmed. Turning it on requires the confirmation below.
            Two ticks under one schedule home are legal pairs if you mint them — the container never runs an agent, so only you can create that edge.
          </div>
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Caps</span>
          </div>
        </div>
        <div className="settings-card-body" style={{ gap: 12 }}>
          <div className="modal-field">
            <span className="modal-label">Max peers per conversation</span>
            <input type="number" className="modal-input" min={1} max={64}
              value={settings.meshMaxPeersPerConversation}
              onChange={(e) => void onSave({ meshMaxPeersPerConversation: Number(e.target.value) })} />
          </div>
          <div className="modal-field">
            <span className="modal-label">Messages / min / edge</span>
            <input type="number" className="modal-input" min={1} max={600}
              value={settings.meshMessagesPerMinute}
              onChange={(e) => void onSave({ meshMessagesPerMinute: Number(e.target.value) })} />
          </div>
          <div className="modal-field">
            <span className="modal-label">Messages / min fleet-wide</span>
            <input type="number" className="modal-input" min={1} max={6000}
              value={settings.meshMessagesPerMinuteGlobal}
              onChange={(e) => void onSave({ meshMessagesPerMinuteGlobal: Number(e.target.value) })} />
          </div>
          <div className="modal-field">
            <span className="modal-label">Max hops</span>
            <input type="number" className="modal-input" min={1} max={3}
              value={settings.meshMaxHops}
              onChange={(e) => void onSave({ meshMaxHops: Number(e.target.value) })} />
            <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
              Chain depth, counted per causal chain (not per session). 1 = no relaying.
              2 = a coordinator may forward once. Cycles terminate at this cap.
            </div>
          </div>
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Timeouts</span>
          </div>
        </div>
        <div className="settings-card-body" style={{ gap: 12 }}>
          <div className="modal-field">
            <span className="modal-label">Spawn token idle TTL (minutes)</span>
            <input type="number" className="modal-input" min={5} max={1440}
              key={settings.spawnTokenIdleTtlMinutes} defaultValue={settings.spawnTokenIdleTtlMinutes}
              onBlur={(e) => { if (e.target.value.trim() !== '') void onSave({ spawnTokenIdleTtlMinutes: Number(e.target.value) }); }} />
            <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
              Idle backstop for ephemeral spawn bearer tokens (5–1440 min, default 30). Activity slides the window; applies to tokens minted or slid after the change.
            </div>
          </div>
          <div className="modal-field">
            <span className="modal-label">Schedule run token idle TTL (minutes)</span>
            <input type="number" className="modal-input" min={5} max={1440}
              key={settings.scheduleRunTokenIdleTtlMinutes} defaultValue={settings.scheduleRunTokenIdleTtlMinutes}
              onBlur={(e) => { if (e.target.value.trim() !== '') void onSave({ scheduleRunTokenIdleTtlMinutes: Number(e.target.value) }); }} />
            <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
              Idle backstop for schedule step API run tokens (5–1440 min, default 30). Activity slides the window; applies to tokens minted or slid after the change.
            </div>
          </div>
          <div className="modal-field">
            <span className="modal-label">Spawn stall timeout (minutes)</span>
            <input type="number" className="modal-input" min={1} max={240}
              key={settings.spawnStallTimeoutMinutes} defaultValue={settings.spawnStallTimeoutMinutes}
              onBlur={(e) => { if (e.target.value.trim() !== '') void onSave({ spawnStallTimeoutMinutes: Number(e.target.value) }); }} />
            <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
              Maximum silence in minutes before a child process is considered stalled and aborted (1–240 min, default 15).
            </div>
          </div>
        </div>
      </div>

      <div className="settings-card mesh-card mesh-search-card">
        <div className="settings-card-body mesh-search-card-body">
          <input
            type="search"
            className="modal-input mesh-search-input"
            placeholder="Search edges and attempts (title, id, outcome, error)…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search mesh edges and attempts"
          />
        </div>
      </div>

      <div className="settings-card mesh-card">
        <div className="settings-card-header mesh-card-header">
          <div className="settings-card-title-group mesh-title-group">
            <span className="settings-card-title">Edges</span>
            <span className="mesh-subtitle">
              {shownEdges.length} shown · {liveEdgeCount} live · {edges.length} total
            </span>
          </div>
          <div className="mesh-live-toggle">
            <span>Active (24h)</span>
            <button
              type="button"
              role="switch"
              aria-checked={activeOnly}
              aria-label="Only edges active in the last 24 hours"
              className={`toggle-switch${activeOnly ? ' on' : ''}`}
              onClick={() => { setActiveOnly((v) => !v); setEdgeLimit(PAGE); }}
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </div>
        <div className="settings-card-body mesh-card-body">
          {edges.length === 0 && <div className="mesh-empty-state">No edges yet.</div>}
          {edges.length > 0 && shownEdges.length === 0 && <div className="mesh-empty-state">No edges match.</div>}
          {shownEdges.slice(0, edgeLimit).map((e) => (
            <div key={e.id} className={`mesh-edge-row${e.revokedAt ? ' mesh-edge-row--revoked' : ''}`}>
              <div className="mesh-edge-content">
                <div className="mesh-edge-title">
                  {convLabel(e.fromTitle, e.fromConversation)} → {convLabel(e.toTitle, e.toConversation)}
                </div>
                {pairDetail(e) && <div className="mesh-edge-meta">{pairDetail(e)}</div>}
                {descLines(e).map((l) => <div key={l} className="mesh-edge-meta">{l}</div>)}
                <div className="mesh-edge-meta">
                  {mintedByLabel(e.mintedBy)} · {e.revokedAt ? 'revoked' : 'live'} · {new Date(e.createdAt).toLocaleString()}
                </div>
              </div>
              {!e.revokedAt && (
                <button type="button" className="mesh-revoke-btn" onClick={() => setRevokeId(e.id)}>Revoke</button>
              )}
            </div>
          ))}
          {shownEdges.length > edgeLimit && (
            <button type="button" className="mesh-more-btn" onClick={() => setEdgeLimit((n) => n + PAGE)}>
              Show more ({shownEdges.length - edgeLimit} remaining)
            </button>
          )}
        </div>
      </div>

      <div className="settings-card mesh-card">
        <div className="settings-card-header mesh-card-header">
          <div className="settings-card-title-group mesh-title-group">
            <span className="settings-card-title">Recent attempts</span>
            <span className="mesh-subtitle">
              {shownMessages.length} shown · newest {messages.length} loaded
            </span>
          </div>
          <div className="mesh-attempts-filter">
            <SelectDropdown
              options={attemptFilterOptions}
              value={attemptFilter}
              onChange={(v) => { setAttemptFilter(v); setMsgLimit(PAGE); }}
              placement="bottom"
            />
          </div>
        </div>
        <div className="settings-card-body mesh-card-body">
          {messages.length === 0 && <div className="mesh-empty-state">No attempts yet.</div>}
          {messages.length > 0 && shownMessages.length === 0 && <div className="mesh-empty-state">No attempts match.</div>}
          {shownMessages.slice(0, msgLimit).map((m) => {
            const d = decisionInfo(m.decision);
            return (
              <div key={m.id} className="mesh-attempt-row">
                <div className="mesh-attempt-header">
                  <span className={`mesh-badge mesh-badge--${d.tone}`}>{d.label}</span>
                  <span className="mesh-attempt-title">
                    {convLabel(m.fromTitle, m.fromConversation)} → {convLabel(m.toTitle, m.toConversation)}
                  </span>
                </div>
                {pairDetail(m) && <div className="mesh-attempt-meta">{pairDetail(m)}</div>}
                {descLines(m).map((l) => <div key={l} className="mesh-attempt-meta">{l}</div>)}
                <div className="mesh-attempt-meta">
                  {new Date(m.ts).toLocaleString()} · {m.callerKind}
                  {m.hop ? ` · hop ${m.hop}` : ''}
                  {m.bytes ? ` · ${formatBytes(m.bytes)}` : ''}
                  {m.durationMs ? ` · ${m.durationMs} ms` : ''}
                </div>
                {m.error && <div className="mesh-attempt-error">{m.error}</div>}
              </div>
            );
          })}
          {shownMessages.length > msgLimit && (
            <button type="button" className="mesh-more-btn" onClick={() => setMsgLimit((n) => n + PAGE)}>
              Show more ({shownMessages.length - msgLimit} remaining)
            </button>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {pendingAwareness && (
        <ConfirmDialog
          title="Turn on mesh awareness?"
          body={AWARENESS_BODY}
          confirmLabel="Turn on awareness"
          danger
          onCancel={() => setPendingAwareness(null)}
          onConfirm={() => {
            const next = pendingAwareness;
            setPendingAwareness(null);
            void onSave({ meshAwareness: next });
          }}
        />
      )}
      {pendingMessaging && (
        <ConfirmDialog
          title="Turn on mesh messaging?"
          body={liveEdgeCount > 0 ? (
            <div>
              {MESSAGING_BODY}
              <p><strong>{liveEdgeCount} existing edge{liveEdgeCount === 1 ? '' : 's'} will become active again.</strong></p>
            </div>
          ) : MESSAGING_BODY}
          confirmLabel="Turn on messaging"
          danger
          onCancel={() => setPendingMessaging(null)}
          onConfirm={() => {
            const next = pendingMessaging;
            setPendingMessaging(null);
            void onSave({ meshMessaging: next });
          }}
        />
      )}
      {pendingAutoOff && (
        <ConfirmDialog
          title="Turn off auto-connect?"
          body={
            <div>
              <p>
                <strong>Turning this off means future spawned agents will have no connections to their parent or to each other.</strong>
                {' '}They will only be able to message peers over edges you mint by hand in the Add Subagent modal.
                Agents already running keep their existing edges. You can turn this back on at any time.
              </p>
            </div>
          }
          confirmLabel="Turn off auto-connect"
          cancelLabel="Keep auto-connect"
          danger
          onCancel={() => setPendingAutoOff(false)}
          onConfirm={() => {
            setPendingAutoOff(false);
            void onSave({ meshAutoEdges: false });
          }}
        />
      )}
      {revokeId && (
        <ConfirmDialog
          title="Revoke this edge?"
          body={<p>Revocation is <strong>prospective only</strong>. Text already delivered stays in the target&apos;s context and cannot be un-said. A message already deferred in the target&apos;s mailbox can still flush when that turn ends.</p>}
          confirmLabel="Revoke"
          danger
          onCancel={() => setRevokeId(null)}
          onConfirm={() => {
            const id = revokeId;
            setRevokeId(null);
            api.revokeMeshEdge(id).then(reload).catch((err: unknown) => {
              setError(err instanceof Error ? err.message : 'revoke failed');
            });
          }}
        />
      )}
    </div>
  );
}
