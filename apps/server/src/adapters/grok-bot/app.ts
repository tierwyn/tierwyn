/**
 * Module-level Grok Bot CDP singleton. Lazy connect, never spawns the GUI.
 * Adapter instances are per-session and disposable; this outlives them.
 */
import { envPrefFrom } from '../../config/env.js';
import { CdpClient, discoverPageTarget, type CdpLike } from './cdp.js';

export const DEFAULT_CDP_PORT = 9333;
const BACKOFF_CAP_MS = 30_000;

export type Health = 'ok' | 'unreachable' | 'unhealthy';

export function cdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(envPrefFrom(env, 'GROKBOT_CDP_PORT'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CDP_PORT;
}

export type AppDeps = {
  port?: number;
  fetchFn?: typeof fetch;
  createClient?: () => CdpClient;
  discover?: typeof discoverPageTarget;
};

export class GrokBotApp {
  private client: CdpClient | null = null;
  private connecting: Promise<CdpClient> | null = null;
  private backoffMs = 1000;
  private lastHealth: Health = 'unreachable';
  private readonly port: number;
  private readonly fetchFn: typeof fetch;
  private readonly createClient: () => CdpClient;
  private readonly discover: typeof discoverPageTarget;

  constructor(deps: AppDeps = {}) {
    this.port = deps.port ?? cdpPort();
    this.fetchFn = deps.fetchFn ?? fetch;
    this.createClient = deps.createClient ?? (() => new CdpClient());
    this.discover = deps.discover ?? discoverPageTarget;
  }

  health(): Health { return this.lastHealth; }

  async getClient(): Promise<CdpLike> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this._connectOnce();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async dispose(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    this.backoffMs = 1000;
    this.lastHealth = 'unreachable';
    await c?.close().catch(() => undefined);
  }

  /** For tests / mid-turn drop: forget the socket so the next getClient redials. */
  drop(): void {
    this.client = null;
    this.lastHealth = 'unhealthy';
  }

  nextBackoffMs(): number { return this.backoffMs; }

  async reconnectAfterDrop(): Promise<CdpLike> {
    this.drop();
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    await new Promise((r) => setTimeout(r, wait));
    return this.getClient();
  }

  private async _connectOnce(): Promise<CdpClient> {
    try {
      const target = await this.discover(this.port, this.fetchFn);
      const client = this.createClient();
      client.onClosed = () => {
        // Grok Bot restarted: forget the dead socket so the next getClient redials.
        if (this.client === client) {
          this.client = null;
          this.lastHealth = 'unreachable';
        }
      };
      await client.connect(target.webSocketDebuggerUrl);
      await client.send('Runtime.enable');
      this.client = client;
      this.backoffMs = 1000;
      this.lastHealth = 'ok';
      return client;
    } catch (err) {
      this.lastHealth = 'unreachable';
      throw err;
    }
  }
}

let singleton: GrokBotApp | null = null;

export function getApp(): GrokBotApp {
  if (!singleton) singleton = new GrokBotApp();
  return singleton;
}

export async function disposeApp(): Promise<void> {
  await singleton?.dispose();
  singleton = null;
}
