import { describe, it, expect } from 'vitest';
import {
  normalizeCrop,
  fitScale,
  screenToImage,
  imageToScreen,
  type Crop,
} from './index.js';

describe('annotate math', () => {
  it('normalizeCrop returns full image when null', () => {
    expect(normalizeCrop(null, 800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('normalizeCrop clamps a crop that overflows bounds', () => {
    const c: Crop = { x: -10, y: 500, w: 1000, h: 1000 };
    expect(normalizeCrop(c, 800, 600)).toEqual({ x: 0, y: 500, w: 800, h: 100 });
  });

  it('fitScale never exceeds 1 and fits the smaller axis', () => {
    expect(fitScale(400, 200, 800, 800)).toBe(1);      // already fits
    expect(fitScale(1600, 400, 800, 800)).toBe(0.5);   // width-bound
    expect(fitScale(400, 1600, 800, 800)).toBe(0.5);   // height-bound
  });

  it('screenToImage / imageToScreen round-trip with crop offset and scale', () => {
    const crop: Crop = { x: 100, y: 50, w: 400, h: 300 };
    const scale = 0.5;
    const img = screenToImage([20, 10], scale, crop);
    expect(img).toEqual([140, 70]); // 100 + 20/0.5 , 50 + 10/0.5
    expect(imageToScreen(img, scale, crop)).toEqual([20, 10]);
  });

  it('supports rect, rectangle, ellipse, oval shapes', () => {
    const s1: import('./index.js').Shape = { kind: 'rect', from: [0, 0], to: [10, 20], color: '#f00', width: 3 };
    const s2: import('./index.js').Shape = { kind: 'rectangle', from: [0, 0], to: [10, 20], color: '#f00', width: 3 };
    const s3: import('./index.js').Shape = { kind: 'ellipse', from: [0, 0], to: [10, 20], color: '#f00', width: 3 };
    const s4: import('./index.js').Shape = { kind: 'oval', from: [0, 0], to: [10, 20], color: '#f00', width: 3 };
    expect(s1.kind).toBe('rect');
    expect(s2.kind).toBe('rectangle');
    expect(s3.kind).toBe('ellipse');
    expect(s4.kind).toBe('oval');
  });
});
