import { useEffect, useState } from 'react';
import type { PublicDecisionSettings } from '@tierwyn/shared';
import { api } from '../api.js';
import { TagCatalogueSettingsPanel } from './TagCatalogueSettings.js';

/** Settings → General: Jev notification interrupt filter + conversation auto-tagging. The key is write-only. */
export function DecisionSettingsPanel() {
  const [settings, setSettings] = useState<PublicDecisionSettings | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = (s: PublicDecisionSettings) => {
    setSettings(s);
    setModel(s.model);
    setBaseUrl(s.baseUrl);
  };

  useEffect(() => {
    api.getDecisionSettings().then(load).catch(() => { /* offline */ });
  }, []);

  if (!settings) return null;

  const save = async (patch: Parameters<typeof api.updateDecisionSettings>[0]) => {
    setError(null);
    try {
      load(await api.updateDecisionSettings(patch));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      return false;
    }
  };

  const saveFields = () => {
    const patch: Parameters<typeof api.updateDecisionSettings>[0] = {};
    if (model !== settings.model) patch.model = model;
    if (baseUrl !== settings.baseUrl) patch.baseUrl = baseUrl;
    if (keyDraft) patch.apiKey = keyDraft;
    if (Object.keys(patch).length === 0) return;
    void save(patch).then((ok) => { if (ok) setKeyDraft(''); });
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testDecision();
      setTestResult(r.ok ? `OK · ${r.model} · ${r.latencyMs} ms` : `Failed: ${r.error}`);
    } catch {
      setTestResult('Failed: request error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Notification filter (Jev)</div>
      <div className="settings-card active">
        <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <label className="toggle-setting-label">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => { void save({ enabled: e.target.checked }); }}
            />
            Skip notifications for routine completions
          </label>
          <div className="modal-hint">
            When on, the conversation title, description and a short scrubbed excerpt of the last agent reply
            are sent to TypeSafe to decide whether to notify. That text is never put into the notification.
          </div>
          <div className="modal-field">
            <span className="modal-label">API key</span>
            <div className="settings-input-group">
              <input
                className="modal-input"
                type="password"
                autoComplete="off"
                value={keyDraft}
                placeholder={settings.apiKeySet ? 'Key saved' : 'TypeSafe API key'}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              {settings.apiKeySet && (
                <button type="button" className="modal-btn" onClick={() => { void save({ apiKey: '' }); }}>
                  Clear key
                </button>
              )}
            </div>
          </div>
          <div className="modal-field">
            <span className="modal-label">Model</span>
            <input
              className="modal-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={saveFields}
            />
          </div>
          <div className="modal-field">
            <span className="modal-label">Base URL</span>
            <input
              className="modal-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={saveFields}
            />
          </div>
          <div className="settings-input-group">
            <button type="button" className="modal-btn" onClick={saveFields}>Save</button>
            <button
              type="button"
              className="modal-btn"
              disabled={testing || !settings.apiKeySet}
              onClick={() => { void runTest(); }}
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>
          {testResult && <div className="modal-hint">{testResult}</div>}
          {error && <div className="modal-hint">{error}</div>}
          <div className="settings-section-title">Check memories</div>
          <label className="toggle-setting-label">
            <input
              type="checkbox"
              checked={settings.memoryCheckEnabled}
              disabled={!settings.enabled || !settings.apiKeySet}
              onChange={(e) => { void save({ memoryCheckEnabled: e.target.checked }); }}
            />
            Check memories in the background (requires Jev enabled + key)
          </label>
          <div className="modal-hint">
            When enabled, saved memories are checked by TypeSafe in the background. Suspicious memories are flagged and hidden until approved in the Memories modal.
          </div>
          <div className="settings-section-title">Auto-tag conversations</div>
          <label className="toggle-setting-label">
            <input
              type="checkbox"
              checked={settings.autoTagEnabled}
              disabled={!settings.enabled || !settings.apiKeySet}
              onChange={(e) => { void save({ autoTagEnabled: e.target.checked }); }}
            />
            Tag conversations automatically (requires Jev enabled + key)
          </label>
          <div className="modal-hint">
            Once per conversation (after ≥3 prompts and a description exists), Tierwyn sends the conversation{' '}
            <strong>title and description</strong> to TypeSafe with your enabled tag list. No transcript or message
            text is sent. Tags are only ever added, never removed.
          </div>
          <TagCatalogueSettingsPanel />
        </div>
      </div>
    </div>
  );
}
