import { ENABLE_ANNOTATIONS } from '../api';
import type {
  ArrowAnnotation,
  CropRect,
  PhotoAnnotation,
  PhotoParams,
  TextAnnotation,
} from '../types';

export const DEFAULT_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

export const DEFAULT_PHOTO_PARAMS: PhotoParams = {
  rotate: 0,
  crop: { ...DEFAULT_CROP },
  sharpness: 0,
  temperature: 0,
  annotations: [],
};

export const ANNOTATION_COLORS = [
  { id: 'red', label: 'Red', hex: '#DC2626' },
  { id: 'yellow', label: 'Yellow', hex: '#FACC15' },
  { id: 'white', label: 'White', hex: '#FFFFFF' },
  { id: 'black', label: 'Black', hex: '#000000' },
] as const;

export const MAX_ANNOTATIONS_PER_PHOTO = 30;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function normalizeRotation(deg: number): number {
  const n = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return n;
}

export function normalizeCrop(crop?: Partial<CropRect> | null): CropRect {
  if (!crop) return { ...DEFAULT_CROP };
  const x = clamp(Number(crop.x) || 0, 0, 0.95);
  const y = clamp(Number(crop.y) || 0, 0, 0.95);
  const w = clamp(Number(crop.w) || 1, 0.05, 1 - x);
  const h = clamp(Number(crop.h) || 1, 0.05, 1 - y);
  return { x, y, w, h };
}

export function normalizeAnnotations(
  raw?: unknown
): PhotoAnnotation[] {
  if (!Array.isArray(raw)) return [];
  const result: PhotoAnnotation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === 'arrow') {
      const arrow: ArrowAnnotation = {
        type: 'arrow',
        x1: clamp(Number(obj.x1) || 0, 0, 1),
        y1: clamp(Number(obj.y1) || 0, 0, 1),
        x2: clamp(Number(obj.x2) || 0, 0, 1),
        y2: clamp(Number(obj.y2) || 0, 0, 1),
        color: typeof obj.color === 'string' && obj.color ? obj.color : '#DC2626',
        width: clamp(Number(obj.width) || 0.005, 0.001, 0.05),
        double: Boolean(obj.double),
      };
      result.push(arrow);
    } else if (obj.type === 'text') {
      const textStr = typeof obj.text === 'string' ? obj.text : '';
      if (!textStr.trim()) continue;
      const rawRot = Number(obj.rotate);
      const rot: 0 | 90 | -90 =
        rawRot === 90 ? 90 : rawRot === -90 ? -90 : 0;
      const textAnn: TextAnnotation = {
        type: 'text',
        x: clamp(Number(obj.x) || 0.5, 0, 1),
        y: clamp(Number(obj.y) || 0.5, 0, 1),
        text: textStr,
        color: typeof obj.color === 'string' && obj.color ? obj.color : '#DC2626',
        size: clamp(Number(obj.size) || 0.045, 0.015, 0.2),
        rotate: rot,
        outline: obj.outline !== undefined ? Boolean(obj.outline) : true,
      };
      result.push(textAnn);
    }
    if (result.length >= MAX_ANNOTATIONS_PER_PHOTO) break;
  }
  return result;
}

export function normalizePhotoParams(
  raw?: PhotoParams | string | null
): PhotoParams {
  if (!raw) {
    return {
      rotate: 0,
      crop: { ...DEFAULT_CROP },
      sharpness: 0,
      temperature: 0,
      ...(ENABLE_ANNOTATIONS ? { annotations: [] } : {}),
    };
  }
  let parsed: Partial<PhotoParams> = {};
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as Partial<PhotoParams>;
    } catch {
      parsed = {};
    }
  } else {
    parsed = raw;
  }

  const base: PhotoParams = {
    rotate: normalizeRotation(Number(parsed.rotate) || 0),
    crop: normalizeCrop(parsed.crop),
    sharpness: clamp(Number(parsed.sharpness) || 0, 0, 100),
    temperature: clamp(Number(parsed.temperature) || 0, -100, 100),
  };

  if (ENABLE_ANNOTATIONS) {
    base.annotations = normalizeAnnotations(parsed.annotations);
  } else if (Array.isArray(parsed.annotations) && parsed.annotations.length > 0) {
    base.annotations = normalizeAnnotations(parsed.annotations);
  }

  return base;
}

