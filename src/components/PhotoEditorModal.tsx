import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowUpRight,
  Crop,
  MousePointer2,
  RotateCcw,
  RotateCw,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { ENABLE_ANNOTATIONS } from '../api';
import type {
  ArrowAnnotation,
  CropRect,
  PhotoAnnotation,
  PhotoParams,
  TextAnnotation,
} from '../types';
import {
  ANNOTATION_COLORS,
  DEFAULT_CROP,
  MAX_ANNOTATIONS_PER_PHOTO,
  applyTemperatureAndSharpness,
  drawAnnotationsOnCanvas,
  measureTextAnnotationBox,
  normalizeCrop,
  normalizePhotoParams,
  normalizeRotation,
  renderRotatedCanvas,
  rotateCropRect,
} from '../utils/imageProcessing';
import { ConfirmDialog } from './ConfirmDialog';

interface PhotoEditorModalProps {
  open: boolean;
  sourceImage: HTMLImageElement | null;
  initialParams: PhotoParams;
  title?: string;
  onCancel: () => void;
  onSave: (params: PhotoParams) => void;
}

type CropDragMode =
  | { type: 'new'; startX: number; startY: number }
  | { type: 'move'; startX: number; startY: number; orig: CropRect }
  | {
      type: 'handle';
      corner: 'nw' | 'ne' | 'sw' | 'se';
      orig: CropRect;
    };

type AnnotateDragMode =
  | { type: 'draw-arrow'; startX: number; startY: number }
  | {
      type: 'move-arrow';
      index: number;
      startX: number;
      startY: number;
      orig: ArrowAnnotation;
      snapshotPushed: boolean;
    }
  | {
      type: 'arrow-handle';
      index: number;
      end: 'start' | 'end';
      snapshotPushed: boolean;
    }
  | {
      type: 'move-text';
      index: number;
      startX: number;
      startY: number;
      orig: TextAnnotation;
      snapshotPushed: boolean;
    };

