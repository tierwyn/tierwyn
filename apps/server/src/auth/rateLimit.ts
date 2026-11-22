export interface RateLimiterOptions {
  maxAttempts: number; // failures within the window before lockout (e.g. 5)
  windowMs: number;    // window over which failures accumulate
  lockoutMs: number;   // cooldown once locked
  now?: () => number;  // injectable clock for tests
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

interface Entry {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

/**
 * In-memory, per-key login throttle (FR-24). Single-operator scope — process
 * memory is sufficient, no persistence. Key by client identifier (e.g. req.ip).
 *
 * `tryAcquire` reserves a slot *before* argon2 so parallel bursts cannot
 * bypass maxAttempts. `MAX_GLOBAL_IN_FLIGHT` bounds CPU regardless of source IP.
 */
export class LoginRateLimiter {
  static readonly MAX_GLOBAL_IN_FLIGHT = 4;

  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, number>();
  private globalInFlight = 0;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.maxAttempts = opts.maxAttempts;
    this.windowMs = opts.windowMs;
    this.lockoutMs = opts.lockoutMs;
    this.now = opts.now ?? Date.now;
  }

  check(key: string): RateLimitResult {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    const remaining = entry.lockedUntil - this.now();
    if (remaining > 0) {
      return { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) };
    }
    return { allowed: true };
  }

  /** Reserve a verification slot. Counts pending attempts toward maxAttempts. */
  tryAcquire(key: string): RateLimitResult & { release?: (ok: boolean) => void } {
    const locked = this.check(key);
    if (!locked.allowed) return locked;
    const now = this.now();
    const entry = this.entries.get(key);
    const failures = entry && now - entry.firstAt <= this.windowMs ? entry.count : 0;
    const pending = this.inFlight.get(key) ?? 0;
    if (failures + pending >= this.maxAttempts || this.globalInFlight >= LoginRateLimiter.MAX_GLOBAL_IN_FLIGHT) {
      return { allowed: false, retryAfterSec: 1 };
    }
    this.inFlight.set(key, pending + 1);
    this.globalInFlight += 1;
    let done = false;
    return {
      allowed: true,
      release: (ok: boolean) => {
        if (done) return;
        done = true;
        const n = (this.inFlight.get(key) ?? 1) - 1;
        if (n > 0) this.inFlight.set(key, n); else this.inFlight.delete(key);
        this.globalInFlight = Math.max(0, this.globalInFlight - 1);
        if (ok) this.reset(key); else this.recordFailure(key);
      },
    };
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry || now - entry.firstAt > this.windowMs) {
      entry = { count: 0, firstAt: now, lockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
    }
    this.entries.set(key, entry);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries whose window and lockout have both expired (IP-spray bound). */
  private prune(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil < now && now - e.firstAt > this.windowMs) this.entries.delete(k);
    }
  }
}
