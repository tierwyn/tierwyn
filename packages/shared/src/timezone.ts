/** Curated IANA zones — shown first in the picker; full list via supportedValuesOf when available. */
export const COMMON_TIMEZONES: readonly string[] = [
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'America/Buenos_Aires',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Perth',
  'Pacific/Auckland',
  'Africa/Johannesburg',
  'Africa/Cairo',
];

/** All IANA zones when the runtime supports it; otherwise COMMON_TIMEZONES only. */
export function listAllTimezones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf?.('timeZone');
    if (supported?.length) return [...supported].sort();
  } catch {
    /* unsupported */
  }
  return [...COMMON_TIMEZONES];
}

export function isValidTimezone(tz: string): boolean {
  if (!tz?.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DDTHH:mm` in the given IANA timezone (24h). */
export function formatIsoLocalInTimezone(ms: number, timezone: string): string {
  const tz = timezone?.trim() || 'UTC';
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .formatToParts(new Date(ms))
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16);
  }
}

/** Parse `YYYY-MM-DDTHH:mm` as local wall time in `timezone` → epoch ms. */
export function parseIsoLocalInTimezone(value: string, timezone: string): number {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return NaN;
  const tz = timezone?.trim() || 'UTC';
  const [datePart, timePart] = trimmed.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  let lo = Date.UTC(y, mo - 1, d, h - 14, mi);
  let hi = Date.UTC(y, mo - 1, d, h + 14, mi);
  for (let i = 0; i < 50; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const fmt = formatIsoLocalInTimezone(mid, tz);
    if (fmt === trimmed) return mid;
    if (fmt < trimmed) lo = mid + 1;
    else hi = mid - 1;
  }
  return NaN;
}

/** Human-readable date/time in a timezone (schedule lists, sidebar fallback). */
export function formatDateTimeInTimezone(
  ms: number,
  timezone: string,
  locale?: string,
): string {
  const tz = timezone?.trim() || 'UTC';
  try {
    return new Date(ms).toLocaleString(locale, {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ms);
  }
}
