/** Compact wall-clock elapsed for spawn wait/result cards: `12s`, `1m 14s`, `1h 02m`. */
export function formatElapsedMs(ms: number): string {
  const totalSec = !Number.isFinite(ms) || ms < 0 ? 0 : Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** Stopwatch-style runtime: always hours, minutes and seconds.
 *  `0:00:07`, `0:04:12`, `1:22:07`, `13:05:00`. Non-finite/negative → `0:00:00`. */
export function formatHms(ms: number): string {
  const totalSec = !Number.isFinite(ms) || ms < 0 ? 0 : Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
