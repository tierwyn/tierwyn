/** Point in image-space (natural pixels). */
export type Pt = [number, number];

/** A single annotation. All coordinates are image-space. */
export type Shape =
  | { kind: 'pen';       points: Pt[]; color: string; width: number }
  | { kind: 'arrow';     from: Pt; to: Pt; color: string; width: number }
  | { kind: 'rect' | 'rectangle'; from: Pt; to: Pt; color: string; width: number }
  | { kind: 'ellipse' | 'oval';   from: Pt; to: Pt; color: string; width: number }
  | { kind: 'highlight'; points: Pt[]; color: string; width: number }
  | { kind: 'text';      at: Pt; value: string; color: string; size: number };

/** Non-destructive crop rectangle in image-space. */
export type Crop = { x: number; y: number; w: number; h: number };

/** Full editor state captured per undo snapshot. */
export type AnnotateState = { shapes: Shape[]; crop: Crop | null };

/** Full-image crop when null; otherwise clamp into [0,imgW]x[0,imgH]. */
export function normalizeCrop(crop: Crop | null, imgW: number, imgH: number): Crop {
  if (!crop) return { x: 0, y: 0, w: imgW, h: imgH };
  const x = Math.min(Math.max(crop.x, 0), imgW);
  const y = Math.min(Math.max(crop.y, 0), imgH);
  const w = Math.min(Math.max(crop.w, 1), imgW - x);
  const h = Math.min(Math.max(crop.h, 1), imgH - y);
  return { x, y, w, h };
}

/** Largest scale ≤ 1 that fits a cropW×cropH region into a maxW×maxH box. */
export function fitScale(cropW: number, cropH: number, maxW: number, maxH: number): number {
  return Math.min(maxW / cropW, maxH / cropH, 1);
}

/** Screen point (within the scaled canvas) → image-space point. */
export function screenToImage(screen: Pt, scale: number, crop: Crop): Pt {
  return [crop.x + screen[0] / scale, crop.y + screen[1] / scale];
}

/** Image-space point → screen point within the scaled canvas. */
export function imageToScreen(image: Pt, scale: number, crop: Crop): Pt {
  return [(image[0] - crop.x) * scale, (image[1] - crop.y) * scale];
}
