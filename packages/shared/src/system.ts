/** Host + process resource snapshot from `GET /system/resources`.
 *  Raw kernel counters only — all percentages and human formatting are derived
 *  client-side (see apps/web/src/components/connectionQuality.ts). */
export interface SystemResources {
  /** Server `Date.now()` when the snapshot was taken. */
  now: number;
  cpu: {
    cores: number;
    /** First CPU's model string, or null when unavailable. */
    model: string | null;
    /** os.loadavg(). Always [0,0,0] on Windows — treat as "unavailable" there. */
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    /** os.totalmem() */
    total: number;
    /** os.freemem() */
    free: number;
    /** total - free */
    used: number;
  };
  proc: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    /** process.uptime(), seconds. */
    uptimeSec: number;
    pid: number;
    nodeVersion: string;
  };
  /** Volume backing the Tierwyn data dir. null when statfs is unsupported or fails. */
  disk: {
    /** The directory that was measured (the data dir, not the mount point). */
    path: string;
    /** blocks * bsize */
    total: number;
    /** bavail * bsize — space usable by a non-root process (df's "Avail"). */
    available: number;
    /** total - (bfree * bsize) — space actually consumed. */
    used: number;
  } | null;
  os: {
    platform: string;
    release: string;
    /** os.uptime(), seconds. */
    uptimeSec: number;
    hostname: string;
  };
}
