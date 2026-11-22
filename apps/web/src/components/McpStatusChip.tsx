import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ConversationMcpView,
  McpControlAction,
  McpLiveStatus,
  McpNativeView,
  McpServerDef,
} from '@tierwyn/shared';
import { MCP_INJECTABLE_ADAPTERS, mcpAgentCapability } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  describeSkipReason,
  getMcpSelectionMode,
  statusSeverity,
  summariseChipLabel,
} from '../mcpView.js';

export interface McpStatusChipProps {
  conversationId?: string;
  agentType?: string;
  profileId?: string;
  projectId?: string;
  hasLiveSession?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onMcpServersChange?: (mcpServers: string[] | null) => void;
}

const PANEL_GAP = 8;
const VIEWPORT_PAD = 8;

function McpStatusChipInner({
  conversationId,
  agentType,
  profileId,
  projectId,
  hasLiveSession = false,
  disabled = false,
  compact = false,
  onMcpServersChange,
}: McpStatusChipProps) {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<McpLiveStatus[] | null>(null);
  const [convMcp, setConvMcp] = useState<ConversationMcpView | null>(null);
  const [registryServers, setRegistryServers] = useState<McpServerDef[]>([]);
  const [nativeView, setNativeView] = useState<McpNativeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number }>({
    left: 0,
    width: 420,
  });

  const isInjectable = Boolean(agentType && MCP_INJECTABLE_ADAPTERS.has(agentType));
  const capability = agentType ? mcpAgentCapability(agentType) : undefined;
  /** Native overrides are stored on the conversation but only some adapters enforce them. */
  const nativeEnforced = capability?.nativeOverrides === 'enforced';
  const canQueryLive = agentType === 'claude-code' && hasLiveSession;

  const fetchConvSummary = useCallback(async () => {
    if (!conversationId || !agentType || !MCP_INJECTABLE_ADAPTERS.has(agentType)) {
      setConvMcp(null);
      return;
    }
    try {
      const view = await api.getConversationMcp(conversationId, { agentType, profileId });
      setConvMcp(view);
    } catch {
      // Non-fatal in background pill refresh
    }
  }, [conversationId, agentType, profileId]);

  const fetchAll = useCallback(async () => {
    if (!conversationId || !agentType) return;
    try {
      setLoading(true);
      setError(null);
      const tasks: Promise<unknown>[] = [
        api.listMcpServers().then((r) => setRegistryServers(r.servers)).catch(() => {}),
        api.getNativeMcp(agentType, projectId).then((v) => setNativeView(v)).catch(() => setNativeView(null)),
      ];
      if (MCP_INJECTABLE_ADAPTERS.has(agentType)) {
        tasks.push(
          api.getConversationMcp(conversationId, { agentType, profileId }).then((v) => setConvMcp(v)),
        );
      } else {
        setConvMcp(null);
      }
      if (agentType === 'claude-code' && hasLiveSession) {
        tasks.push(
          api
            .getMcpStatus(conversationId)
            .then((res) => setStatuses(res.statuses))
            .catch(() => {
              // Session ended or parked without a live query — not a user-facing error
              setStatuses(null);
            }),
        );
      } else {
        setStatuses(null);
      }
      await Promise.all(tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [conversationId, agentType, profileId, projectId, hasLiveSession]);

  useEffect(() => {
    void fetchConvSummary();
  }, [fetchConvSummary]);

  useEffect(() => {
    if (!canQueryLive) {
      setStatuses(null);
    }
  }, [canQueryLive]);

  useEffect(() => {
    if (open) {
      void fetchAll();
    }
  }, [open, fetchAll]);

  const handleOpen = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
  };

  const handleUpdateSelection = async (nextMcpServers: string[] | null) => {
    if (!conversationId) return;
    try {
      setSavingSelection(true);
      setError(null);
      await api.updateConversation(conversationId, { mcpServers: nextMcpServers });
      onMcpServersChange?.(nextMcpServers);
      if (agentType && MCP_INJECTABLE_ADAPTERS.has(agentType)) {
        const view = await api.getConversationMcp(conversationId, { agentType, profileId });
        setConvMcp(view);
      }
      if (agentType === 'claude-code' && hasLiveSession) {
        await api
          .getMcpStatus(conversationId)
          .then((r) => setStatuses(r.statuses))
          .catch(() => setStatuses(null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSelection(false);
    }
  };

  const handleToggleServer = (serverId: string, currentlyChecked: boolean) => {
    const currentSet = new Set<string>(convMcp?.selected ?? convMcp?.inherited ?? []);
    if (currentlyChecked) {
      currentSet.delete(serverId);
    } else {
      currentSet.add(serverId);
    }
    void handleUpdateSelection([...currentSet]);
  };

  const handleUpdateNativeOverrides = async (disableNative: boolean, disabledNative: string[]) => {
    if (!conversationId) return;
    try {
      setSavingSelection(true);
      setError(null);
      await api.updateConversation(conversationId, {
        disableNativeMcp: disableNative,
        disabledNativeMcp: disabledNative,
      });
      if (agentType && MCP_INJECTABLE_ADAPTERS.has(agentType)) {
        const view = await api.getConversationMcp(conversationId, { agentType, profileId });
        setConvMcp(view);
      }
      if (agentType === 'claude-code' && hasLiveSession) {
        await api
          .getMcpStatus(conversationId)
          .then((r) => setStatuses(r.statuses))
          .catch(() => setStatuses(null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSelection(false);
    }
  };

  const handleToggleNativeServer = (serverName: string, currentlyChecked: boolean) => {
    const isAllDisabled = convMcp?.disableNative === true;
    const currentDisabled = new Set<string>(convMcp?.disabledNative ?? []);
    if (isAllDisabled) {
      const allNativeNames = nativeView?.entries.map((e) => e.name) ?? [];
      const nextDisabled = allNativeNames.filter((n) => n !== serverName);
      void handleUpdateNativeOverrides(false, nextDisabled);
      if (agentType === 'claude-code' && hasLiveSession) {
        void handleControl(serverName, 'enable');
      }
      return;
    }

    if (currentlyChecked) {
      currentDisabled.add(serverName);
      if (agentType === 'claude-code' && hasLiveSession) {
        void handleControl(serverName, 'disable');
      }
    } else {
      currentDisabled.delete(serverName);
      if (agentType === 'claude-code' && hasLiveSession) {
        void handleControl(serverName, 'enable');
      }
    }
    void handleUpdateNativeOverrides(false, [...currentDisabled]);
  };

  const handleControl = async (name: string, action: McpControlAction) => {
    if (!conversationId) return;
    const key = `${name}:${action}`;
    try {
      setBusyAction(key);
      setError(null);
      await api.mcpControl(conversationId, name, action);
      if (agentType === 'claude-code' && hasLiveSession) {
        const res = await api.getMcpStatus(conversationId);
        setStatuses(res.statuses);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const desiredWidth = 420;
    const popoverWidth = Math.min(Math.max(desiredWidth, rect.width), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8));

    const spaceAbove = rect.top - PANEL_GAP - VIEWPORT_PAD;
    const spaceBelow = window.innerHeight - rect.bottom - PANEL_GAP - VIEWPORT_PAD;

    if (spaceAbove >= 220 || spaceAbove > spaceBelow) {
      setPos({
        bottom: window.innerHeight - rect.top + PANEL_GAP,
        left,
        width: popoverWidth,
      });
    } else {
      setPos({
        top: rect.bottom + PANEL_GAP,
        left,
        width: popoverWidth,
      });
    }
  }, [open, statuses, convMcp, registryServers, nativeView, loading, error]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Must stay AFTER every hook: an early return above a hook changes the hook count when
  // agentType/hasLiveSession flip on conversation load ("Rendered more hooks…" → white screen).
  if (!conversationId || !agentType || agentType === 'grok-bot') {
    return null;
  }

  const chipSummary = summariseChipLabel(
    statuses,
    convMcp?.effective,
    convMcp?.selected,
    nativeEnforced ? convMcp?.disableNative : false,
    nativeEnforced ? convMcp?.disabledNative : [],
  );
  const isModified = Boolean(convMcp?.modified ?? chipSummary.isModified);
  const chipLabel = chipSummary.label;
  const selectionMode = getMcpSelectionMode(convMcp?.selected);
  const selectedIds = new Set<string>(convMcp?.selected ?? convMcp?.inherited ?? []);
  const effectiveMap = new Map((convMcp?.effective ?? []).map((e) => [e.id, e]));

  const popover = open
    ? createPortal(
        <div
          ref={panelRef}
          className="mcp-status-popover"
          style={{
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            width: pos.width,
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: 'min(78vh, 520px)',
            overflowY: 'auto',
          }}
          role="dialog"
          aria-label="MCP Servers"
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>
              MCP Servers · {agentType}
            </span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                className="icon-btn"
                style={{ padding: 3 }}
                disabled={loading || savingSelection}
                onClick={() => void fetchAll()}
                title="Refresh MCP servers"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
              </button>
              <button
                type="button"
                className="icon-btn"
                style={{ padding: 3 }}
                onClick={() => setOpen(false)}
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>

          {error && <div className="usage-error" style={{ margin: 0 }}>{error}</div>}

          {/* Section 1: Pre-prompt / Conversation Registry Selection */}
          {isInjectable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
                  Conversation Selection
                </span>
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <button
                    type="button"
                    className={`modal-btn${selectionMode === 'inherit' ? ' primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 7px' }}
                    disabled={savingSelection}
                    onClick={() => void handleUpdateSelection(null)}
                    title="Use template default MCP servers"
                  >
                    Default
                  </button>
                  {registryServers.length > 0 && (
                    <button
                      type="button"
                      className={`modal-btn${
                        selectionMode === 'custom' &&
                        selectedIds.size === registryServers.filter((s) => s.enabled).length &&
                        selectedIds.size > 0
                          ? ' primary'
                          : ''
                      }`}
                      style={{ fontSize: 10, padding: '2px 7px' }}
                      disabled={savingSelection}
                      onClick={() =>
                        void handleUpdateSelection(
                          registryServers.filter((s) => s.enabled).map((s) => s.id),
                        )
                      }
                      title="Enable all registered MCP servers for this conversation"
                    >
                      All
                    </button>
                  )}
                  <button
                    type="button"
                    className={`modal-btn${selectionMode === 'none' ? ' primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 7px' }}
                    disabled={savingSelection}
                    onClick={() => void handleUpdateSelection([])}
                    title="Disable all registry MCP servers for this conversation"
                  >
                    Off
                  </button>
                </div>
              </div>

              {registryServers.length === 0 ? (
                <div
                  className="modal-hint mcp-hint-box"
                >
                  No servers in Tierwyn MCP Registry yet. Open <strong>Settings → MCP Servers</strong> to add one or click <strong>Import</strong> on any native server below.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                  {registryServers.map((s) => {
                    const checked = selectedIds.has(s.id);
                    const eff = effectiveMap.get(s.id);
                    return (
                      <label
                        key={s.id}
                        className={`mcp-server-row${checked ? ' is-selected' : ''}`}
                        style={{
                          cursor: savingSelection ? 'wait' : 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={savingSelection}
                              onChange={() => handleToggleServer(s.id, checked)}
                              style={{ flexShrink: 0 }}
                            />
                            <span
                              style={{
                                fontWeight: 600,
                                color: 'var(--text-1)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={s.id}
                            >
                              {s.id}
                            </span>
                            <span className="mcp-server-badge">
                              {s.transport}
                            </span>
                            {!s.enabled && (
                              <span style={{ fontSize: 10, color: 'var(--red, #ef4444)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                                disabled
                              </span>
                            )}
                          </div>
                          {checked && eff && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '1px 5px',
                                borderRadius: 4,
                                background: eff.injected
                                  ? 'rgba(16, 185, 129, 0.15)'
                                  : 'rgba(245, 158, 11, 0.15)',
                                color: eff.injected
                                  ? 'var(--green, #10b981)'
                                  : 'var(--amber, #f59e0b)',
                                flexShrink: 0,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {eff.injected ? 'injected' : 'skipped'}
                            </span>
                          )}
                        </div>
                        {checked && eff && !eff.injected && eff.reason && (
                          <div style={{ fontSize: 10, color: 'var(--text-3)', paddingLeft: 20 }}>
                            {describeSkipReason(eff.reason)}
                          </div>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}

              {convMcp?.delegating && (
                <div style={{ fontSize: 10, color: 'var(--amber, #f59e0b)' }}>
                  Delegating profile: only servers with &ldquo;Allow in delegating chats&rdquo; are injected.
                </div>
              )}
            </div>
          ) : (
            <div className="modal-hint" style={{ padding: '4px 0' }}>
              {agentType} uses native CLI MCP configuration only — Tierwyn registry servers are not injected.
              {capability?.notes ? ` ${capability.notes}` : ''}
            </div>
          )}

          {/* Section 2: Native MCP Servers active for this project */}
          {nativeView && nativeView.entries.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                borderTop: '1px solid var(--border)',
                paddingTop: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
                  Native CLI Config
                </span>
                {nativeEnforced && <div style={{ display: 'inline-flex', gap: 4 }}>
                  <button
                    type="button"
                    className={`modal-btn${!convMcp?.disableNative && (!convMcp?.disabledNative || convMcp.disabledNative.length === 0) ? ' primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 7px' }}
                    disabled={savingSelection}
                    onClick={() => void handleUpdateNativeOverrides(false, [])}
                    title="Enable all native CLI MCP servers for this conversation"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`modal-btn${convMcp?.disableNative ? ' primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 7px' }}
                    disabled={savingSelection}
                    onClick={() => void handleUpdateNativeOverrides(true, [])}
                    title="Disable all native CLI MCP servers for this conversation"
                  >
                    Off
                  </button>
                </div>}
              </div>

              {!nativeEnforced && (
                <div className="modal-hint" style={{ fontSize: 10 }}>
                  Preview only — {agentType} loads these itself; Tierwyn overrides are not enforced.
                </div>
              )}

              {nativeEnforced && convMcp?.disableNative && (
                <div style={{ fontSize: 10, color: 'var(--amber, #f59e0b)' }}>
                  Native CLI MCPs are disabled for this conversation.
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                {nativeView.entries.map((entry, idx) => {
                  // Not enforced → the agent loads every entry regardless of stored overrides.
                  const isChecked = !nativeEnforced || (!convMcp?.disableNative && !(convMcp?.disabledNative ?? []).includes(entry.name));
                  return (
                    <label
                      key={`${entry.name}-${idx}`}
                      className={`mcp-server-row mcp-server-row--single${isChecked ? ' is-selected' : ''}`}
                      style={{
                        cursor: !nativeEnforced ? 'default' : savingSelection ? 'wait' : 'pointer',
                        opacity: nativeEnforced && convMcp?.disableNative ? 0.6 : 1,
                      }}
                      title={nativeEnforced ? undefined : `${agentType} loads this server from its own config; Tierwyn cannot disable it.`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' }}>
                        {nativeEnforced ? (
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={savingSelection}
                            onChange={() => handleToggleNativeServer(entry.name, isChecked)}
                            style={{ flexShrink: 0 }}
                          />
                        ) : (
                          <span className="mcp-server-badge" style={{ flexShrink: 0 }}>loaded by agent</span>
                        )}
                        <span
                          style={{
                            fontWeight: 500,
                            color: isChecked ? 'var(--text-1)' : 'var(--text-3)',
                            textDecoration: isChecked ? 'none' : 'line-through',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={entry.name}
                        >
                          {entry.name}
                        </span>
                        {!isChecked && (
                          <span style={{ fontSize: 9, color: 'var(--amber, #f59e0b)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                            disabled
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{entry.transport}</span>
                        <span className="mcp-server-badge">
                          {entry.scope}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 3: Live Session Status & Controls (Claude Code while turn is running) */}
          {statuses && statuses.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                borderTop: '1px solid var(--border)',
                paddingTop: 8,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
                Live Session Controls
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                {statuses.map((s) => {
                  const sev = statusSeverity(s.status);
                  const isBusy = busyAction?.startsWith(`${s.name}:`);
                  const statusColor =
                    sev === 'success'
                      ? 'var(--green, #10b981)'
                      : sev === 'danger'
                      ? 'var(--red, #ef4444)'
                      : sev === 'warning'
                      ? 'var(--amber, #f59e0b)'
                      : 'var(--text-3)';
                  const statusBg =
                    sev === 'success'
                      ? 'rgba(16, 185, 129, 0.12)'
                      : sev === 'danger'
                      ? 'rgba(239, 68, 68, 0.12)'
                      : sev === 'warning'
                      ? 'rgba(245, 158, 11, 0.12)'
                      : 'var(--surface-3)';

                  return (
                    <div
                      key={s.name}
                      className="mcp-server-card"
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' }}>
                          <span
                            style={{
                              fontWeight: 600,
                              color: 'var(--text-1)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={s.name}
                          >
                            {s.name}
                          </span>
                          <span className="mcp-server-badge">
                            {s.source}
                          </span>
                          {s.toolCount !== undefined && (
                            <span
                              style={{
                                fontSize: 10,
                                color: 'var(--text-3)',
                                flexShrink: 0,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {s.toolCount} tools
                            </span>
                          )}
                        </div>

                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '1px 6px',
                            borderRadius: 4,
                            color: statusColor,
                            background: statusBg,
                            textTransform: 'uppercase',
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                            letterSpacing: '0.02em',
                          }}
                        >
                          {s.status}
                        </span>
                      </div>

                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center', marginTop: 2 }}>
                        {s.status === 'disabled' ? (
                          <button
                            type="button"
                            className="modal-btn primary"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            disabled={isBusy}
                            onClick={() => void handleControl(s.name, 'enable')}
                          >
                            {isBusy ? '…' : 'Enable'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="modal-btn"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            disabled={isBusy}
                            onClick={() => void handleControl(s.name, 'disable')}
                          >
                            {isBusy ? '…' : 'Disable'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="modal-btn"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          disabled={isBusy}
                          onClick={() => void handleControl(s.name, 'reconnect')}
                        >
                          {isBusy ? '…' : 'Reconnect'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div
            className="modal-hint"
            style={{ fontSize: 11, fontStyle: 'italic', borderTop: '1px solid var(--border)', paddingTop: 6 }}
          >
            {statuses && statuses.length > 0
              ? 'Checkboxes persist for this conversation; live Enable/Disable/Reconnect apply to the running turn.'
              : 'Select MCP servers before sending your prompt. Manage registry in Settings → MCP Servers.'}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`prompt-options-pill ${
          chipSummary.activeCount > 0 || open ? 'is-active' : 'prompt-options-pill-idle'
        }${isModified ? ' prompt-options-pill-armed mcp-pill-modified' : ''}`}
        title={
          isModified
            ? 'MCP rules modified for this conversation (pinned)'
            : 'Configure and inspect MCP servers for this conversation'
        }
        disabled={disabled}
        onClick={handleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
          <line x1="6" y1="6" x2="6.01" y2="6"/>
          <line x1="6" y1="18" x2="6.01" y2="18"/>
        </svg>
        <span className="prompt-options-pill-label">{compact ? 'MCP' : chipLabel}</span>
        {isModified && <span className="mcp-modified-badge">modified</span>}
      </button>
      {popover}
    </>
  );
}

/** A failing MCP chip must never blank the input bar (and with it the whole app). */
class McpChipBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error('[McpStatusChip] render failed', err); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function McpStatusChip(props: McpStatusChipProps) {
  return <McpChipBoundary><McpStatusChipInner {...props} /></McpChipBoundary>;
}
