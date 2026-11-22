import { lsGet, lsSet } from './prefixedStorage.js';

export interface DeviceNotificationPrefs { enabled: boolean }

const KEY = 'tierwyn.notifications.device';

export function getDevicePrefs(): DeviceNotificationPrefs {
  try {
    const raw = lsGet(KEY);
    if (!raw) return { enabled: false };
    const parsed = JSON.parse(raw) as Partial<DeviceNotificationPrefs>;
    return { enabled: parsed.enabled === true };
  } catch {
    return { enabled: false };
  }
}

export function setDevicePrefs(p: DeviceNotificationPrefs): void {
  try {
    lsSet(KEY, JSON.stringify(p));
  } catch {
    /* private-mode Safari throws on write */
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;
}
