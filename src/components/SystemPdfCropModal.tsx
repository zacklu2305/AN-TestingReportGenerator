import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { ENABLE_ANNOTATIONS } from '../api';
import type { CropRect, PhotoParams } from '../types';
import {
  DEFAULT_CROP,
  buildEditedJpegBase64,
  loadImageFromDataUrl,
  normalizeCrop,
} from '../utils/imageProcessing';
import {
  convertPdfToJpegPages,
  type RenderedPdfPage,
} from '../utils/pdfToImages';

const MIN_CROP_PX = 100;
const SYSTEM_MAX_SIDE = 2400;

interface SystemPdfCropModalProps {
  file: File;
  remainingSlots: number;
  onSavePage: (payload: {
    originalBase64: string;
    editedBase64: string;
    editedDataUrl: string;
    params: PhotoParams;
  }) => Promise<void>;
  onClose: () => void;
}

type HandleKind = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | { type: 'move'; startX: number; startY: number; orig: CropRect }
  | { type: 'handle'; handle: HandleKind; orig: CropRect };

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

const LIQUID_GLASS_PANEL =
  'bg-[rgba(255,255,255,0.22)] backdrop-blur-[20px] backdrop-saturate-[160%] border border-[rgba(255,255,255,0.45)] rounded-[20px] shadow-[0_8px_32px_rgba(0,0,0,0.18)]';

