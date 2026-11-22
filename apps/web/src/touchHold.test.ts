import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTouchHold } from './touchTap.js';

describe('useTouchHold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createSimulatedHook(options: Parameters<typeof useTouchHold>[0]) {
    let origin: { x: number; y: number } | null = null;
    let moved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let heldDuringThisTouch = false;
    let lastHoldTimestamp = 0;
    const holdMs = options.holdMs ?? 1000;
    const enabled = options.enabled ?? true;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onTouchStart = (touches: { clientX: number; clientY: number }[]) => {
      heldDuringThisTouch = false;
      clearTimer();
      if (!enabled || !options.onHold) return;
      const t = touches[0];
      if (!t) return;
      origin = { x: t.clientX, y: t.clientY };
      moved = false;

      timer = setTimeout(() => {
        heldDuringThisTouch = true;
        lastHoldTimestamp = Date.now();
        timer = null;
        options.onHold!();
      }, holdMs);
    };

    const onTouchMove = (touches: { clientX: number; clientY: number }[]) => {
      if (!origin || moved) return;
      const t = touches[0];
      if (!t) return;
      const dx = t.clientX - origin.x;
      const dy = t.clientY - origin.y;
      if (dx * dx + dy * dy > 12 * 12) {
        moved = true;
        clearTimer();
      }
    };

    const onTouchEnd = () => {
      clearTimer();
      const wasHeld = heldDuringThisTouch;
      origin = null;
      moved = false;
      if (wasHeld) {
        lastHoldTimestamp = Date.now();
      }
      return wasHeld;
    };

    const onTouchCancel = () => {
      clearTimer();
      origin = null;
      moved = false;
      heldDuringThisTouch = false;
    };

    const shouldSuppressClick = () => {
      const now = Date.now();
      return heldDuringThisTouch || now - lastHoldTimestamp < 800;
    };

    return {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel,
      shouldSuppressClick,
    };
  }

  it('triggers onHold after 1000ms hold without movement', () => {
    const onHold = vi.fn();
    const hook = createSimulatedHook({ onHold, holdMs: 1000 });

    hook.onTouchStart([{ clientX: 100, clientY: 100 }]);
    expect(onHold).not.toHaveBeenCalled();

    // Advance 999ms - should not have fired yet
    vi.advanceTimersByTime(999);
    expect(onHold).not.toHaveBeenCalled();

    // Advance 1ms (total 1000ms) - fires onHold
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);

    // After hold, click should be suppressed
    expect(hook.shouldSuppressClick()).toBe(true);

    // Lifting finger
    const wasHeld = hook.onTouchEnd();
    expect(wasHeld).toBe(true);
    expect(hook.shouldSuppressClick()).toBe(true);
  });

  it('does not trigger onHold if released before 1000ms (normal tap)', () => {
    const onHold = vi.fn();
    const hook = createSimulatedHook({ onHold, holdMs: 1000 });

    hook.onTouchStart([{ clientX: 100, clientY: 100 }]);
    vi.advanceTimersByTime(200);

    const wasHeld = hook.onTouchEnd();
    expect(wasHeld).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(onHold).not.toHaveBeenCalled();
    expect(hook.shouldSuppressClick()).toBe(false);
  });

  it('cancels hold timer when moving finger beyond 12px (scrolling)', () => {
    const onHold = vi.fn();
    const hook = createSimulatedHook({ onHold, holdMs: 1000 });

    hook.onTouchStart([{ clientX: 100, clientY: 100 }]);
    vi.advanceTimersByTime(300);

    // Small wiggle <= 12px doesn't cancel
    hook.onTouchMove([{ clientX: 103, clientY: 104 }]);
    vi.advanceTimersByTime(300);
    expect(onHold).not.toHaveBeenCalled();

    // Scroll movement > 12px (e.g. dy = 25px) cancels hold
    hook.onTouchMove([{ clientX: 103, clientY: 125 }]);

    // Advance past 1000ms
    vi.advanceTimersByTime(1000);
    expect(onHold).not.toHaveBeenCalled();

    const wasHeld = hook.onTouchEnd();
    expect(wasHeld).toBe(false);
    expect(hook.shouldSuppressClick()).toBe(false);
  });

  it('cancels timer on touchcancel', () => {
    const onHold = vi.fn();
    const hook = createSimulatedHook({ onHold, holdMs: 1000 });

    hook.onTouchStart([{ clientX: 100, clientY: 100 }]);
    vi.advanceTimersByTime(500);
    hook.onTouchCancel();

    vi.advanceTimersByTime(1000);
    expect(onHold).not.toHaveBeenCalled();
    expect(hook.shouldSuppressClick()).toBe(false);
  });

  it('does not trigger when enabled is false', () => {
    const onHold = vi.fn();
    const hook = createSimulatedHook({ onHold, holdMs: 1000, enabled: false });

    hook.onTouchStart([{ clientX: 100, clientY: 100 }]);
    vi.advanceTimersByTime(2000);
    expect(onHold).not.toHaveBeenCalled();
    expect(hook.shouldSuppressClick()).toBe(false);
  });

  it('supports custom hold duration', () => {
    const onHold = vi.fn();
    const hook = createSimulatedHook({ onHold, holdMs: 500 });

    hook.onTouchStart([{ clientX: 100, clientY: 100 }]);
    vi.advanceTimersByTime(499);
    expect(onHold).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);
  });
});
