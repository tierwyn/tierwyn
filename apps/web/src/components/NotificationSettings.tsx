import { useEffect, useState } from 'react';
import type { PublicNotificationSettings } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  getDevicePrefs, setDevicePrefs, notificationsSupported,
} from '../notificationDevice.js';
import { writeNotificationSettings } from '../notificationSettingsStore.js';

const CATEGORIES: { key: keyof Pick<PublicNotificationSettings, 'conversationComplete' | 'scheduleFired' | 'scheduleRunEnded' | 'scheduleDisabled' | 'agentMessage'>; label: string }[] = [
  { key: 'conversationComplete', label: 'Conversation complete' },
  { key: 'scheduleFired', label: 'Schedule fired' },
  { key: 'scheduleRunEnded', label: 'Schedule run ended' },
  { key: 'scheduleDisabled', label: 'Schedule auto-disabled' },
  { key: 'agentMessage', label: 'Agent message' },
];

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushManagerAvailable = typeof window !== 'undefined' && 'PushManager' in window;

export function NotificationSettings() {
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : 'denied',
  );
  const [deviceOn, setDeviceOn] = useState(() => getDevicePrefs().enabled);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [settings, setSettings] = useState<PublicNotificationSettings | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    api.getNotificationSettings().then((s) => {
      writeNotificationSettings(s);
      setSettings(s);
    }).catch(() => { /* offline */ });
    setPermission(supported ? Notification.permission : 'denied');
    setDeviceOn(getDevicePrefs().enabled);
    if (pushManagerAvailable && navigator.serviceWorker) {
      void navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => { setPushOn(!!sub); })
        .catch(() => { /* ignore */ });
    }
  }, [supported]);

  if (!supported) {
    return (
      <div className="settings-section">
        <div className="settings-section-title">Notifications</div>
        <div className="settings-card">
          <div className="settings-card-body">
            <div className="modal-hint">
              Notifications require HTTPS. Open Tierwyn at your https:// address to enable them.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const toggleThisDevice = async (want: boolean) => {
    if (deviceBusy) return;
    if (!want) {
      setDevicePrefs({ enabled: false });
      setDeviceOn(false);
      return;
    }
    if (permission === 'denied') return;
    setDeviceBusy(true);
    try {
      let next: NotificationPermission = permission;
      if (permission !== 'granted') {
        next = await Notification.requestPermission();
        setPermission(next);
      }
      const ok = next === 'granted';
      setDevicePrefs({ enabled: ok });
      setDeviceOn(ok);
    } finally {
      setDeviceBusy(false);
    }
  };

  const sendTest = () => {
    try {
      new Notification('Tierwyn', { body: 'Test notification', tag: 'tierwyn:test' });
    } catch { /* Android Chrome requires SW for some builds */ }
  };

  const togglePush = async (on: boolean) => {
    if (!pushManagerAvailable || pushBusy) return;
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (on) {
        const key = await api.getVapidPublicKey();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        });
        await api.subscribePush(sub.toJSON());
        setPushOn(true);
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
          await api.unsubscribePush(sub.endpoint);
        }
        setPushOn(false);
      }
    } catch {
      /* permission or network — leave toggle as-is */
    } finally {
      setPushBusy(false);
    }
  };

  const save = async (patch: Partial<PublicNotificationSettings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...patch });
    try {
      const updated = await api.updateNotificationSettings(patch);
      writeNotificationSettings(updated);
      setSettings(updated);
    } catch {
      setSettings(settings);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Notifications</div>
      <div className="settings-card active">
        <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="modal-field">
            <span className="modal-label">This device</span>
            <label className="toggle-setting-label">
              <input
                type="checkbox"
                checked={deviceOn && permission === 'granted'}
                disabled={deviceBusy || permission === 'denied'}
                onChange={(e) => { void toggleThisDevice(e.target.checked); }}
              />
              Enable notifications on this device
            </label>
            {permission === 'denied' && (
              <div className="modal-hint">
                Blocked in browser settings — re-enable notifications for this site there first.
              </div>
            )}
            {permission === 'granted' && deviceOn && (
              <button type="button" className="modal-btn" onClick={sendTest} style={{ alignSelf: 'flex-start' }}>
                Send test notification
              </button>
            )}
          </div>

          {permission === 'granted' && (
            !pushManagerAvailable ? (
              <div className="modal-hint">
                Background notifications are not supported in this browser. On iOS, install Tierwyn to the Home Screen first.
              </div>
            ) : (
              <label className="toggle-setting-label">
                <input
                  type="checkbox"
                  checked={pushOn}
                  disabled={pushBusy}
                  onChange={(e) => { void togglePush(e.target.checked); }}
                />
                Receive notifications when the app is closed
              </label>
            )
          )}

          {settings && (
            <>
              <label className="toggle-setting-label">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => { void save({ enabled: e.target.checked }); }}
                />
                Enable notifications
              </label>
              {CATEGORIES.map(({ key, label }) => (
                <label key={key} className="toggle-setting-label" style={{ opacity: settings.enabled ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    checked={settings[key]}
                    disabled={!settings.enabled}
                    onChange={(e) => { void save({ [key]: e.target.checked }); }}
                  />
                  {label}
                </label>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