export function SystemPdfCropModal({
  file,
  remainingSlots,
  onSavePage,
  onClose,
}: SystemPdfCropModalProps) {
  // Phase: 'reading' | 'read-error' | 'crop'
  const [phase, setPhase] = useState<'reading' | 'read-error' | 'crop'>(
    'reading'
  );
  const [progressText, setProgressText] = useState('Reading PDF...');
  const [readErrorMessage, setReadErrorMessage] = useState('');
  const [notices, setNotices] = useState<string[]>([]);

  const [pages, setPages] = useState<RenderedPdfPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [crop, setCrop] = useState<CropRect>({ ...DEFAULT_CROP });

  const [savingPage, setSavingPage] = useState(false);
  const [saveFailed, setSaveFailed] = useState<{
    pageNumber: number;
    useFullPage: boolean;
  } | null>(null);
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);

  // Exact fitted image dimensions so the crop overlay matches the image pixel-for-pixel
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [fittedBox, setFittedBox] = useState<{ w: number; h: number } | null>(
    null
  );

  // Convert PDF on mount
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    convertPdfToJpegPages(file, remainingSlots, {
      signal: controller.signal,
      onProgress: (current, total) => {
        if (cancelled) return;
        setProgressText(`Reading PDF... page ${current} of ${total}`);
      },
      onNotices: (nextNotices) => {
        if (cancelled) return;
        setNotices(nextNotices);
      },
    })
      .then((result) => {
        if (cancelled) return;
        if (!result.pages || result.pages.length === 0) {
          setReadErrorMessage(
            'Could not read this PDF. Please upload an image instead.'
          );
          setPhase('read-error');
          return;
        }
        setPages(result.pages);
        setNotices(result.notices);
        setPageIndex(0);
        setCrop({ ...DEFAULT_CROP });
        setPhase('crop');
      })
      .catch((err) => {
        if (cancelled) return;
        const code = err instanceof Error ? err.message : '';
        if (code === 'ABORTED') return;
        if (code === 'PDF_TOO_LARGE') {
          setReadErrorMessage(
            'This PDF is larger than 20 MB. Please upload a smaller PDF or an image instead.'
          );
        } else {
          setReadErrorMessage(
            'Could not read this PDF. Please upload an image instead.'
          );
        }
        setPhase('read-error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file, remainingSlots]);

  const currentPage = pages[pageIndex] ?? null;
  const totalPages = pages.length;
  const isLastPage = pageIndex >= totalPages - 1;

  // Reset crop to full page whenever pageIndex changes
  useEffect(() => {
    setCrop({ ...DEFAULT_CROP });
    setSaveFailed(null);
  }, [pageIndex]);

  // Keep fittedBox synced to stage dimensions and current page aspect ratio
  useEffect(() => {
    if (phase !== 'crop' || !currentPage) return;
    const stageEl = stageRef.current;
    if (!stageEl) return;

    const recompute = () => {
      const rect = stageEl.getBoundingClientRect();
      // Leave small breathing room around the image for 44px corner/edge touch handles
      const availW = Math.max(120, rect.width - 28);
      const availH = Math.max(120, rect.height - 28);
      const imgAspect = currentPage.width / Math.max(1, currentPage.height);
      const boxAspect = availW / availH;

      let fitW: number;
      let fitH: number;
      if (imgAspect > boxAspect) {
        fitW = availW;
        fitH = availW / imgAspect;
      } else {
        fitH = availH;
        fitW = availH * imgAspect;
      }
      setFittedBox({
        w: Math.max(80, Math.floor(fitW)),
        h: Math.max(80, Math.floor(fitH)),
      });
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(stageEl);
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [phase, currentPage]);

  // Minimum crop fractions corresponding to 100 px on the rendered page
  const minFracW = currentPage
    ? Math.min(1, MIN_CROP_PX / Math.max(1, currentPage.width))
    : 0.05;
  const minFracH = currentPage
    ? Math.min(1, MIN_CROP_PX / Math.max(1, currentPage.height))
    : 0.05;

  function getRelativePoint(e: ReactPointerEvent<HTMLElement>) {
    const el = overlayRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
    };
  }

  function startHandleDrag(
    handle: HandleKind,
    e: ReactPointerEvent<HTMLDivElement>
  ) {
    if (savingPage) return;
    e.stopPropagation();
    e.preventDefault();
    overlayRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      type: 'handle',
      handle,
      orig: { ...crop },
    };
  }

  function handleOverlayPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (savingPage) return;
    const pt = getRelativePoint(e);
    if (
      pt.x >= crop.x &&
      pt.x <= crop.x + crop.w &&
      pt.y >= crop.y &&
      pt.y <= crop.y + crop.h
    ) {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        type: 'move',
        startX: pt.x,
        startY: pt.y,
        orig: { ...crop },
      };
    }
  }

  function handleOverlayPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const pt = getRelativePoint(e);

    if (drag.type === 'move') {
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      const nextX = clamp(drag.orig.x + dx, 0, 1 - drag.orig.w);
      const nextY = clamp(drag.orig.y + dy, 0, 1 - drag.orig.h);
      setCrop({
        x: nextX,
        y: nextY,
        w: drag.orig.w,
        h: drag.orig.h,
      });
      return;
    }

    const { orig, handle } = drag;
    let left = orig.x;
    let top = orig.y;
    let right = orig.x + orig.w;
    let bottom = orig.y + orig.h;

    if (handle === 'nw' || handle === 'w' || handle === 'sw') {
      left = clamp(pt.x, 0, right - minFracW);
    }
    if (handle === 'ne' || handle === 'e' || handle === 'se') {
      right = clamp(pt.x, left + minFracW, 1);
    }
    if (handle === 'nw' || handle === 'n' || handle === 'ne') {
      top = clamp(pt.y, 0, bottom - minFracH);
    }
    if (handle === 'sw' || handle === 's' || handle === 'se') {
      bottom = clamp(pt.y, top + minFracH, 1);
    }

    setCrop({
      x: left,
      y: top,
      w: Math.max(minFracW, right - left),
      h: Math.max(minFracH, bottom - top),
    });
  }

  function handleOverlayPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore if already released
    }
    dragRef.current = null;
  }

  function advanceOrFinish() {
    setSaveFailed(null);
    if (pageIndex >= totalPages - 1) {
      onClose();
    } else {
      setPageIndex((prev) => prev + 1);
    }
  }

  async function executeSave(useFullPage: boolean) {
    if (!currentPage || savingPage) return;
    setSavingPage(true);
    setSaveFailed(null);

    const effectiveCrop = useFullPage
      ? { ...DEFAULT_CROP }
      : normalizeCrop(crop);

    const params: PhotoParams = {
      rotate: 0,
      crop: effectiveCrop,
      sharpness: 0,
      temperature: 0,
      ...(ENABLE_ANNOTATIONS ? { annotations: [] } : {}),
    };

    try {
      const img = await loadImageFromDataUrl(currentPage.dataUrl);
      const edited = buildEditedJpegBase64(img, params, SYSTEM_MAX_SIDE);

      await onSavePage({
        originalBase64: currentPage.base64,
        editedBase64: edited.base64,
        editedDataUrl: edited.dataUrl,
        params,
      });

      advanceOrFinish();
    } catch {
      setSaveFailed({
        pageNumber: currentPage.pageNumber,
        useFullPage,
      });
    } finally {
      setSavingPage(false);
    }
  }

  // Reading or Error Glass Card Overlay
  if (phase === 'reading' || phase === 'read-error') {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.6)] p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Reading PDF"
      >
        <div
          className={`w-full max-w-sm p-6 text-center ${LIQUID_GLASS_PANEL}`}
        >
          {phase === 'reading' ? (
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/85 shadow-sm">
                <Loader2
                  className="h-6 w-6 animate-spin text-[#1F3A8A]"
                  aria-hidden="true"
                />
              </div>
              <p className="text-base font-semibold text-white drop-shadow-xs">
                {progressText}
              </p>
              {notices.length > 0 && (
                <div className="w-full rounded-xl bg-white/85 px-3 py-2 text-xs font-medium text-slate-800">
                  {notices.map((n, idx) => (
                    <p key={idx}>{n}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="flex w-full items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50/95 px-4 py-3 text-left text-sm font-medium text-red-700">
                <AlertCircle
                  className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
                  aria-hidden="true"
                />
                <span>{readErrorMessage}</span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="h-12 w-full rounded-[14px] bg-[rgba(255,255,255,0.85)] px-4 text-[15px] font-semibold text-[#0F172A] shadow-xs transition-colors hover:bg-white"
              >
                OK
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!currentPage) return null;

  const isCropped =
    crop.x > 0.002 ||
    crop.y > 0.002 ||
    crop.w < 0.998 ||
    crop.h < 0.998;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[rgba(15,23,42,0.6)] p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Crop page ${pageIndex + 1} of ${totalPages}`}
    >
      {/* Top Liquid Glass Header */}
      <div
        className={`mx-auto flex w-full max-w-4xl shrink-0 items-center justify-between gap-3 px-4 py-2.5 ${LIQUID_GLASS_PANEL}`}
      >
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-white drop-shadow-xs">
            Crop page {pageIndex + 1} of {totalPages}
          </h2>
          {notices.length > 0 && (
            <p className="mt-0.5 truncate text-xs font-medium text-white/90">
              {notices.join(' ')}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            if (!savingPage) setConfirmStopOpen(true);
          }}
          disabled={savingPage}
          aria-label="Close"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.75)] text-[#0F172A] transition-colors hover:bg-white disabled:opacity-50"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Centered Page Image + Crop Overlay */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden py-3"
      >
        <div
          className="relative select-none shadow-2xl"
          style={
            fittedBox
              ? { width: `${fittedBox.w}px`, height: `${fittedBox.h}px` }
              : undefined
          }
        >
          <img
            src={currentPage.dataUrl}
            alt={`PDF page ${currentPage.pageNumber}`}
            draggable={false}
            className="block h-full w-full rounded-sm bg-white object-contain select-none"
          />

          {/* Interactive Crop Overlay */}
          <div
            ref={overlayRef}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerUp}
            className="absolute inset-0 touch-none"
          >
            {/* 55% black dimmed areas outside the crop */}
            {isCropped && (
              <>
                <div
                  className="pointer-events-none absolute left-0 right-0 top-0 bg-black/55"
                  style={{ height: `${crop.y * 100}%` }}
                />
                <div
                  className="pointer-events-none absolute left-0 right-0 bottom-0 bg-black/55"
                  style={{
                    height: `${Math.max(0, (1 - crop.y - crop.h) * 100)}%`,
                  }}
                />
                <div
                  className="pointer-events-none absolute left-0 bg-black/55"
                  style={{
                    top: `${crop.y * 100}%`,
                    height: `${crop.h * 100}%`,
                    width: `${crop.x * 100}%`,
                  }}
                />
                <div
                  className="pointer-events-none absolute right-0 bg-black/55"
                  style={{
                    top: `${crop.y * 100}%`,
                    height: `${crop.h * 100}%`,
                    width: `${Math.max(0, (1 - crop.x - crop.w) * 100)}%`,
                  }}
                />
              </>
            )}

            {/* Draggable Crop Box */}
            <div
              className="absolute border-2 border-white cursor-move"
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.w * 100}%`,
                height: `${crop.h * 100}%`,
              }}
            >
              {/* Rule of thirds guides */}
              <div className="pointer-events-none absolute left-1/3 top-0 bottom-0 w-px bg-white/40" />
              <div className="pointer-events-none absolute left-2/3 top-0 bottom-0 w-px bg-white/40" />
              <div className="pointer-events-none absolute top-1/3 left-0 right-0 h-px bg-white/40" />
              <div className="pointer-events-none absolute top-2/3 left-0 right-0 h-px bg-white/40" />

              {/* 4 Corner Handles (44x44px touch targets) */}
              <div
                onPointerDown={(e) => startHandleDrag('nw', e)}
                aria-label="Resize top-left corner"
                className="absolute left-0 top-0 flex h-[44px] w-[44px] -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize items-center justify-center touch-none"
              >
                <span className="h-4 w-4 rounded-xs border-2 border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              <div
                onPointerDown={(e) => startHandleDrag('ne', e)}
                aria-label="Resize top-right corner"
                className="absolute right-0 top-0 flex h-[44px] w-[44px] translate-x-1/2 -translate-y-1/2 cursor-nesw-resize items-center justify-center touch-none"
              >
                <span className="h-4 w-4 rounded-xs border-2 border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              <div
                onPointerDown={(e) => startHandleDrag('sw', e)}
                aria-label="Resize bottom-left corner"
                className="absolute left-0 bottom-0 flex h-[44px] w-[44px] -translate-x-1/2 translate-y-1/2 cursor-nesw-resize items-center justify-center touch-none"
              >
                <span className="h-4 w-4 rounded-xs border-2 border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              <div
                onPointerDown={(e) => startHandleDrag('se', e)}
                aria-label="Resize bottom-right corner"
                className="absolute right-0 bottom-0 flex h-[44px] w-[44px] translate-x-1/2 translate-y-1/2 cursor-nwse-resize items-center justify-center touch-none"
              >
                <span className="h-4 w-4 rounded-xs border-2 border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              {/* 4 Edge Handles (44x44px touch targets) */}
              <div
                onPointerDown={(e) => startHandleDrag('n', e)}
                aria-label="Resize top edge"
                className="absolute left-1/2 top-0 flex h-[44px] w-[44px] -translate-x-1/2 -translate-y-1/2 cursor-ns-resize items-center justify-center touch-none"
              >
                <span className="h-2 w-7 rounded-full border border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              <div
                onPointerDown={(e) => startHandleDrag('s', e)}
                aria-label="Resize bottom edge"
                className="absolute left-1/2 bottom-0 flex h-[44px] w-[44px] -translate-x-1/2 translate-y-1/2 cursor-ns-resize items-center justify-center touch-none"
              >
                <span className="h-2 w-7 rounded-full border border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              <div
                onPointerDown={(e) => startHandleDrag('w', e)}
                aria-label="Resize left edge"
                className="absolute left-0 top-1/2 flex h-[44px] w-[44px] -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center touch-none"
              >
                <span className="h-7 w-2 rounded-full border border-white bg-[#1F3A8A] shadow-sm" />
              </div>

              <div
                onPointerDown={(e) => startHandleDrag('e', e)}
                aria-label="Resize right edge"
                className="absolute right-0 top-1/2 flex h-[44px] w-[44px] translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center touch-none"
              >
                <span className="h-7 w-2 rounded-full border border-white bg-[#1F3A8A] shadow-sm" />
              </div>
            </div>
          </div>

          {/* Saving overlay spinner */}
          {savingPage && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-sm bg-slate-900/45 backdrop-blur-[2px]">
              <Loader2 className="h-8 w-8 animate-spin text-white" />
              <span className="text-sm font-semibold text-white">
                Saving page {pageIndex + 1}...
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Liquid Glass Bar with 3 buttons */}
      <div
        className={`mx-auto w-full max-w-4xl shrink-0 p-2.5 sm:p-3 ${LIQUID_GLASS_PANEL}`}
      >
        <div className="flex items-center gap-1.5 sm:gap-3">
          <button
            type="button"
            onClick={advanceOrFinish}
            disabled={savingPage}
            className="h-[48px] shrink-0 rounded-[14px] bg-[rgba(255,255,255,0.75)] px-2.5 sm:flex-1 sm:px-3 text-[15px] font-semibold text-[#0F172A] shadow-xs transition-colors hover:bg-[rgba(255,255,255,0.9)] active:bg-white disabled:opacity-50 whitespace-nowrap"
          >
            Skip page
          </button>

          <button
            type="button"
            onClick={() => void executeSave(true)}
            disabled={savingPage}
            className="h-[48px] flex-1 rounded-[14px] bg-[rgba(255,255,255,0.75)] px-2 sm:px-3 text-[15px] font-semibold text-[#0F172A] shadow-xs transition-colors hover:bg-[rgba(255,255,255,0.9)] active:bg-white disabled:opacity-50 whitespace-nowrap"
          >
            Use full page
          </button>

          <button
            type="button"
            onClick={() => void executeSave(false)}
            disabled={savingPage}
            className="flex h-[48px] flex-[1.15] sm:flex-1 items-center justify-center gap-1.5 rounded-[14px] bg-[#1F3A8A] px-2.5 sm:px-3 text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-[#193073] active:bg-[#152861] disabled:opacity-60 whitespace-nowrap"
          >
            {savingPage && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            )}
            <span>{isLastPage ? 'Save and finish' : 'Save crop'}</span>
          </button>
        </div>
      </div>

      {/* Save Failed Dialog (Retry / Skip) */}
      {saveFailed && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-[rgba(15,23,42,0.55)] p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Page save failed"
        >
          <div className={`w-full max-w-sm p-5 ${LIQUID_GLASS_PANEL}`}>
            <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50/95 px-4 py-3 text-sm font-medium text-red-700">
              <AlertCircle
                className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
                aria-hidden="true"
              />
              <span>Page {saveFailed.pageNumber} could not be saved.</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={advanceOrFinish}
                className="h-[48px] rounded-[14px] bg-[rgba(255,255,255,0.75)] px-4 text-[15px] font-semibold text-[#0F172A] hover:bg-white"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => void executeSave(saveFailed.useFullPage)}
                className="h-[48px] rounded-[14px] bg-[#1F3A8A] px-4 text-[15px] font-semibold text-white hover:bg-[#193073]"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Confirmation Dialog (Yes / No) */}
      {confirmStopOpen && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-[rgba(15,23,42,0.55)] p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Stop cropping PDF"
          onClick={() => setConfirmStopOpen(false)}
        >
          <div
            className={`w-full max-w-sm p-5 ${LIQUID_GLASS_PANEL}`}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-4 rounded-2xl bg-white/90 px-4 py-3 text-center text-base font-semibold text-[#0F172A]">
              Stop now? Pages already saved stay.
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmStopOpen(false)}
                className="h-[48px] rounded-[14px] bg-[rgba(255,255,255,0.75)] px-4 text-[15px] font-semibold text-[#0F172A] hover:bg-white"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmStopOpen(false);
                  onClose();
                }}
                className="h-[48px] rounded-[14px] bg-[#1F3A8A] px-4 text-[15px] font-semibold text-white hover:bg-[#193073]"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