export function rotateCropRect(crop: CropRect, direction: 'cw' | 'ccw'): CropRect {
  if (direction === 'cw') {
    return normalizeCrop({
      x: 1 - (crop.y + crop.h),
      y: crop.x,
      w: crop.h,
      h: crop.w,
    });
  }
  return normalizeCrop({
    x: crop.y,
    y: 1 - (crop.x + crop.w),
    w: crop.h,
    h: crop.w,
  });
}

export function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image.'));
    img.src = dataUrl;
  });
}

export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load selected image file.'));
    };
    img.src = url;
  });
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function isLightAnnotationColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === 'white' || c === 'yellow' || c === '#ffffff' || c === '#fff' || c === '#facc15') {
    return true;
  }
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(c);
  if (hexMatch) {
    const num = parseInt(hexMatch[1], 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62;
  }
  return false;
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  angle: number,
  headLength: number,
  headHalfWidth: number
) {
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - headLength * Math.cos(angle) + headHalfWidth * Math.sin(angle),
    tipY - headLength * Math.sin(angle) - headHalfWidth * Math.cos(angle)
  );
  ctx.lineTo(
    tipX - headLength * Math.cos(angle) - headHalfWidth * Math.sin(angle),
    tipY - headLength * Math.sin(angle) + headHalfWidth * Math.cos(angle)
  );
  ctx.closePath();
  ctx.fill();
}

export function measureTextAnnotationBox(
  ctx: CanvasRenderingContext2D,
  ann: TextAnnotation,
  imgWidth: number,
  imgHeight: number
): { fontSize: number; textWidth: number; textHeight: number; lines: string[] } {
  const fontSize = Math.max(10, ann.size * imgHeight);
  const lines = ann.text.split('\n');
  ctx.save();
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  let maxW = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  ctx.restore();
  const lineHeight = fontSize * 1.2;
  return {
    fontSize,
    textWidth: Math.max(fontSize * 0.6, maxW),
    textHeight: Math.max(fontSize, lines.length * lineHeight),
    lines,
  };
}

/**
 * Draws annotations in the coordinate space [offsetX, offsetX + width] x [offsetY, offsetY + height].
 * Always called LAST so annotations remain sharp and unfiltered.
 */
