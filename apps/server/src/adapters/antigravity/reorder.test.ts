import { describe, it, expect } from 'vitest';
import { ReorderBuffer } from './reorder.js';

describe('ReorderBuffer', () => {
  describe('seq-less frames (plain-text agy)', () => {
    it('passes frames through immediately in arrival order', () => {
      const buf = new ReorderBuffer<string>();
      expect(buf.push({ value: 'a' })).toEqual(['a']);
      expect(buf.push({ value: 'b' })).toEqual(['b']);
      expect(buf.push({ value: 'c' })).toEqual(['c']);
    });

    it('flush returns [] when nothing is buffered', () => {
      const buf = new ReorderBuffer<string>();
      buf.push({ value: 'x' });
      expect(buf.flush()).toEqual([]);
    });
  });

  describe('seq-based frames (future JSON mode)', () => {
    it('emits in-order frames immediately', () => {
      const buf = new ReorderBuffer<string>();
      expect(buf.push({ seq: 0, value: 'first' })).toEqual(['first']);
      expect(buf.push({ seq: 1, value: 'second' })).toEqual(['second']);
    });

    it('buffers out-of-order frames and releases contiguous prefix', () => {
      const buf = new ReorderBuffer<string>();

      // seq=2 arrives first — nothing emittable yet
      expect(buf.push({ seq: 2, value: 'C' })).toEqual([]);

      // seq=0 arrives — emits seq=0 only (seq=1 still missing)
      expect(buf.push({ seq: 0, value: 'A' })).toEqual(['A']);

      // seq=1 arrives — unlocks seq=1 and seq=2
      expect(buf.push({ seq: 1, value: 'B' })).toEqual(['B', 'C']);
    });

    it('flush drains remaining buffered frames in seq order even with gaps', () => {
      const buf = new ReorderBuffer<string>();
      buf.push({ seq: 3, value: 'D' });
      buf.push({ seq: 1, value: 'B' });
      // Nothing emitted yet because seq=0 never arrived.
      const drained = buf.flush();
      expect(drained).toEqual(['B', 'D']);
    });

    it('flush returns [] when buffer is empty', () => {
      const buf = new ReorderBuffer<string>();
      expect(buf.flush()).toEqual([]);
    });

    it('handles a larger out-of-order sequence', () => {
      const buf = new ReorderBuffer<number>();
      // Push 4,2,0,3,1 — expect each push to release what it can
      expect(buf.push({ seq: 4, value: 4 })).toEqual([]);
      expect(buf.push({ seq: 2, value: 2 })).toEqual([]);
      expect(buf.push({ seq: 0, value: 0 })).toEqual([0]);
      expect(buf.push({ seq: 3, value: 3 })).toEqual([]);
      expect(buf.push({ seq: 1, value: 1 })).toEqual([1, 2, 3, 4]);
    });
  });
});
