import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type PiperDownloadProgress,
  type PiperVoiceCatalogueEntry,
} from '../api.js';
import { Modal } from './Modal.js';

interface Props {
  onClose: () => void;
  /** Persist + live-update the selected voice in the parent SettingsModal. */
  onVoiceSelected: (id: string) => void;
  /** Refresh parent dropdown installed list after a download completes. */
  onDownloaded: (id: string) => void;
}

export function PiperVoiceModal({ onClose, onVoiceSelected, onDownloaded }: Props) {
  const [catalogue, setCatalogue] = useState<PiperVoiceCatalogueEntry[]>([]);
  const [download, setDownload] = useState<PiperDownloadProgress | null>(null);

  const refresh = () => api.listPiperVoices().then((r) => setCatalogue(r.voices)).catch(() => { /* offline */ });

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!download || download.done) return;
    const t = setInterval(async () => {
      try {
        const p = await api.piperVoiceDownloadProgress(download.id);
        setDownload(p);
        if (p.done && !p.error) {
          clearInterval(t);
          await refresh();
          onDownloaded(p.id);
          onVoiceSelected(p.id);
          onClose();
        } else if (p.done && p.error) {
          clearInterval(t);
        }
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [download, onClose, onDownloaded, onVoiceSelected]);

  const byLanguage = useMemo(() => {
    const groups = new Map<string, PiperVoiceCatalogueEntry[]>();
    for (const v of catalogue) {
      const list = groups.get(v.language) ?? [];
      list.push(v);
      groups.set(v.language, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalogue]);

  const startDownload = async (id: string) => {
    setDownload({ id, downloaded: 0, total: 0, pct: 0, done: false, error: null });
    try {
      await api.downloadPiperVoice(id);
    } catch (e) {
      setDownload({
        id,
        downloaded: 0,
        total: 0,
        pct: 0,
        done: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const inFlightId = download && !download.done ? download.id : null;

  return (
    <Modal title="Download Piper voices" onClose={onClose}>
      <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13 }}>
        Voices install to <code>~/piper-voices/</code> and load on first use — no service restart.
      </p>

      {byLanguage.map(([language, voices]) => (
        <div key={language} style={{ marginTop: 16 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-2)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 8,
          }}>
            {language}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {voices.map((v) => {
              const isDownloading = inFlightId === v.id;
              return (
                <div
                  key={v.id}
                  style={{
                    padding: '10px 12px',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: 'var(--text-1)', fontWeight: 500 }}>{v.label}</div>
                      <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{v.quality} · {v.id}</div>
                    </div>
                    {v.installed ? (
                      <span style={{
                        fontSize: 12,
                        color: 'var(--accent)',
                        fontWeight: 600,
                      }}>
                        Installed
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="modal-btn primary"
                        disabled={!!inFlightId}
                        onClick={() => startDownload(v.id)}
                      >
                        {isDownloading ? 'Downloading…' : 'Install'}
                      </button>
                    )}
                  </div>
                  {isDownloading && download && download.total > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="voice-progress-bar">
                        <div
                          className="voice-progress-fill"
                          style={{ width: `${Math.min(100, download.pct)}%` }}
                        />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                        {download.pct.toFixed(1)}%
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {download?.error && (
        <div style={{
          marginTop: 12,
          padding: '8px 12px',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-hi)',
          borderRadius: 6,
          color: 'var(--text-2)',
          fontSize: 13,
        }}>
          {download.error}
        </div>
      )}
    </Modal>
  );
}