export function drawAnnotationsOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  annotations: PhotoAnnotation[],
  options?: {
    offsetX?: number;
    offsetY?: number;
    selectedIndex?: number | null;
    showHandles?: boolean;
  }
): void {
  if (!annotations || annotations.length === 0) return;

  const ox = options?.offsetX ?? 0;
  const oy = options?.offsetY ?? 0;
  const selectedIndex = options?.selectedIndex ?? null;
  const showHandles = options?.showHandles ?? false;

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, width, height);
  ctx.clip();

  annotations.forEach((ann, idx) => {
    const isSelected = selectedIndex === idx;

    if (ann.type === 'arrow') {
      const x1 = ox + ann.x1 * width;
      const y1 = oy + ann.y1 * height;
      const x2 = ox + ann.x2 * width;
      const y2 = oy + ann.y2 * height;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return;

      const angle = Math.atan2(dy, dx);
      const strokeW = Math.max(1.5, ann.width * width);
      const headLen = Math.min(dist * 0.42, Math.max(strokeW * 3.4, 10));
      const headHalfW = headLen * 0.46;

      // Trim shaft ends slightly so the shaft meets inside the triangular arrowhead cleanly
      const startTrim = ann.double ? headLen * 0.72 : 0;
      const endTrim = headLen * 0.72;
      const sx = x1 + Math.cos(angle) * startTrim;
      const sy = y1 + Math.sin(angle) * startTrim;
      const ex = x2 - Math.cos(angle) * endTrim;
      const ey = y2 - Math.sin(angle) * endTrim;

      ctx.save();
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = strokeW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Subtle selection halo
      if (isSelected && showHandles) {
        ctx.save();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)';
        ctx.lineWidth = strokeW + 6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }

      if (dist > startTrim + endTrim) {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }

      // End arrowhead
      drawArrowHead(ctx, x2, y2, angle, headLen, headHalfW);
      // Optional start arrowhead (double arrow)
      if (ann.double) {
        drawArrowHead(ctx, x1, y1, angle + Math.PI, headLen, headHalfW);
      }

      // Round handles on both ends when selected
      if (isSelected && showHandles) {
        const handleR = Math.max(7, Math.min(12, width * 0.018));
        for (const [hx, hy] of [
          [x1, y1],
          [x2, y2],
        ]) {
          ctx.beginPath();
          ctx.arc(hx, hy, handleR, 0, Math.PI * 2);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#1F3A8A';
          ctx.stroke();
        }
      }

      ctx.restore();
    } else if (ann.type === 'text') {
      const cx = ox + ann.x * width;
      const cy = oy + ann.y * height;
      const { fontSize, textWidth, textHeight, lines } =
        measureTextAnnotationBox(ctx, ann, width, height);
      const lineHeight = fontSize * 1.2;

      ctx.save();
      ctx.translate(cx, cy);
      if (ann.rotate !== 0) {
        ctx.rotate((ann.rotate * Math.PI) / 180);
      }
      ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const startY = -((lines.length - 1) * lineHeight) / 2;

      if (ann.outline) {
        ctx.strokeStyle = isLightAnnotationColor(ann.color)
          ? '#000000'
          : '#FFFFFF';
        ctx.lineWidth = Math.max(2, fontSize * 0.14);
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        lines.forEach((line, li) => {
          ctx.strokeText(line, 0, startY + li * lineHeight);
        });
      }

      ctx.fillStyle = ann.color;
      lines.forEach((line, li) => {
        ctx.fillText(line, 0, startY + li * lineHeight);
      });

      if (isSelected && showHandles) {
        const padX = Math.max(6, fontSize * 0.25);
        const padY = Math.max(4, fontSize * 0.18);
        ctx.strokeStyle = '#3B82F6';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(
          -textWidth / 2 - padX,
          -textHeight / 2 - padY,
          textWidth + padX * 2,
          textHeight + padY * 2
        );
      }

      ctx.restore();
    }
  });

  ctx.restore();
}

/**
 * Applies temperature (warm/cool red & blue channel shift) and unsharp mask sharpness
 * directly to an ImageData buffer in place.
 */
export function applyTemperatureAndSharpness(
  imageData: ImageData,
  temperature: number,
  sharpness: number
): ImageData {
  const { data, width, height } = imageData;
  const len = data.length;

  // 1. Temperature (-100 to +100): shift red and blue channels
  if (temperature !== 0) {
    const shift = (temperature / 100) * 45;
    const greenShift = shift * 0.1;
    for (let i = 0; i < len; i += 4) {
      data[i] = clamp(data[i] + shift, 0, 255);
      data[i + 1] = clamp(data[i + 1] + greenShift, 0, 255);
      data[i + 2] = clamp(data[i + 2] - shift, 0, 255);
    }
  }

  // 2. Sharpness (0 to 100): unsharp mask using a 3x3 Gaussian blur kernel
  if (sharpness > 0 && width >= 3 && height >= 3) {
    const amount = (sharpness / 100) * 1.8;
    const src = new Uint8ClampedArray(data);
    const rowStride = width * 4;

    for (let y = 1; y < height - 1; y++) {
      const rowOffset = y * rowStride;
      const prevRow = rowOffset - rowStride;
      const nextRow = rowOffset + rowStride;

      for (let x = 1; x < width - 1; x++) {
        const idx = rowOffset + x * 4;
        const pL = prevRow + (x - 1) * 4;
        const pC = prevRow + x * 4;
        const pR = prevRow + (x + 1) * 4;
        const cL = idx - 4;
        const cR = idx + 4;
        const nL = nextRow + (x - 1) * 4;
        const nC = nextRow + x * 4;
        const nR = nextRow + (x + 1) * 4;

        for (let c = 0; c < 3; c++) {
          const orig = src[idx + c];
          const blur =
            (src[pL + c] +
              2 * src[pC + c] +
              src[pR + c] +
              2 * src[cL + c] +
              4 * orig +
              2 * src[cR + c] +
              src[nL + c] +
              2 * src[nC + c] +
              src[nR + c]) /
            16;
          const sharpened = orig + amount * (orig - blur);
          data[idx + c] = sharpened < 0 ? 0 : sharpened > 255 ? 255 : sharpened;
        }
      }
    }
  }

  return imageData;
}

