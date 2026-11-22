import { describe, it, expect } from 'vitest';
import { LoginRateLimiter } from './rateLimit.js';

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const OPTS = { maxAttempts: 5, windowMs: 60_000, lockoutMs: 60_000 };

describe('LoginRateLimiter', () => {
  it('allows attempts before the threshold is reached', () => {
    const clock = makeClock();
    const rl = new LoginRateLimiter({ ...OPTS, now: clock.now });
    for (let i = 0; i < 4; i++) {
      expect(rl.check('1.2.3.4').allowed).toBe(true);
      rl.recordFailure('1.2.3.4');
    }
    expect(rl.check('1.2.3.4').allowed).toBe(true);
  });

  it('locks out after maxAttempts failures and reports retryAfter', () => {
    const clock = makeClock();
    const rl = new LoginRateLimiter({ ...OPTS, now: clock.now });
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    const res = rl.check('1.2.3.4');
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBeGreaterThan(0);
    expect(res.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('a successful login resets the counter', () => {
    const clock = makeClock();
    const rl = new LoginRateLimiter({ ...OPTS, now: clock.now });
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    rl.reset('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(true);
  });

  it('lockout expires after the cooldown', () => {
    const clock = makeClock();
    const rl = new LoginRateLimiter({ ...OPTS, now: clock.now });
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(false);
    clock.advance(60_001);
    expect(rl.check('1.2.3.4').allowed).toBe(true);
  });

  it('failures spread beyond the window do not accumulate to a lockout', () => {
    const clock = makeClock();
    const rl = new LoginRateLimiter({ ...OPTS, now: clock.now });
    for (let i = 0; i < 4; i++) { rl.recordFailure('1.2.3.4'); clock.advance(20_000); }
    // 80s elapsed, early failures aged out of the 60s window → still allowed
    expect(rl.check('1.2.3.4').allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const clock = makeClock();
    const rl = new LoginRateLimiter({ ...OPTS, now: clock.now });
    for (let i = 0; i < 5; i++) rl.recordFailure('1.1.1.1');
    expect(rl.check('1.1.1.1').allowed).toBe(false);
    expect(rl.check('2.2.2.2').allowed).toBe(true);
  });

  it('tryAcquire caps global in-flight at 4 and counts pending toward maxAttempts', () => {
    const rl = new LoginRateLimiter({ ...OPTS });
    const slots = Array.from({ length: 20 }, () => rl.tryAcquire('1.2.3.4'));
    const allowed = slots.filter((s) => s.allowed);
    expect(allowed).toHaveLength(LoginRateLimiter.MAX_GLOBAL_IN_FLIGHT);
    expect(allowed.length).toBeLessThanOrEqual(5);
    for (const s of allowed) s.release!(false);
    expect(rl.check('1.2.3.4').allowed).toBe(true);
    rl.recordFailure('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(false);
  });

  it('tryAcquire release is idempotent', () => {
    const rl = new LoginRateLimiter({ ...OPTS });
    const a = rl.tryAcquire('k');
    const b = rl.tryAcquire('k');
    expect(a.allowed && b.allowed).toBe(true);
    a.release!(true);
    a.release!(true);
    const c = rl.tryAcquire('k');
    expect(c.allowed).toBe(true);
    c.release!(true);
    b.release!(true);
  });
});
