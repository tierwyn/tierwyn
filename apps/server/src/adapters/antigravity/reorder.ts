/**
 * ReorderBuffer — re-sequences out-of-order frames from Antigravity.
 *
 * When a frame carries an optional numeric `seq` (0-based contiguous counter),
 * the buffer holds back frames that arrive out of order and releases only the
 * contiguous in-order prefix. Frames with no `seq` pass through immediately in
 * arrival order (the live agy plain-text case, where no sequence ids are emitted).
 *
 * Example (seq-based): pushes of seq=2, seq=0, seq=1 emit values in order 0,1,2.
 * Example (seq-less):  pushes are returned immediately, each call returns [value].
 */
export class ReorderBuffer<T> {
  private _next = 0;
  private _pending = new Map<number, T>();

  /**
   * Push a frame and return the array of values now emittable in correct order.
   *
   * - Frame with no `seq`: returned immediately (pass-through).
   * - Frame with `seq`: buffered until the contiguous prefix starting at `_next`
   *   can be released.
   */
  push(frame: { seq?: number; value: T }): T[] {
    if (frame.seq === undefined) {
      // No sequence id — pass straight through in arrival order.
      return [frame.value];
    }

    this._pending.set(frame.seq, frame.value);
    return this._drain();
  }

  /**
   * Drain all remaining buffered frames at stream end.
   * Releases frames in seq order regardless of gaps.
   */
  flush(): T[] {
    if (this._pending.size === 0) return [];
    const keys = [...this._pending.keys()].sort((a, b) => a - b);
    const out: T[] = [];
    for (const k of keys) {
      out.push(this._pending.get(k)!);
      this._pending.delete(k);
    }
    this._next = keys[keys.length - 1] + 1;
    return out;
  }

  private _drain(): T[] {
    const out: T[] = [];
    while (this._pending.has(this._next)) {
      out.push(this._pending.get(this._next)!);
      this._pending.delete(this._next);
      this._next++;
    }
    return out;
  }
}
