import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemResources } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { WS_URL } from '../ws.js';
import { fetchSystemResources, measureHealthLatency } from '../api.js';
import {
  summariseSamples, classifyRtt, pct, usageColor,
  formatBytes, formatUptime, formatMs,
  type SampleSummary, type GradeInfo,
} from './connectionQuality.js';
import { ResourceGraph } from './ResourceGraph.js';

const SAMPLES = 3;
const PING_TIMEOUT_MS = 3000;

interface Props {
  onClose: () => void;
  connState: string;
  pingOnce: (options?: number | { timeoutMs?: number }) => Promise<number>;
}

type Tab = 'connection' | 'resources';

interface ConnResult {
  summary: SampleSummary;
  grade: GradeInfo;
  httpMs: number | null;
  at: number;
}

export function ConnectionModal({ onClose, connState, pingOnce }: Props) {
  const [tab, setTab] = useState<Tab>('connection');

  // ── Connection tab ────────────────────────────────────────────────
  const [conn, setConn] = useState<ConnResult | null>(null);
  const [connBusy, setConnBusy] = useState(false);

  // ── Resources tab ─────────────────────────────────────────────────
  const [res, setRes] = useState<SystemResources | null>(null);
  const [resErr, setResErr] = useState<string | null>(null);
  const [resBusy, setResBusy] = useState(false);

  // ── Non-persistent metric histories (discarded on modal unmount) ──
  const [latencyHistory, setLatencyHistory] = useState<(number | null)[]>([]);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);

  // Aborts in-flight work on unmount so nothing lands after close.
  const aliveRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const samplesRef = useRef<(number | null)[]>([]);
  const isPollingRef = useRef(false);

  // Keep latest connState & pingOnce accessible to the poll cycle without re-triggering effects
  const connStateRef = useRef(connState);
  connStateRef.current = connState;
  const pingOnceRef = useRef(pingOnce);
  pingOnceRef.current = pingOnce;

  const executePoll = useCallback(async (isInitial = false) => {
    if (!aliveRef.current || isPollingRef.current) return;
    isPollingRef.current = true;
    if (isInitial) {
      setConnBusy(true);
      setResBusy(true);
    }

    try {
      // 1. Connection probe
      const currentConnState = connStateRef.current;
      if (currentConnState === 'connected') {
        if (isInitial) {
          // On initial mount: run SAMPLES pings sequentially so the operator
          // immediately sees a full average and jitter reading.
          const initialRtts: (number | null)[] = [];
          for (let i = 0; i < SAMPLES; i += 1) {
            try {
              const rtt = await pingOnceRef.current(PING_TIMEOUT_MS);
              samplesRef.current.push(rtt);
              initialRtts.push(rtt);
            } catch {
              samplesRef.current.push(null);
              initialRtts.push(null);
            }
            if (!aliveRef.current) return;
          }
          setLatencyHistory((prev) => [...prev, ...initialRtts].slice(-30));
        } else {
          // On periodic 2s poll ticks: take 1 fresh ping and slide the window
          let latestRtt: number | null = null;
          try {
            latestRtt = await pingOnceRef.current(PING_TIMEOUT_MS);
            samplesRef.current = [...samplesRef.current.slice(-(SAMPLES - 1)), latestRtt];
          } catch {
            samplesRef.current = [...samplesRef.current.slice(-(SAMPLES - 1)), null];
          }
          setLatencyHistory((prev) => [...prev, latestRtt].slice(-30));
        }
      } else {
        samplesRef.current = [null, null, null];
        setLatencyHistory((prev) => [...prev, null].slice(-30));
      }

      if (!aliveRef.current) return;
      const summary = summariseSamples(samplesRef.current);
      const grade = classifyRtt(summary.avg, summary.lossPct);

      const health = await measureHealthLatency();
      if (!aliveRef.current) return;
      const httpMs = health.ok ? health.latencyMs : null;

      setConn({ summary, grade, httpMs, at: Date.now() });

      // 2. Server resources probe
      try {
        const r = await fetchSystemResources();
        if (!aliveRef.current) return;
        setRes(r);
        setResErr(null);

        const cPct = pct(r.cpu.load1, r.cpu.cores);
        if (cPct !== null) {
          setCpuHistory((prev) => [...prev, cPct].slice(-30));
        }
        const mPct = pct(r.memory.used, r.memory.total);
        if (mPct !== null) {
          setRamHistory((prev) => [...prev, mPct].slice(-30));
        }
      } catch (e) {
        if (!aliveRef.current) return;
        setResErr(e instanceof Error ? e.message : 'failed to read server resources');
      }
    } finally {
      if (aliveRef.current) {
        setConnBusy(false);
        setResBusy(false);
        isPollingRef.current = false;
        // Schedule next poll tick in 2000ms; automatically cleared on unmount
        pollTimerRef.current = setTimeout(() => {
          void executePoll(false);
        }, 2000);
      }
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void executePoll(true);
    return () => {
      aliveRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [executePoll]);

  const handleManualRefresh = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    void executePoll(false);
  }, [executePoll]);

  const connStateColor =
    connState === 'connected' ? 'var(--green)' :
    connState === 'connecting' ? 'var(--amber)' : 'var(--red)';

  const cpuPct = res ? pct(res.cpu.load1, res.cpu.cores) : null;
  const ramPct = res ? pct(res.memory.used, res.memory.total) : null;
  const diskPct = res?.disk ? pct(res.disk.used, res.disk.used + res.disk.available) : null;

  return (
    <Modal title="Connection & server" onClose={onClose} className={`conn-modal conn-modal--${tab}`}>
      <div className="conn-modal-tabs" role="tablist" aria-label="Connection and server">
        {(['connection', 'resources'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`conn-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`conn-panel-${t}`}
            className={`conn-modal-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'connection' ? 'Connection' : 'Server resources'}
          </button>
        ))}
      </div>

      <div className="conn-modal-scroll">
        {tab === 'connection' && (
          <div role="tabpanel" id="conn-panel-connection" aria-labelledby="conn-tab-connection">
            <div className="conn-grade" style={{ color: connBusy && !conn ? 'var(--text-3)' : conn?.grade.color ?? 'var(--text-1)' }}>
              {connBusy && !conn ? 'Testing connection…' : conn ? conn.grade.label : 'Checking…'}
            </div>

            <div className="conn-section-card">
              <div className="conn-section-header">
                <span className="conn-section-title">Connection details</span>
                <span className="conn-section-badge" style={{ color: connStateColor }}>
                  {connState}
                </span>
              </div>

              <div className="conn-row">
                <span className="conn-row-label">Transport URL</span>
                <span className="conn-row-value">{WS_URL}</span>
              </div>
              <div className="conn-row">
                <span className="conn-row-label">Socket state</span>
                <span className="conn-row-value" style={{ color: connStateColor, fontWeight: 500 }}>
                  {connState}
                </span>
              </div>
              <div className="conn-row">
                <span className="conn-row-label">WebSocket latency (avg)</span>
                <span className="conn-row-value">{conn ? formatMs(conn.summary.avg) : '—'}</span>
              </div>
              <div className="conn-row">
                <span className="conn-row-label">Min / Max latency</span>
                <span className="conn-row-value">
                  {conn && conn.summary.min !== null && conn.summary.max !== null
                    ? `${formatMs(conn.summary.min)} / ${formatMs(conn.summary.max)}`
                    : '—'}
                </span>
              </div>
              <div className="conn-row">
                <span className="conn-row-label">Latency jitter</span>
                <span className="conn-row-value">{conn ? formatMs(conn.summary.jitter) : '—'}</span>
              </div>
              <div className="conn-row">
                <span className="conn-row-label">Packet loss</span>
                <span className="conn-row-value">
                  {conn
                    ? `${conn.summary.total - conn.summary.ok} of ${conn.summary.total} lost (${Math.round(conn.summary.lossPct)}%)`
                    : '—'}
                </span>
              </div>
              <div className="conn-row">
                <span className="conn-row-label">HTTP REST latency (GET /health)</span>
                <span className="conn-row-value">
                  {conn ? (conn.httpMs !== null ? formatMs(conn.httpMs) : 'unreachable') : '—'}
                </span>
              </div>

              <ResourceGraph
                title="Latency trend"
                values={latencyHistory}
                color={conn ? conn.grade.color : 'var(--accent)'}
                unit=" ms"
                fixedMin={0}
                formatValue={formatMs}
              />
            </div>

            {connState !== 'connected' && (
              <div className="conn-error" style={{ marginTop: '10px' }}>
                Socket is currently not connected. Latency test could not reach the server over WebSocket.
              </div>
            )}
          </div>
        )}

        {tab === 'resources' && (
          <div role="tabpanel" id="conn-panel-resources" aria-labelledby="conn-tab-resources">
            {resBusy && !res && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: '13px' }}>
                Loading server resources…
              </div>
            )}

            {resErr && (
              <div className="conn-error">
                {resErr}
              </div>
            )}

            {res && (
              <>
                {/* ── CPU ── */}
                <div className="conn-section-card">
                  <div className="conn-section-header">
                    <span className="conn-section-title">CPU</span>
                    <span className="conn-section-badge" style={{ color: usageColor(cpuPct) }}>
                      {res.cpu.cores} core{res.cpu.cores === 1 ? '' : 's'} · {cpuPct !== null ? `${Math.round(cpuPct)}% load` : '—'}
                    </span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Cores & Model</span>
                    <span className="conn-row-value">
                      {res.cpu.cores} core{res.cpu.cores === 1 ? '' : 's'}{res.cpu.model ? ` · ${res.cpu.model}` : ''}
                    </span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Load average (1m / 5m / 15m)</span>
                    <span className="conn-row-value">
                      {res.cpu.load1.toFixed(2)} · {res.cpu.load5.toFixed(2)} · {res.cpu.load15.toFixed(2)}
                    </span>
                  </div>
                  <div className="conn-bar" title={`CPU Load (1m): ${cpuPct !== null ? `${Math.round(cpuPct)}%` : '—'}`}>
                    <div className="conn-bar-fill" style={{ width: `${cpuPct ?? 0}%`, background: usageColor(cpuPct) }} />
                  </div>
                  <div className="conn-row" style={{ borderBottom: 'none', paddingTop: 0 }}>
                    <span className="conn-row-label">1m Load utilisation</span>
                    <span className="conn-row-value" style={{ color: usageColor(cpuPct) }}>
                      {cpuPct !== null ? `${Math.round(cpuPct)}%` : '—'}
                    </span>
                  </div>
                  <ResourceGraph
                    title="CPU load trend (1m)"
                    values={cpuHistory}
                    color={usageColor(cpuPct)}
                    unit="%"
                    fixedMin={0}
                    fixedMax={100}
                  />
                </div>

                {/* ── Memory ── */}
                <div className="conn-section-card">
                  <div className="conn-section-header">
                    <span className="conn-section-title">Memory (RAM)</span>
                    <span className="conn-section-badge" style={{ color: usageColor(ramPct) }}>
                      {ramPct !== null ? `${Math.round(ramPct)}% used` : '—'}
                    </span>
                  </div>
                  <div className="conn-bar" title={`RAM used: ${ramPct !== null ? `${Math.round(ramPct)}%` : '—'}`}>
                    <div className="conn-bar-fill" style={{ width: `${ramPct ?? 0}%`, background: usageColor(ramPct) }} />
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Used / Total</span>
                    <span className="conn-row-value">
                      {formatBytes(res.memory.used)} of {formatBytes(res.memory.total)} ({ramPct !== null ? `${Math.round(ramPct)}%` : '—'})
                    </span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Free</span>
                    <span className="conn-row-value">{formatBytes(res.memory.free)}</span>
                  </div>
                  <ResourceGraph
                    title="RAM usage trend"
                    values={ramHistory}
                    color={usageColor(ramPct)}
                    unit="%"
                    fixedMin={0}
                    fixedMax={100}
                  />
                </div>

                {/* ── Disk (Data Volume) ── */}
                <div className="conn-section-card">
                  <div className="conn-section-header">
                    <span className="conn-section-title">Disk (Data Volume)</span>
                    <span className="conn-section-badge" style={{ color: usageColor(diskPct) }}>
                      {diskPct !== null ? `${Math.round(diskPct)}% used` : '—'}
                    </span>
                  </div>
                  {res.disk ? (
                    <>
                      <div className="conn-bar" title={`Disk used: ${diskPct !== null ? `${Math.round(diskPct)}%` : '—'}`}>
                        <div className="conn-bar-fill" style={{ width: `${diskPct ?? 0}%`, background: usageColor(diskPct) }} />
                      </div>
                      <div className="conn-row">
                        <span className="conn-row-label">Used / Available</span>
                        <span className="conn-row-value">
                          {formatBytes(res.disk.used)} used · {formatBytes(res.disk.available)} free ({diskPct !== null ? `${Math.round(diskPct)}%` : '—'} used)
                        </span>
                      </div>
                      <div className="conn-row">
                        <span className="conn-row-label">Total capacity</span>
                        <span className="conn-row-value">
                          {formatBytes(res.disk.total || res.disk.used + res.disk.available)}
                        </span>
                      </div>
                      <div className="conn-row">
                        <span className="conn-row-label">Volume Path</span>
                        <span className="conn-row-value" style={{ fontSize: '12px' }}>{res.disk.path}</span>
                      </div>
                    </>
                  ) : (
                    <div className="conn-row">
                      <span className="conn-row-label">Volume status</span>
                      <span className="conn-row-value" style={{ color: 'var(--text-3)' }}>
                        Unavailable on this filesystem
                      </span>
                    </div>
                  )}
                </div>

                {/* ── Process ── */}
                <div className="conn-section-card">
                  <div className="conn-section-header">
                    <span className="conn-section-title">Tierwyn Process</span>
                    <span className="conn-section-badge">PID {res.proc.pid}</span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Process Memory</span>
                    <span className="conn-row-value">
                      RSS {formatBytes(res.proc.rss)} · Heap {formatBytes(res.proc.heapUsed)} / {formatBytes(res.proc.heapTotal)}
                    </span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Process Uptime</span>
                    <span className="conn-row-value">{formatUptime(res.proc.uptimeSec)}</span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Process Info</span>
                    <span className="conn-row-value">
                      Node {res.proc.nodeVersion}
                    </span>
                  </div>
                </div>

                {/* ── Host System ── */}
                <div className="conn-section-card">
                  <div className="conn-section-header">
                    <span className="conn-section-title">Host System</span>
                    <span className="conn-section-badge">{res.os.platform}</span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Platform</span>
                    <span className="conn-row-value">
                      {res.os.platform} {res.os.release}
                    </span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">Hostname</span>
                    <span className="conn-row-value">
                      {res.os.hostname}
                    </span>
                  </div>
                  <div className="conn-row">
                    <span className="conn-row-label">System Uptime</span>
                    <span className="conn-row-value">{formatUptime(res.os.uptimeSec)}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="conn-actions">
        <button
          type="button"
          className="modal-btn primary"
          disabled={tab === 'connection' ? connBusy : resBusy}
          onClick={handleManualRefresh}
        >
          {tab === 'connection'
            ? (connBusy ? 'Testing…' : 'Re-test connection')
            : (resBusy ? 'Refreshing…' : 'Refresh')}
        </button>
      </div>
    </Modal>
  );
}