type PendingClearAction =
  | { kind: 'rotate'; delta: -90 | 90 }
  | { kind: 'reset-crop' }
  | { kind: 'start-crop' };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function pointToSegmentDistPx(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp01(((px - x1) * dx + (py - y1) * dy) / lenSq);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function PhotoEditorModal({
  open,
  sourceImage,
  initialParams,
  title = 'Edit photo',
  onCancel,
  onSave,
}: PhotoEditorModalProps) {
  const [params, setParams] = useState<PhotoParams>(() =>
    normalizePhotoParams(initialParams)
  );
  const [saving, setSaving] = useState(false);

  // Two-mode switch (only shown when ENABLE_ANNOTATIONS is true)
  const [editorMode, setEditorMode] = useState<'adjust' | 'annotate'>('adjust');

  // Annotate tool state
  const [tool, setTool] = useState<'select' | 'arrow' | 'text'>('select');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [undoStack, setUndoStack] = useState<PhotoAnnotation[][]>([]);

  // Shared & tool-specific annotation defaults
  const [annColor, setAnnColor] = useState<string>(ANNOTATION_COLORS[0].hex);
  const [arrowThickness, setArrowThickness] = useState<number>(5); // 2..12, default 5
  const [doubleArrow, setDoubleArrow] = useState<boolean>(false);
  const [textSizePct, setTextSizePct] = useState<number>(4.5); // 2..12 (% of height)
  const [textRotate, setTextRotate] = useState<0 | 90 | -90>(0);
  const [textOutline, setTextOutline] = useState<boolean>(true);

  // Live draft arrow while dragging
  const [draftArrow, setDraftArrow] = useState<ArrowAnnotation | null>(null);

  // Pending text placement box after tapping in Text tool
  const [pendingText, setPendingText] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  // Confirmation dialog when changing rotation/crop after placing annotations
  const [pendingClearAction, setPendingClearAction] =
    useState<PendingClearAction | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  const basePreviewRef = useRef<ImageData | null>(null);
  const previewDimsRef = useRef<{ width: number; height: number }>({
    width: 1,
    height: 1,
  });
  const cropDragRef = useRef<CropDragMode | null>(null);
  const annDragRef = useRef<AnnotateDragMode | null>(null);
  const rafRef = useRef<number | null>(null);

  const annotations: PhotoAnnotation[] = params.annotations ?? [];
  const hasAnnotations = ENABLE_ANNOTATIONS && annotations.length > 0;
  const activeMode = ENABLE_ANNOTATIONS ? editorMode : 'adjust';

  // Sync params whenever a new image or initialParams opens
  useEffect(() => {
    if (open) {
      setParams(normalizePhotoParams(initialParams));
      setSaving(false);
      setEditorMode('adjust');
      setTool('select');
      setSelectedIndex(null);
      setUndoStack([]);
      setDraftArrow(null);
      setPendingText(null);
      setPendingClearAction(null);
    }
  }, [open, sourceImage, initialParams]);

  // Focus text input when user taps canvas in Text tool
  useEffect(() => {
    if (pendingText) {
      requestAnimationFrame(() => textInputRef.current?.focus());
    }
  }, [pendingText !== null]);

  // Rebuild base preview ImageData whenever sourceImage, rotation, mode, or crop (in annotate mode) changes
  useEffect(() => {
    if (!open || !sourceImage) return;

    const rotated = renderRotatedCanvas(sourceImage, params.rotate, 900);

    if (activeMode === 'annotate') {
      const rotW = rotated.width;
      const rotH = rotated.height;
      const cx = Math.round(params.crop.x * rotW);
      const cy = Math.round(params.crop.y * rotH);
      const cw = Math.max(1, Math.round(params.crop.w * rotW));
      const ch = Math.max(1, Math.round(params.crop.h * rotH));

      const croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = cw;
      croppedCanvas.height = ch;
      const cctx = croppedCanvas.getContext('2d');
      if (!cctx) return;
      cctx.drawImage(rotated, cx, cy, cw, ch, 0, 0, cw, ch);

      basePreviewRef.current = cctx.getImageData(0, 0, cw, ch);
      previewDimsRef.current = { width: cw, height: ch };

      const displayCanvas = canvasRef.current;
      if (displayCanvas) {
        displayCanvas.width = cw;
        displayCanvas.height = ch;
      }
    } else {
      const ctx = rotated.getContext('2d');
      if (!ctx) return;
      basePreviewRef.current = ctx.getImageData(0, 0, rotated.width, rotated.height);
      previewDimsRef.current = { width: rotated.width, height: rotated.height };

      const displayCanvas = canvasRef.current;
      if (displayCanvas) {
        displayCanvas.width = rotated.width;
        displayCanvas.height = rotated.height;
      }
    }
  }, [
    open,
    sourceImage,
    params.rotate,
    activeMode,
    params.crop.x,
    params.crop.y,
    params.crop.w,
    params.crop.h,
  ]);

  // Live preview of temperature, sharpness, and annotations (drawn LAST)
  useEffect(() => {
    if (!open || !sourceImage) return;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      const displayCanvas = canvasRef.current;
      const baseData = basePreviewRef.current;
      if (!displayCanvas || !baseData) return;

      const { width, height } = previewDimsRef.current;
      if (displayCanvas.width !== width || displayCanvas.height !== height) {
        displayCanvas.width = width;
        displayCanvas.height = height;
      }

      const ctx = displayCanvas.getContext('2d');
      if (!ctx) return;

      const copy = new ImageData(
        new Uint8ClampedArray(baseData.data),
        baseData.width,
        baseData.height
      );
      if (params.temperature !== 0 || params.sharpness > 0) {
        applyTemperatureAndSharpness(copy, params.temperature, params.sharpness);
      }
      ctx.putImageData(copy, 0, 0);

      // Draw annotations LAST so they remain sharp and unfiltered in live preview
      if (ENABLE_ANNOTATIONS) {
        const listToDraw: PhotoAnnotation[] = [...annotations];
        if (activeMode === 'annotate' && draftArrow) {
          listToDraw.push(draftArrow);
        }
        if (activeMode === 'annotate' && pendingText && pendingText.text.trim()) {
          listToDraw.push({
            type: 'text',
            x: pendingText.x,
            y: pendingText.y,
            text: pendingText.text,
            color: annColor,
            size: textSizePct / 100,
            rotate: textRotate,
            outline: textOutline,
          });
        }

        if (listToDraw.length > 0) {
          if (activeMode === 'annotate') {
            drawAnnotationsOnCanvas(ctx, width, height, listToDraw, {
              selectedIndex: selectedIndex,
              showHandles: true,
            });
          } else {
            // In Adjust mode, draw existing annotations inside the crop rect so they stay visible live
            drawAnnotationsOnCanvas(
              ctx,
              params.crop.w * width,
              params.crop.h * height,
              listToDraw,
              {
                offsetX: params.crop.x * width,
                offsetY: params.crop.y * height,
                selectedIndex: null,
                showHandles: false,
              }
            );
          }
        }
      }
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [
    open,
    sourceImage,
    activeMode,
    params.rotate,
    params.temperature,
    params.sharpness,
    params.crop,
    annotations,
    selectedIndex,
    draftArrow,
    pendingText,
    annColor,
    textSizePct,
    textRotate,
    textOutline,
  ]);

  if (!open || !sourceImage) return null;

  const isCropped =
    params.crop.x > 0.002 ||
    params.crop.y > 0.002 ||
    params.crop.w < 0.998 ||
    params.crop.h < 0.998;

  const selectedAnn =
    selectedIndex !== null && selectedIndex >= 0 && selectedIndex < annotations.length
      ? annotations[selectedIndex]
      : null;

  function setAnnotationsWithUndo(
    updater: (prev: PhotoAnnotation[]) => PhotoAnnotation[],
    pushSnapshot = true
  ) {
    setParams((prev) => {
      const current = prev.annotations ?? [];
      if (pushSnapshot) {
        setUndoStack((stack) => [...stack.slice(-29), current]);
      }
      return {
        ...prev,
        annotations: updater(current),
      };
    });
  }

  function pushUndoSnapshot(snapshot: PhotoAnnotation[]) {
    setUndoStack((stack) => [...stack.slice(-29), snapshot]);
  }

  function handleUndo() {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1];
      setParams((prev) => ({
        ...prev,
        annotations: previous,
      }));
      setSelectedIndex(null);
      return stack.slice(0, -1);
    });
  }

  function handleDeleteSelected() {
    if (selectedIndex === null) return;
    const idxToRemove = selectedIndex;
    setAnnotationsWithUndo((prev) => prev.filter((_, idx) => idx !== idxToRemove));
    setSelectedIndex(null);
  }

  function getRelativePoint(e: ReactPointerEvent<HTMLDivElement>) {
    const el = overlayRef.current;
    if (!el) return { x: 0, y: 0, width: 1, height: 1 };
    const rect = el.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((e.clientY - rect.top) / Math.max(1, rect.height)),
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  }

  // --- ADJUST MODE POINTER HANDLERS ---
  function handleAdjustPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (hasAnnotations) {
      setPendingClearAction({ kind: 'start-crop' });
      return;
    }

    const pt = getRelativePoint(e);
    const c = params.crop;
    const hitRadius = 0.075;

    const corners: { key: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
      { key: 'nw', x: c.x, y: c.y },
      { key: 'ne', x: c.x + c.w, y: c.y },
      { key: 'sw', x: c.x, y: c.y + c.h },
      { key: 'se', x: c.x + c.w, y: c.y + c.h },
    ];

    e.currentTarget.setPointerCapture(e.pointerId);

    if (isCropped) {
      for (const corner of corners) {
        if (
          Math.abs(pt.x - corner.x) <= hitRadius &&
          Math.abs(pt.y - corner.y) <= hitRadius
        ) {
          cropDragRef.current = { type: 'handle', corner: corner.key, orig: { ...c } };
          return;
        }
      }

      if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h) {
        cropDragRef.current = {
          type: 'move',
          startX: pt.x,
          startY: pt.y,
          orig: { ...c },
        };
        return;
      }
    }

    cropDragRef.current = { type: 'new', startX: pt.x, startY: pt.y };
  }

  function handleAdjustPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = cropDragRef.current;
    if (!drag) return;
    const pt = getRelativePoint(e);
    const minSize = 0.06;

    if (drag.type === 'new') {
      const x1 = Math.min(drag.startX, pt.x);
      const y1 = Math.min(drag.startY, pt.y);
      const x2 = Math.max(drag.startX, pt.x);
      const y2 = Math.max(drag.startY, pt.y);
      if (x2 - x1 >= 0.02 || y2 - y1 >= 0.02) {
        setParams((prev) => ({
          ...prev,
          crop: normalizeCrop({
            x: x1,
            y: y1,
            w: Math.max(minSize, x2 - x1),
            h: Math.max(minSize, y2 - y1),
          }),
        }));
      }
      return;
    }

    if (drag.type === 'move') {
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      const nextX = Math.max(0, Math.min(1 - drag.orig.w, drag.orig.x + dx));
      const nextY = Math.max(0, Math.min(1 - drag.orig.h, drag.orig.y + dy));
      setParams((prev) => ({
        ...prev,
        crop: { ...drag.orig, x: nextX, y: nextY },
      }));
      return;
    }

    if (drag.type === 'handle') {
      const { orig, corner } = drag;
      let left = orig.x;
      let top = orig.y;
      let right = orig.x + orig.w;
      let bottom = orig.y + orig.h;

      if (corner === 'nw' || corner === 'sw') {
        left = Math.min(pt.x, right - minSize);
      }
      if (corner === 'ne' || corner === 'se') {
        right = Math.max(pt.x, left + minSize);
      }
      if (corner === 'nw' || corner === 'ne') {
        top = Math.min(pt.y, bottom - minSize);
      }
      if (corner === 'sw' || corner === 'se') {
        bottom = Math.max(pt.y, top + minSize);
      }

      left = clamp01(left);
      top = clamp01(top);
      right = clamp01(right);
      bottom = clamp01(bottom);

      setParams((prev) => ({
        ...prev,
        crop: normalizeCrop({
          x: left,
          y: top,
          w: Math.max(minSize, right - left),
          h: Math.max(minSize, bottom - top),
        }),
      }));
    }
  }

  function handleAdjustPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (cropDragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      cropDragRef.current = null;
    }
  }

  // --- ANNOTATE MODE HIT TESTING & POINTER HANDLERS ---
  function hitTestAnnotations(
    px: number,
    py: number,
    boxW: number,
    boxH: number
  ): { index: number; handle?: 'start' | 'end' } | null {
    const clickX = px * boxW;
    const clickY = py * boxH;
    const handleHitPx = 22;

    // 1. Check handles of currently selected arrow first
    if (
      selectedIndex !== null &&
      annotations[selectedIndex] &&
      annotations[selectedIndex].type === 'arrow'
    ) {
      const a = annotations[selectedIndex] as ArrowAnnotation;
      if (Math.hypot(clickX - a.x1 * boxW, clickY - a.y1 * boxH) <= handleHitPx) {
        return { index: selectedIndex, handle: 'start' };
      }
      if (Math.hypot(clickX - a.x2 * boxW, clickY - a.y2 * boxH) <= handleHitPx) {
        return { index: selectedIndex, handle: 'end' };
      }
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;

    // 2. Check top-most annotation downwards
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      if (ann.type === 'arrow') {
        const dist = pointToSegmentDistPx(
          clickX,
          clickY,
          ann.x1 * boxW,
          ann.y1 * boxH,
          ann.x2 * boxW,
          ann.y2 * boxH
        );
        const hitThreshold = Math.max(16, ann.width * boxW + 10);
        if (dist <= hitThreshold) {
          return { index: i };
        }
      } else if (ann.type === 'text') {
        const cx = ann.x * boxW;
        const cy = ann.y * boxH;
        const dx = clickX - cx;
        const dy = clickY - cy;
        const rad = (-ann.rotate * Math.PI) / 180;
        const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
        const localY = dx * Math.sin(rad) + dy * Math.cos(rad);

        let halfW = Math.max(24, ann.text.length * ann.size * boxH * 0.32);
        let halfH = Math.max(18, ann.size * boxH * 0.7);
        if (ctx) {
          const measured = measureTextAnnotationBox(ctx, ann, boxW, boxH);
          halfW = measured.textWidth / 2 + 12;
          halfH = measured.textHeight / 2 + 10;
        }

        if (Math.abs(localX) <= halfW && Math.abs(localY) <= halfH) {
          return { index: i };
        }
      }
    }

    return null;
  }

  function syncToolbarFromAnnotation(ann: PhotoAnnotation) {
    setAnnColor(ann.color);
    if (ann.type === 'arrow') {
      setArrowThickness(
        Math.max(2, Math.min(12, Math.round(ann.width * 1000)))
      );
      setDoubleArrow(ann.double);
    } else if (ann.type === 'text') {
      setTextSizePct(
        Math.max(2, Math.min(12, Math.round(ann.size * 200) / 2))
      );
      setTextRotate(ann.rotate);
      setTextOutline(ann.outline);
    }
  }

  function handleAnnotatePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const pt = getRelativePoint(e);

    if (tool === 'text') {
      if (annotations.length >= MAX_ANNOTATIONS_PER_PHOTO) return;
      setSelectedIndex(null);
      setPendingText({ x: pt.x, y: pt.y, text: '' });
      return;
    }

    if (tool === 'arrow') {
      if (annotations.length >= MAX_ANNOTATIONS_PER_PHOTO) return;
      setSelectedIndex(null);
      setPendingText(null);
      e.currentTarget.setPointerCapture(e.pointerId);
      annDragRef.current = {
        type: 'draw-arrow',
        startX: pt.x,
        startY: pt.y,
      };
      setDraftArrow({
        type: 'arrow',
        x1: pt.x,
        y1: pt.y,
        x2: pt.x,
        y2: pt.y,
        color: annColor,
        width: arrowThickness / 1000,
        double: doubleArrow,
      });
      return;
    }

    // Select tool
    setPendingText(null);
    const hit = hitTestAnnotations(pt.x, pt.y, pt.width, pt.height);
    if (!hit) {
      setSelectedIndex(null);
      return;
    }

    setSelectedIndex(hit.index);
    const target = annotations[hit.index];
    syncToolbarFromAnnotation(target);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (target.type === 'arrow') {
      if (hit.handle) {
        annDragRef.current = {
          type: 'arrow-handle',
          index: hit.index,
          end: hit.handle,
          snapshotPushed: false,
        };
      } else {
        annDragRef.current = {
          type: 'move-arrow',
          index: hit.index,
          startX: pt.x,
          startY: pt.y,
          orig: { ...target },
          snapshotPushed: false,
        };
      }
    } else if (target.type === 'text') {
      annDragRef.current = {
        type: 'move-text',
        index: hit.index,
        startX: pt.x,
        startY: pt.y,
        orig: { ...target },
        snapshotPushed: false,
      };
    }
  }

  function handleAnnotatePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = annDragRef.current;
    if (!drag) return;
    const pt = getRelativePoint(e);

    if (drag.type === 'draw-arrow') {
      setDraftArrow({
        type: 'arrow',
        x1: drag.startX,
        y1: drag.startY,
        x2: pt.x,
        y2: pt.y,
        color: annColor,
        width: arrowThickness / 1000,
        double: doubleArrow,
      });
      return;
    }

    if (drag.type === 'arrow-handle') {
      if (!drag.snapshotPushed) {
        pushUndoSnapshot(annotations);
        drag.snapshotPushed = true;
      }
      setParams((prev) => {
        const list = prev.annotations ?? [];
        const target = list[drag.index];
        if (!target || target.type !== 'arrow') return prev;
        const updated: ArrowAnnotation =
          drag.end === 'start'
            ? { ...target, x1: pt.x, y1: pt.y }
            : { ...target, x2: pt.x, y2: pt.y };
        return {
          ...prev,
          annotations: list.map((item, idx) =>
            idx === drag.index ? updated : item
          ),
        };
      });
      return;
    }

    if (drag.type === 'move-arrow') {
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      if (Math.hypot(dx, dy) < 0.002 && !drag.snapshotPushed) return;
      if (!drag.snapshotPushed) {
        pushUndoSnapshot(annotations);
        drag.snapshotPushed = true;
      }
      const minX = Math.min(drag.orig.x1, drag.orig.x2);
      const maxX = Math.max(drag.orig.x1, drag.orig.x2);
      const minY = Math.min(drag.orig.y1, drag.orig.y2);
      const maxY = Math.max(drag.orig.y1, drag.orig.y2);
      const clampedDx = Math.max(-minX, Math.min(1 - maxX, dx));
      const clampedDy = Math.max(-minY, Math.min(1 - maxY, dy));

      setParams((prev) => {
        const list = prev.annotations ?? [];
        const target = list[drag.index];
        if (!target || target.type !== 'arrow') return prev;
        return {
          ...prev,
          annotations: list.map((item, idx) =>
            idx === drag.index
              ? {
                  ...target,
                  x1: drag.orig.x1 + clampedDx,
                  y1: drag.orig.y1 + clampedDy,
                  x2: drag.orig.x2 + clampedDx,
                  y2: drag.orig.y2 + clampedDy,
                }
              : item
          ),
        };
      });
      return;
    }

    if (drag.type === 'move-text') {
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      if (Math.hypot(dx, dy) < 0.002 && !drag.snapshotPushed) return;
      if (!drag.snapshotPushed) {
        pushUndoSnapshot(annotations);
        drag.snapshotPushed = true;
      }
      const nextX = clamp01(drag.orig.x + dx);
      const nextY = clamp01(drag.orig.y + dy);

      setParams((prev) => {
        const list = prev.annotations ?? [];
        const target = list[drag.index];
        if (!target || target.type !== 'text') return prev;
        return {
          ...prev,
          annotations: list.map((item, idx) =>
            idx === drag.index ? { ...target, x: nextX, y: nextY } : item
          ),
        };
      });
    }
  }

  function handleAnnotatePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = annDragRef.current;
    if (!drag) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    annDragRef.current = null;

    if (drag.type === 'draw-arrow' && draftArrow) {
      const dist = Math.hypot(
        draftArrow.x2 - draftArrow.x1,
        draftArrow.y2 - draftArrow.y1
      );
      if (dist >= 0.015 && annotations.length < MAX_ANNOTATIONS_PER_PHOTO) {
        const committed = { ...draftArrow };
        const newIdx = annotations.length;
        setAnnotationsWithUndo((prev) => [...prev, committed]);
        setSelectedIndex(newIdx);
      }
      setDraftArrow(null);
    }
  }

  function handleCommitPendingText() {
    if (!pendingText) return;
    const trimmed = pendingText.text.trim();
    if (!trimmed) {
      setPendingText(null);
      return;
    }
    if (annotations.length >= MAX_ANNOTATIONS_PER_PHOTO) {
      setPendingText(null);
      return;
    }
    const newAnn: TextAnnotation = {
      type: 'text',
      x: pendingText.x,
      y: pendingText.y,
      text: trimmed,
      color: annColor,
      size: textSizePct / 100,
      rotate: textRotate,
      outline: textOutline,
    };
    const newIdx = annotations.length;
    setAnnotationsWithUndo((prev) => [...prev, newAnn]);
    setSelectedIndex(newIdx);
    setPendingText(null);
  }

  // Update selected annotation properties live when user adjusts controls in Select mode
  function handleColorSelect(hex: string) {
    setAnnColor(hex);
    if (tool === 'select' && selectedIndex !== null && selectedAnn) {
      const idx = selectedIndex;
      setAnnotationsWithUndo((prev) =>
        prev.map((item, i) => (i === idx ? { ...item, color: hex } : item))
      );
    }
  }

  function handleArrowThicknessChange(val: number) {
    setArrowThickness(val);
    if (
      tool === 'select' &&
      selectedIndex !== null &&
      selectedAnn?.type === 'arrow'
    ) {
      const idx = selectedIndex;
      setAnnotationsWithUndo((prev) =>
        prev.map((item, i) =>
          i === idx && item.type === 'arrow'
            ? { ...item, width: val / 1000 }
            : item
        )
      );
    }
  }

  function handleDoubleArrowToggle() {
    const next = !doubleArrow;
    setDoubleArrow(next);
    if (
      tool === 'select' &&
      selectedIndex !== null &&
      selectedAnn?.type === 'arrow'
    ) {
      const idx = selectedIndex;
      setAnnotationsWithUndo((prev) =>
        prev.map((item, i) =>
          i === idx && item.type === 'arrow' ? { ...item, double: next } : item
        )
      );
    }
  }

  function handleTextSizeChange(val: number) {
    setTextSizePct(val);
    if (
      tool === 'select' &&
      selectedIndex !== null &&
      selectedAnn?.type === 'text'
    ) {
      const idx = selectedIndex;
      setAnnotationsWithUndo((prev) =>
        prev.map((item, i) =>
          i === idx && item.type === 'text'
            ? { ...item, size: val / 100 }
            : item
        )
      );
    }
  }

  function handleTextRotateSelect(rot: 0 | 90 | -90) {
    setTextRotate(rot);
    if (
      tool === 'select' &&
      selectedIndex !== null &&
      selectedAnn?.type === 'text'
    ) {
      const idx = selectedIndex;
      setAnnotationsWithUndo((prev) =>
        prev.map((item, i) =>
          i === idx && item.type === 'text' ? { ...item, rotate: rot } : item
        )
      );
    }
  }

  function handleTextOutlineToggle() {
    const next = !textOutline;
    setTextOutline(next);
    if (
      tool === 'select' &&
      selectedIndex !== null &&
      selectedAnn?.type === 'text'
    ) {
      const idx = selectedIndex;
      setAnnotationsWithUndo((prev) =>
        prev.map((item, i) =>
          i === idx && item.type === 'text' ? { ...item, outline: next } : item
        )
      );
    }
  }

  // --- ROTATE / CROP WITH ANNOTATION CLEAR CONFIRMATION ---
  function applyRotateNow(delta: -90 | 90, clearAnns: boolean) {
    setParams((prev) => ({
      ...prev,
      rotate: normalizeRotation(prev.rotate + delta),
      crop: rotateCropRect(prev.crop, delta === 90 ? 'cw' : 'ccw'),
      ...(clearAnns ? { annotations: [] } : {}),
    }));
    if (clearAnns) {
      setSelectedIndex(null);
      setUndoStack([]);
    }
  }

  function applyResetCropNow(clearAnns: boolean) {
    setParams((prev) => ({
      ...prev,
      crop: { ...DEFAULT_CROP },
      ...(clearAnns ? { annotations: [] } : {}),
    }));
    if (clearAnns) {
      setSelectedIndex(null);
      setUndoStack([]);
    }
  }

  function handleRotate(delta: -90 | 90) {
    if (hasAnnotations) {
      setPendingClearAction({ kind: 'rotate', delta });
      return;
    }
    applyRotateNow(delta, false);
  }

  function handleResetCrop() {
    if (hasAnnotations) {
      setPendingClearAction({ kind: 'reset-crop' });
      return;
    }
    applyResetCropNow(false);
  }

  function handleConfirmClearAnnotations() {
    const act = pendingClearAction;
    setPendingClearAction(null);
    if (!act) return;

    if (act.kind === 'rotate') {
      applyRotateNow(act.delta, true);
    } else if (act.kind === 'reset-crop') {
      applyResetCropNow(true);
    } else if (act.kind === 'start-crop') {
      setParams((prev) => ({ ...prev, annotations: [] }));
      setSelectedIndex(null);
      setUndoStack([]);
    }
  }

  function handleSaveClick() {
    if (saving) return;
    setSaving(true);
    requestAnimationFrame(() => {
      onSave(normalizePhotoParams(params));
    });
  }

  const showArrowControls =
    tool === 'arrow' ||
    (tool === 'select' && selectedAnn?.type === 'arrow');
  const showTextControls =
    tool === 'text' || (tool === 'select' && selectedAnn?.type === 'text');
  const showColorControls =
    tool === 'arrow' ||
    tool === 'text' ||
    (tool === 'select' && selectedAnn !== null);
  const atAnnotationLimit = annotations.length >= MAX_ANNOTATIONS_PER_PHOTO;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gray-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Top header */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-gray-800 bg-[#1F3A8A] px-3 sm:px-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-[40px] rounded-lg px-3 py-1.5 text-sm font-medium text-white/90 hover:bg-white/10 disabled:opacity-50 whitespace-nowrap"
        >
          Cancel
        </button>

        {ENABLE_ANNOTATIONS ? (
          <div
            role="tablist"
            aria-label="Photo editor mode"
            className="inline-grid grid-cols-2 rounded-lg bg-white/15 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'adjust'}
              onClick={() => {
                setEditorMode('adjust');
                setPendingText(null);
                setDraftArrow(null);
              }}
              className={`min-h-[34px] rounded-md px-3 py-1 text-sm font-semibold transition-colors whitespace-nowrap ${
                activeMode === 'adjust'
                  ? 'bg-white text-[#1F3A8A] shadow-xs'
                  : 'text-white/85 hover:text-white'
              }`}
            >
              Adjust
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'annotate'}
              onClick={() => {
                setEditorMode('annotate');
                setSelectedIndex(null);
              }}
              className={`min-h-[34px] rounded-md px-3 py-1 text-sm font-semibold transition-colors whitespace-nowrap ${
                activeMode === 'annotate'
                  ? 'bg-white text-[#1F3A8A] shadow-xs'
                  : 'text-white/85 hover:text-white'
              }`}
            >
              Annotate
            </button>
          </div>
        ) : (
          <h2 className="truncate text-base font-semibold text-white">{title}</h2>
        )}

        <button
          type="button"
          onClick={handleSaveClick}
          disabled={saving}
          className="min-h-[40px] rounded-lg bg-white px-4 py-1.5 text-sm font-semibold text-[#1F3A8A] hover:bg-gray-100 disabled:opacity-60 whitespace-nowrap"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Canvas preview area */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-gray-950 p-3 sm:p-5">
        <div className="relative inline-flex max-h-full max-w-full items-center justify-center select-none">
          <canvas
            ref={canvasRef}
            className="block max-h-[48dvh] max-w-full rounded object-contain sm:max-h-[56dvh]"
          />

          {/* Interactive overlay aligned strictly to canvas bounds */}
          {activeMode === 'adjust' ? (
            <div
              ref={overlayRef}
              onPointerDown={handleAdjustPointerDown}
              onPointerMove={handleAdjustPointerMove}
              onPointerUp={handleAdjustPointerUp}
              onPointerCancel={handleAdjustPointerUp}
              className="absolute inset-0 cursor-crosshair touch-none"
            >
              {isCropped && (
                <>
                  <div
                    className="pointer-events-none absolute left-0 right-0 top-0 bg-black/55"
                    style={{ height: `${params.crop.y * 100}%` }}
                  />
                  <div
                    className="pointer-events-none absolute left-0 right-0 bottom-0 bg-black/55"
                    style={{
                      height: `${Math.max(0, (1 - params.crop.y - params.crop.h) * 100)}%`,
                    }}
                  />
                  <div
                    className="pointer-events-none absolute left-0 bg-black/55"
                    style={{
                      top: `${params.crop.y * 100}%`,
                      height: `${params.crop.h * 100}%`,
                      width: `${params.crop.x * 100}%`,
                    }}
                  />
                  <div
                    className="pointer-events-none absolute right-0 bg-black/55"
                    style={{
                      top: `${params.crop.y * 100}%`,
                      height: `${params.crop.h * 100}%`,
                      width: `${Math.max(0, (1 - params.crop.x - params.crop.w) * 100)}%`,
                    }}
                  />
                </>
              )}

              <div
                className={`pointer-events-none absolute border-2 ${
                  isCropped ? 'border-white' : 'border-white/50 border-dashed'
                }`}
                style={{
                  left: `${params.crop.x * 100}%`,
                  top: `${params.crop.y * 100}%`,
                  width: `${params.crop.w * 100}%`,
                  height: `${params.crop.h * 100}%`,
                }}
              >
                {isCropped && (
                  <>
                    <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/35" />
                    <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/35" />
                    <div className="absolute top-1/3 left-0 right-0 h-px bg-white/35" />
                    <div className="absolute top-2/3 left-0 right-0 h-px bg-white/35" />
                  </>
                )}

                <span className="absolute -left-1.5 -top-1.5 h-3.5 w-3.5 rounded-xs border-2 border-white bg-[#1F3A8A]" />
                <span className="absolute -right-1.5 -top-1.5 h-3.5 w-3.5 rounded-xs border-2 border-white bg-[#1F3A8A]" />
                <span className="absolute -left-1.5 -bottom-1.5 h-3.5 w-3.5 rounded-xs border-2 border-white bg-[#1F3A8A]" />
                <span className="absolute -right-1.5 -bottom-1.5 h-3.5 w-3.5 rounded-xs border-2 border-white bg-[#1F3A8A]" />
              </div>
            </div>
          ) : (
            <div
              ref={overlayRef}
              onPointerDown={handleAnnotatePointerDown}
              onPointerMove={handleAnnotatePointerMove}
              onPointerUp={handleAnnotatePointerUp}
              onPointerCancel={handleAnnotatePointerUp}
              className={`absolute inset-0 touch-none ${
                tool === 'arrow'
                  ? 'cursor-crosshair'
                  : tool === 'text'
                    ? 'cursor-text'
                    : 'cursor-pointer'
              }`}
            />
          )}
        </div>

        {/* Inline text entry box when user taps canvas in Text tool */}
        {activeMode === 'annotate' && pendingText && (
          <div className="absolute bottom-3 left-3 right-3 z-20 mx-auto max-w-md rounded-xl border border-gray-700 bg-gray-900/95 p-2.5 shadow-xl backdrop-blur-sm">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCommitPendingText();
              }}
              className="flex items-center gap-2"
            >
              <input
                ref={textInputRef}
                type="text"
                value={pendingText.text}
                onChange={(e) =>
                  setPendingText((prev) =>
                    prev ? { ...prev, text: e.target.value } : null
                  )
                }
                placeholder="Type label text..."
                className="min-w-0 flex-1 min-h-[42px] rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-base text-white placeholder:text-gray-400 focus:border-blue-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setPendingText(null)}
                className="min-h-[42px] rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!pendingText.text.trim()}
                className="min-h-[42px] rounded-lg bg-[#1F3A8A] px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-[#2749AA] disabled:opacity-50"
              >
                Add
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Bottom Controls Drawer */}
      <div className="shrink-0 border-t border-gray-800 bg-gray-900 px-4 py-3.5">
        {activeMode === 'adjust' ? (
          <div className="mx-auto max-w-xl space-y-4">
            {/* Rotate & Crop Reset buttons */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleRotate(-90)}
                  className="flex min-h-[42px] items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 active:bg-gray-600"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  <span>Rotate left</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRotate(90)}
                  className="flex min-h-[42px] items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 active:bg-gray-600"
                >
                  <RotateCw className="h-4 w-4" aria-hidden="true" />
                  <span>Rotate right</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="hidden items-center gap-1 text-xs text-gray-400 sm:inline-flex">
                  <Crop className="h-3.5 w-3.5" aria-hidden="true" />
                  Drag image to crop
                </span>
                <button
                  type="button"
                  onClick={handleResetCrop}
                  disabled={!isCropped}
                  className="flex min-h-[42px] items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                  <span>Reset</span>
                </button>
              </div>
            </div>

            {/* Sharpness slider 0 to 100 */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <label htmlFor="editor-sharpness" className="font-medium text-gray-200">
                  Sharpness
                </label>
                <span className="font-medium text-gray-300 tabular-nums">
                  {params.sharpness}
                </span>
              </div>
              <input
                id="editor-sharpness"
                type="range"
                min={0}
                max={100}
                step={1}
                value={params.sharpness}
                onChange={(e) =>
                  setParams((prev) => ({
                    ...prev,
                    sharpness: Number(e.target.value),
                  }))
                }
                className="h-2 w-full cursor-pointer accent-blue-400"
              />
            </div>

            {/* Temperature slider -100 to +100 */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <label htmlFor="editor-temperature" className="font-medium text-gray-200">
                  Temperature
                </label>
                <span className="font-medium text-gray-300 tabular-nums">
                  {params.temperature > 0
                    ? `+${params.temperature} (Warm)`
                    : params.temperature < 0
                      ? `${params.temperature} (Cool)`
                      : '0'}
                </span>
              </div>
              <input
                id="editor-temperature"
                type="range"
                min={-100}
                max={100}
                step={1}
                value={params.temperature}
                onChange={(e) =>
                  setParams((prev) => ({
                    ...prev,
                    temperature: Number(e.target.value),
                  }))
                }
                className="h-2 w-full cursor-pointer accent-amber-400"
              />
              <p className="pt-1 text-xs text-gray-400">
                {ENABLE_ANNOTATIONS
                  ? 'Edited copy only. The original is kept. Arrows and text are added to the edited copy only.'
                  : 'Edited copy only. The original is kept.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-xl space-y-3">
            {/* Tool selector row + Undo / Delete */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setTool('select');
                    setPendingText(null);
                  }}
                  className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                    tool === 'select'
                      ? 'bg-[#1F3A8A] text-white'
                      : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                  }`}
                >
                  <MousePointer2 className="h-4 w-4" aria-hidden="true" />
                  <span>Select</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTool('arrow');
                    setPendingText(null);
                  }}
                  disabled={atAnnotationLimit}
                  className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-45 whitespace-nowrap ${
                    tool === 'arrow'
                      ? 'bg-[#1F3A8A] text-white'
                      : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                  }`}
                >
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  <span>Arrow</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTool('text');
                    setSelectedIndex(null);
                  }}
                  disabled={atAnnotationLimit}
                  className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-45 whitespace-nowrap ${
                    tool === 'text'
                      ? 'bg-[#1F3A8A] text-white'
                      : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                  }`}
                >
                  <Type className="h-4 w-4" aria-hidden="true" />
                  <span>Text</span>
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={undoStack.length === 0}
                  className="flex min-h-[40px] items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 whitespace-nowrap"
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                  <span>Undo</span>
                </button>
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={selectedIndex === null}
                  className="flex min-h-[40px] items-center gap-1 rounded-lg bg-red-600/90 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40 whitespace-nowrap"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span>Delete</span>
                </button>
              </div>
            </div>

            {/* Helper hint + counter */}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>
                {atAnnotationLimit
                  ? `Maximum ${MAX_ANNOTATIONS_PER_PHOTO} annotations reached.`
                  : tool === 'select'
                    ? selectedAnn
                      ? selectedAnn.type === 'arrow'
                        ? 'Drag arrow to move or drag round end handles.'
                        : 'Drag label to move or adjust below.'
                      : 'Tap an annotation to select and move it.'
                    : tool === 'arrow'
                      ? 'Drag on the photo from start to end.'
                      : 'Tap on the photo to place text.'}
              </span>
              <span className="tabular-nums shrink-0 ml-2">
                {annotations.length}/{MAX_ANNOTATIONS_PER_PHOTO}
              </span>
            </div>

            {/* Color chips row */}
            {showColorControls && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-300">Color</span>
                  <div className="flex items-center gap-2">
                    {ANNOTATION_COLORS.map((c) => {
                      const active = annColor.toLowerCase() === c.hex.toLowerCase();
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => handleColorSelect(c.hex)}
                          aria-label={c.label}
                          title={c.label}
                          className={`h-8 w-8 rounded-full border-2 transition-transform ${
                            active
                              ? 'scale-110 border-blue-400 ring-2 ring-blue-400/50'
                              : 'border-gray-500 hover:scale-105'
                          }`}
                          style={{ backgroundColor: c.hex }}
                        />
                      );
                    })}
                  </div>
                </div>

                {/* Arrow: Double arrow toggle */}
                {showArrowControls && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={doubleArrow}
                    onClick={handleDoubleArrowToggle}
                    className={`flex min-h-[36px] items-center gap-2 rounded-lg border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      doubleArrow
                        ? 'border-blue-400 bg-[#1F3A8A] text-white'
                        : 'border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700'
                    }`}
                  >
                    <span>Double arrow</span>
                    <span className="text-[11px] font-semibold">
                      {doubleArrow ? 'ON' : 'OFF'}
                    </span>
                  </button>
                )}

                {/* Text: Outline toggle */}
                {showTextControls && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={textOutline}
                    onClick={handleTextOutlineToggle}
                    className={`flex min-h-[36px] items-center gap-2 rounded-lg border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      textOutline
                        ? 'border-blue-400 bg-[#1F3A8A] text-white'
                        : 'border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700'
                    }`}
                  >
                    <span>Outline</span>
                    <span className="text-[11px] font-semibold">
                      {textOutline ? 'ON' : 'OFF'}
                    </span>
                  </button>
                )}
              </div>
            )}

            {/* Arrow thickness slider (2 to 12, default 5) */}
            {showArrowControls && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="ann-thickness" className="font-medium text-gray-300">
                    Thickness
                  </label>
                  <span className="font-medium text-gray-300 tabular-nums">
                    {arrowThickness}
                  </span>
                </div>
                <input
                  id="ann-thickness"
                  type="range"
                  min={2}
                  max={12}
                  step={1}
                  value={arrowThickness}
                  onChange={(e) =>
                    handleArrowThicknessChange(Number(e.target.value))
                  }
                  className="h-2 w-full cursor-pointer accent-blue-400"
                />
              </div>
            )}

            {/* Text size slider + rotation buttons (0, 90, -90) */}
            {showTextControls && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="ann-text-size" className="font-medium text-gray-300">
                      Text size
                    </label>
                    <span className="font-medium text-gray-300 tabular-nums">
                      {textSizePct.toFixed(1)}%
                    </span>
                  </div>
                  <input
                    id="ann-text-size"
                    type="range"
                    min={2}
                    max={12}
                    step={0.5}
                    value={textSizePct}
                    onChange={(e) => handleTextSizeChange(Number(e.target.value))}
                    className="h-2 w-full cursor-pointer accent-blue-400"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-gray-300 mr-1">
                    Rotate
                  </span>
                  {([0, 90, -90] as const).map((deg) => (
                    <button
                      key={deg}
                      type="button"
                      onClick={() => handleTextRotateSelect(deg)}
                      className={`min-h-[36px] min-w-[44px] rounded-lg px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors ${
                        textRotate === deg
                          ? 'bg-[#1F3A8A] text-white'
                          : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                      }`}
                    >
                      {deg}°
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Confirmation dialog before rotating/cropping clears annotations */}
      <ConfirmDialog
        open={pendingClearAction !== null}
        title="Remove annotations?"
        message="Annotations will be removed. Continue?"
        confirmLabel="Yes"
        confirmVariant="danger"
        onConfirm={handleConfirmClearAnnotations}
        onCancel={() => setPendingClearAction(null)}
      />
    </div>
  );
}
