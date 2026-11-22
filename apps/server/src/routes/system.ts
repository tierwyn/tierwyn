import type { Express } from 'express';
import os from 'os';
import { statfs } from 'fs/promises';
import type { SystemResources } from '@tierwyn/shared';

export interface SystemRoutesDeps {
  /** Directory whose volume is reported (the Tierwyn data dir). */
  dataDir: string;
}

async function readDisk(path: string): Promise<SystemResources['disk']> {
  try {
    const s = await statfs(path);
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const available = Number(s.bavail) * bsize;
    const used = total - Number(s.bfree) * bsize;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { path, total, available, used };
  } catch {
    // ponytail: statfs is unsupported on some FUSE/container mounts — the UI
    // renders "unavailable" rather than failing the whole snapshot.
    return null;
  }
}

export async function getSystemResources(dataDir: string): Promise<SystemResources> {
  const cpus = os.cpus();
  const [load1, load5, load15] = os.loadavg();
  const total = os.totalmem();
  const free = os.freemem();
  const mem = process.memoryUsage();
  return {
    now: Date.now(),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || null,
      load1, load5, load15,
    },
    memory: { total, free, used: total - free },
    proc: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      uptimeSec: process.uptime(),
      pid: process.pid,
      nodeVersion: process.version,
    },
    disk: await readDisk(dataDir),
    os: {
      platform: os.platform(),
      release: os.release(),
      uptimeSec: os.uptime(),
      hostname: os.hostname(),
    },
  };
}

/** Operator-only host snapshot. MUST be mounted after `requireAuth` — this is
 *  host reconnaissance and is deliberately not reachable with a spawn token. */
export function registerSystemRoutes(app: Express, deps: SystemRoutesDeps): void {
  app.get('/system/resources', async (_req, res) => {
    try {
      res.json(await getSystemResources(deps.dataDir));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'resource read failed' });
    }
  });
}
