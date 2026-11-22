import React, { useCallback, useRef, useEffect } from 'react';
import type { TouchEvent as ReactTouchEvent, MouseEvent as ReactMouseEvent } from 'react';

/** Max finger travel (px) still counted as a tap/hold, not a scroll/swipe. */
const TAP_SLOP_PX = 12;

/**
 * Touch handlers that only fire `onTap` for a short press with little movement.
 * Scroll/swipe release does NOT select — fixes mobile command/skill pickers
 * where `onTouchEnd → pick()` was selecting the row under the finger on lift.
 *
 * Does not call preventDefault on touchstart (that blocks list scrolling).
 * preventDefault on a confirmed tap blocks the synthetic mouse click that
 * would otherwise double-fire with onMouseDown.
 */
export function useTapSelect(onTap: () => void) {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  const onTouchStart = useCallback((e: ReactTouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    origin.current = { x: t.clientX, y: t.clientY };
    moved.current = false;
  }, []);

  const onTouchMove = useCallback((e: ReactTouchEvent) => {
    if (!origin.current || moved.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - origin.current.x;
    const dy = t.clientY - origin.current.y;
    if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) {
      moved.current = true;
    }
  }, []);

  const onTouchEnd = useCallback((e: ReactTouchEvent) => {
    const wasTap = origin.current != null && !moved.current;
    origin.current = null;
    moved.current = false;
    if (!wasTap) return;
    e.preventDefault();
    onTap();
  }, [onTap]);

  const onTouchCancel = useCallback(() => {
    origin.current = null;
    moved.current = false;
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
}

export interface UseTouchHoldOptions {
  /** Callback fired when touched and held for holdMs without moving beyond slop distance. */
  onHold?: () => void;
  /** Duration in ms to trigger onHold. Defaults to 1000 (1 second). */
  holdMs?: number;
  /** Whether the touch-and-hold action is enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Touch handlers that fire `onHold` when the user touches and holds for `holdMs` (default 1s)
 * without scrolling/moving beyond `TAP_SLOP_PX`.
 */
export function useTouchHold({
  onHold,
  holdMs = 1000,
  enabled = true,
}: UseTouchHoldOptions) {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldDuringThisTouch = useRef(false);
  const lastHoldTimestamp = useRef(0);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      heldDuringThisTouch.current = false;
      clearTimer();
      if (!enabled || !onHold) return;
      const t = e.touches[0];
      if (!t) return;
      origin.current = { x: t.clientX, y: t.clientY };
      moved.current = false;

      timer.current = setTimeout(() => {
        heldDuringThisTouch.current = true;
        lastHoldTimestamp.current = Date.now();
        timer.current = null;
        try {
          if (typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate(50);
          }
        } catch {
          /* ignore */
        }
        onHold();
      }, holdMs);
    },
    [enabled, onHold, holdMs, clearTimer]
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      if (!origin.current || moved.current) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - origin.current.x;
      const dy = t.clientY - origin.current.y;
      if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) {
        moved.current = true;
        clearTimer();
      }
    },
    [clearTimer]
  );

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent) => {
      clearTimer();
      const wasHeld = heldDuringThisTouch.current;
      origin.current = null;
      moved.current = false;
      if (wasHeld) {
        lastHoldTimestamp.current = Date.now();
        if (e.cancelable) {
          e.preventDefault();
        }
      }
    },
    [clearTimer]
  );

  const onTouchCancel = useCallback(() => {
    clearTimer();
    origin.current = null;
    moved.current = false;
    heldDuringThisTouch.current = false;
  }, [clearTimer]);

  const shouldSuppressClick = useCallback(() => {
    const now = Date.now();
    return heldDuringThisTouch.current || now - lastHoldTimestamp.current < 800;
  }, []);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    shouldSuppressClick,
  };
}

export interface TouchHoldButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Callback fired when touched and held for holdMs without moving beyond slop distance. */
  onHold?: () => void;
  /** Duration in ms to trigger onHold. Defaults to 1000 (1 second). */
  holdMs?: number;
  /** Whether the touch-and-hold action is enabled (e.g. only when item has children). Defaults to true. */
  holdEnabled?: boolean;
}

/**
 * Button component supporting touch-and-hold (e.g. 1-second hold to expand/collapse).
 * - On desktop: normal mouse clicks trigger onClick immediately.
 * - On touch/mobile: normal tap (< holdMs) triggers onClick.
 * - On touch/mobile: scrolling/swiping cancels the hold timer without triggering onHold or onClick.
 * - On touch/mobile: holding for holdMs triggers onHold (with haptic feedback) and suppresses subsequent synthetic click events.
 */
export const TouchHoldButton = React.forwardRef<HTMLButtonElement, TouchHoldButtonProps>(
  function TouchHoldButton(
    {
      onHold,
      holdMs = 1000,
      holdEnabled = true,
      onClick,
      onTouchStart: userOnTouchStart,
      onTouchMove: userOnTouchMove,
      onTouchEnd: userOnTouchEnd,
      onTouchCancel: userOnTouchCancel,
      ...props
    },
    ref
  ) {
    const {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel,
      shouldSuppressClick,
    } = useTouchHold({
      onHold,
      holdMs,
      enabled: holdEnabled,
    });

    const handleTouchStart = useCallback(
      (e: ReactTouchEvent<HTMLButtonElement>) => {
        userOnTouchStart?.(e);
        onTouchStart(e);
      },
      [userOnTouchStart, onTouchStart]
    );

    const handleTouchMove = useCallback(
      (e: ReactTouchEvent<HTMLButtonElement>) => {
        userOnTouchMove?.(e);
        onTouchMove(e);
      },
      [userOnTouchMove, onTouchMove]
    );

    const handleTouchEnd = useCallback(
      (e: ReactTouchEvent<HTMLButtonElement>) => {
        userOnTouchEnd?.(e);
        onTouchEnd(e);
      },
      [userOnTouchEnd, onTouchEnd]
    );

    const handleTouchCancel = useCallback(
      (e: ReactTouchEvent<HTMLButtonElement>) => {
        userOnTouchCancel?.(e);
        onTouchCancel();
      },
      [userOnTouchCancel, onTouchCancel]
    );

    const handleClick = useCallback(
      (e: ReactMouseEvent<HTMLButtonElement>) => {
        if (shouldSuppressClick()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onClick?.(e);
      },
      [shouldSuppressClick, onClick]
    );

    return React.createElement('button', {
      ...props,
      ref,
      onClick: handleClick,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
    });
  }
);

