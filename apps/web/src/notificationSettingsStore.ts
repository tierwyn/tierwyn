import type { PublicNotificationSettings } from '@tierwyn/shared';

let current: PublicNotificationSettings | null = null;

export function readNotificationSettings(): PublicNotificationSettings | null {
  return current;
}

export function writeNotificationSettings(s: PublicNotificationSettings | null): void {
  current = s;
}