/**
 * Renders the source image rotated by 0/90/180/270 degrees, optionally scaled
 * so its longest side does not exceed maxDim.
 */
export function renderRotatedCanvas(
  img: HTMLImageElement,
  rotate: number,
  maxDim?: number
): HTMLCanvasElement {
  const deg = normalizeRotation(rotate);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const isOdd = deg === 90 || deg === 270;

  let outW = isOdd ? srcH : srcW;
  let outH = isOdd ? srcW : srcH;

  if (maxDim && Math.max(outW, outH) > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((deg * Math.PI) / 180);
  if (isOdd) {
    ctx.drawImage(img, -outH / 2, -outW / 2, outH, outW);
  } else {
    ctx.drawImage(img, -outW / 2, -outH / 2, outW, outH);
  }
  ctx.restore();
  return canvas;
}

/**
 * Builds the untouched original JPEG with longest side <= 2400px, quality 0.9.
 * Returns base64 string WITHOUT the data:...;base64, prefix.
 */
export function buildOriginalJpegBase64(img: HTMLImageElement): string {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const maxSide = 2400;

  let outW = srcW;
  let outH = srcH;
  if (Math.max(srcW, srcH) > maxSide) {
    const scale = maxSide / Math.max(srcW, srcH);
    outW = Math.max(1, Math.round(srcW * scale));
    outH = Math.max(1, Math.round(srcH * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, outW, outH);
  }
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return stripDataUrlPrefix(dataUrl);
}

/**
 * Builds the edited JPEG: rotate -> crop -> resize (longest side <= maxSide, default 1600px, 2400px for SYSTEM) ->
 * temperature -> sharpness (unsharp mask) -> annotations (drawn LAST so sharp & unfiltered) -> JPEG quality 0.85.
 * Returns base64 WITHOUT prefix plus full dataUrl for immediate thumbnail rendering.
 */
export function buildEditedJpegBase64(
  img: HTMLImageElement,
  params: PhotoParams,
  maxSide = 1600
): { base64: string; dataUrl: string } {
  const normalized = normalizePhotoParams(params);
  // First render full rotated canvas (capped safely at 3600px before crop to preserve crop detail)
  const rotatedCanvas = renderRotatedCanvas(img, normalized.rotate, 3600);
  const rotW = rotatedCanvas.width;
  const rotH = rotatedCanvas.height;

  const cropX = Math.round(normalized.crop.x * rotW);
  const cropY = Math.round(normalized.crop.y * rotH);
  const cropW = Math.max(1, Math.round(normalized.crop.w * rotW));
  const cropH = Math.max(1, Math.round(normalized.crop.h * rotH));

  let outW = cropW;
  let outH = cropH;
  if (Math.max(cropW, cropH) > maxSide) {
    const scale = maxSide / Math.max(cropW, cropH);
    outW = Math.max(1, Math.round(cropW * scale));
    outH = Math.max(1, Math.round(cropH * scale));
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(rotatedCanvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

    if (normalized.temperature !== 0 || normalized.sharpness > 0) {
      const imageData = ctx.getImageData(0, 0, outW, outH);
      applyTemperatureAndSharpness(
        imageData,
        normalized.temperature,
        normalized.sharpness
      );
      ctx.putImageData(imageData, 0, 0);
    }

    // Draw annotations LAST so they stay sharp and unfiltered
    if (
      ENABLE_ANNOTATIONS &&
      Array.isArray(normalized.annotations) &&
      normalized.annotations.length > 0
    ) {
      drawAnnotationsOnCanvas(ctx, outW, outH, normalized.annotations);
    }
  }

  const dataUrl = outCanvas.toDataURL('image/jpeg', 0.85);
  return {
    base64: stripDataUrlPrefix(dataUrl),
    dataUrl,
  };
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
