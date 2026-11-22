import { describe, it, expect, vi } from 'vitest';
import type { Shape } from '@tierwyn/shared';
import { renderShapes } from './ImageAnnotator.js';

function createMockCtx() {
  const calls: string[] = [];
  const linesTo: Array<[number, number]> = [];
  const movesTo: Array<[number, number]> = [];
  const strokeRects: Array<[number, number, number, number]> = [];
  const ellipses: Array<[number, number, number, number]> = [];

  const ctx = {
    calls,
    linesTo,
    movesTo,
    strokeRects,
    ellipses,
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textBaseline: '',
    beginPath: vi.fn(() => { calls.push('beginPath'); }),
    moveTo: vi.fn((x: number, y: number) => {
      calls.push(`moveTo(${x.toFixed(1)},${y.toFixed(1)})`);
      movesTo.push([x, y]);
    }),
    lineTo: vi.fn((x: number, y: number) => {
      calls.push(`lineTo(${x.toFixed(1)},${y.toFixed(1)})`);
      linesTo.push([x, y]);
    }),
    stroke: vi.fn(() => { calls.push('stroke'); }),
    fill: vi.fn(() => { calls.push('fill'); }),
    closePath: vi.fn(() => { calls.push('closePath'); }),
    strokeRect: vi.fn((x: number, y: number, w: number, h: number) => {
      calls.push(`strokeRect(${x},${y},${w},${h})`);
      strokeRects.push([x, y, w, h]);
    }),
    ellipse: vi.fn((x: number, y: number, rx: number, ry: number) => {
      calls.push(`ellipse(${x},${y},${rx},${ry})`);
      ellipses.push([x, y, rx, ry]);
    }),
    fillText: vi.fn((text: string, x: number, y: number) => {
      calls.push(`fillText(${text},${x},${y})`);
    }),
  };

  return ctx as unknown as CanvasRenderingContext2D & {
    calls: string[];
    linesTo: Array<[number, number]>;
    movesTo: Array<[number, number]>;
    strokeRects: Array<[number, number, number, number]>;
    ellipses: Array<[number, number, number, number]>;
  };
}

describe('renderShapes', () => {
  it('renders arrow without line stroke reaching the arrowhead tip (removes tip dot)', () => {
    const ctx = createMockCtx();
    const arrow: Shape = {
      kind: 'arrow',
      from: [10, 10],
      to: [100, 10],
      color: '#ef4444',
      width: 6,
    };

    renderShapes(ctx, [arrow]);

    expect(ctx.strokeStyle).toBe('#ef4444');
    expect(ctx.fillStyle).toBe('#ef4444');
    expect(ctx.lineWidth).toBe(6);

    // The shaft stroke occurs before the arrowhead fill
    const strokeIdx = ctx.calls.indexOf('stroke');
    const fillIdx = ctx.calls.indexOf('fill');
    expect(strokeIdx).toBeGreaterThan(-1);
    expect(fillIdx).toBeGreaterThan(strokeIdx);

    // The line stroked does NOT reach the arrowhead tip (100, 10)
    // The shaft stops before the base of the arrowhead (head = max(10, 6*3) = 18, baseDist = 18 * cos(pi/6) = 15.588)
    const shaftLineTo = ctx.linesTo[0];
    expect(shaftLineTo).toBeDefined();
    expect(shaftLineTo[0]).toBeLessThan(100);
    expect(shaftLineTo[0]).toBeCloseTo(100 - 18 * Math.cos(Math.PI / 6), 1);
    expect(shaftLineTo[1]).toBeCloseTo(10, 1);

    // The arrowhead path begins with moveTo(to[0], to[1]) and fills the triangle
    expect(ctx.movesTo).toContainEqual([100, 10]);
    expect(ctx.calls).toContain('closePath');
    expect(ctx.calls).toContain('fill');
  });

  it('renders rectangular outlines for rect and rectangle kinds', () => {
    const ctx = createMockCtx();
    const shapes: Shape[] = [
      { kind: 'rect', from: [10, 20], to: [50, 70], color: '#3b82f6', width: 3 },
      { kind: 'rectangle', from: [100, 80], to: [40, 20], color: '#10b981', width: 6 },
    ];

    renderShapes(ctx, shapes);

    expect(ctx.strokeRects).toHaveLength(2);
    // [minX, minY, width, height]
    expect(ctx.strokeRects[0]).toEqual([10, 20, 40, 50]);
    expect(ctx.strokeRects[1]).toEqual([40, 20, 60, 60]);
  });

  it('renders ellipse and oval outlines (including circle)', () => {
    const ctx = createMockCtx();
    const shapes: Shape[] = [
      // Oval: width 80, height 40
      { kind: 'oval', from: [10, 10], to: [90, 50], color: '#ef4444', width: 3 },
      // Circle: width 60, height 60
      { kind: 'ellipse', from: [20, 20], to: [80, 80], color: '#3b82f6', width: 6 },
    ];

    renderShapes(ctx, shapes);

    expect(ctx.ellipses).toHaveLength(2);
    // [cx, cy, rx, ry]
    // Oval center = (50, 30), rx = 40, ry = 20
    expect(ctx.ellipses[0]).toEqual([50, 30, 40, 20]);
    // Circle center = (50, 50), rx = 30, ry = 30
    expect(ctx.ellipses[1]).toEqual([50, 50, 30, 30]);
  });
});
