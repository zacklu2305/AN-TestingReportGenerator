import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ImageIcon,
  Loader2,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import {
  ENABLE_SYSTEM_PDF,
  apiDeletePhoto,
  apiGetPhoto,
  apiReorderPhotos,
  apiSavePhoto,
} from '../api';
import type { PhotoItem, PhotoParams } from '../types';
import {
  DEFAULT_PHOTO_PARAMS,
  buildEditedJpegBase64,
  buildOriginalJpegBase64,
  loadImageFromDataUrl,
  loadImageFromFile,
  normalizePhotoParams,
} from '../utils/imageProcessing';
import type { PhotoThumbnailQueue } from '../utils/photoQueue';
import { isPdfFile } from '../utils/pdfToImages';
import { ConfirmDialog } from './ConfirmDialog';
import { PhotoEditorModal } from './PhotoEditorModal';
import { SystemPdfCropModal } from './SystemPdfCropModal';

const MAX_PHOTOS_PER_SLOT = 6;

interface PhotoSlotAreaProps {
  session: string;
  reportNo: string;
  slot: string;
  photos: PhotoItem[];
  photoQueue: PhotoThumbnailQueue;
  onUpdateSlotPhotos: (
    slot: string,
    updater: (prev: PhotoItem[]) => PhotoItem[]
  ) => void;
  onError: (message: string) => void;
}

interface EditorSession {
  mode: 'new' | 'edit';
  photoId?: string;
  sourceImage: HTMLImageElement;
  initialParams: PhotoParams;
  queueIndex?: number;
  queueTotal?: number;
}

export function PhotoSlotArea({
  session,
  reportNo,
  slot,
  photos,
  photoQueue,
  onUpdateSlotPhotos,
  onError,
}: PhotoSlotAreaProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Thumbnails loaded for photos in this slot
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [loadingThumbs, setLoadingThumbs] = useState<Record<string, boolean>>({});

  // Pending file queue when multiple files are selected
  const pendingFilesRef = useRef<File[]>([]);
  const pendingTotalRef = useRef(0);
  const pendingIndexRef = useRef(0);

  // Editor modal state
  const [editorSession, setEditorSession] = useState<EditorSession | null>(null);

  // Lightbox preview state
  const [previewPhotoId, setPreviewPhotoId] = useState<string | null>(null);
  const [loadingOriginal, setLoadingOriginal] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // System sheet PDF upload flow state (slot === 'SYSTEM' & ENABLE_SYSTEM_PDF only)
  const [pdfSession, setPdfSession] = useState<{
    file: File;
    remainingSlots: number;
  } | null>(null);
  const isSystemPdfEnabled = ENABLE_SYSTEM_PDF && slot === 'SYSTEM';

  // Sequentially load edited thumbnails via the shared 1-at-a-time queue
  useEffect(() => {
    let cancelled = false;

    for (const photo of photos) {
      if (photo.uploading || photo.localPreviewUrl) continue;

      const cached = photoQueue.getCached(photo.id);
      if (cached) {
        setThumbUrls((prev) =>
          prev[photo.id] === cached ? prev : { ...prev, [photo.id]: cached }
        );
        continue;
      }

      setLoadingThumbs((prev) =>
        prev[photo.id] ? prev : { ...prev, [photo.id]: true }
      );

      photoQueue.enqueue(session, photo.id).then((dataUrl) => {
        if (cancelled) return;
        setLoadingThumbs((prev) => {
          if (!prev[photo.id]) return prev;
          const next = { ...prev };
          delete next[photo.id];
          return next;
        });
        if (dataUrl) {
          setThumbUrls((prev) => ({ ...prev, [photo.id]: dataUrl }));
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [session, photos, photoQueue]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!previewPhotoId || deleteTargetId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewPhotoId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewPhotoId, deleteTargetId]);

  const remainingSlots = Math.max(0, MAX_PHOTOS_PER_SLOT - photos.length);

  async function openNextPendingFile() {
    while (pendingFilesRef.current.length > 0) {
      const nextFile = pendingFilesRef.current.shift()!;
      pendingIndexRef.current += 1;
      try {
        const img = await loadImageFromFile(nextFile);
        setEditorSession({
          mode: 'new',
          sourceImage: img,
          initialParams: { ...DEFAULT_PHOTO_PARAMS, crop: { ...DEFAULT_PHOTO_PARAMS.crop } },
          queueIndex: pendingIndexRef.current,
          queueTotal: pendingTotalRef.current,
        });
        return;
      } catch (err) {
        onError(
          err instanceof Error ? err.message : 'Could not open selected image.'
        );
      }
    }
    setEditorSession(null);
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const picked = Array.from(fileList);
    // Reset input value so picking the same file again triggers onChange
    e.target.value = '';

    if (remainingSlots <= 0) {
      onError(`Maximum ${MAX_PHOTOS_PER_SLOT} photos allowed per section.`);
      return;
    }

    if (isSystemPdfEnabled) {
      const pdfFile = picked.find(isPdfFile);
      if (pdfFile) {
        setPdfSession({
          file: pdfFile,
          remainingSlots,
        });
        return;
      }
    }

    const allowed = picked.slice(0, remainingSlots);
    if (picked.length > remainingSlots) {
      onError(
        `Only ${remainingSlots} more photo${remainingSlots === 1 ? '' : 's'} can be added (max ${MAX_PHOTOS_PER_SLOT}).`
      );
    }

    pendingFilesRef.current = allowed;
    pendingTotalRef.current = allowed.length;
    pendingIndexRef.current = 0;
    void openNextPendingFile();
  }

  async function handleSaveSystemPdfPage(payload: {
    originalBase64: string;
    editedBase64: string;
    editedDataUrl: string;
    params: PhotoParams;
  }): Promise<void> {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    onUpdateSlotPhotos(slot, (prev) => [
      ...prev,
      {
        id: tempId,
        slot,
        order: prev.length + 1,
        params: payload.params,
        uploading: true,
        localPreviewUrl: payload.editedDataUrl,
      },
    ]);

    try {
      const res = await apiSavePhoto(session, {
        reportNo,
        slot,
        original: payload.originalBase64,
        edited: payload.editedBase64,
        params: payload.params,
      });
      const realId = res.photoId;
      if (!realId) {
        throw new Error('Server did not return a photoId.');
      }
      photoQueue.setCached(realId, payload.editedDataUrl);
      setThumbUrls((prev) => ({ ...prev, [realId]: payload.editedDataUrl }));
      onUpdateSlotPhotos(slot, (prev) =>
        prev.map((p) =>
          p.id === tempId
            ? {
                id: realId,
                slot,
                order: p.order,
                params: payload.params,
                uploading: false,
              }
            : p
        )
      );
    } catch (err) {
      onUpdateSlotPhotos(slot, (prev) => prev.filter((p) => p.id !== tempId));
      throw err;
    }
  }

  function handleEditorCancel() {
    if (editorSession?.mode === 'new') {
      void openNextPendingFile();
    } else {
      setEditorSession(null);
    }
  }

  function handleEditorSave(params: PhotoParams) {
    if (!editorSession) return;
    const currentEditor = editorSession;
    const editedMaxSide = slot === 'SYSTEM' ? 2400 : 1600;

    if (currentEditor.mode === 'new') {
      let originalBase64: string;
      let editedResult: { base64: string; dataUrl: string };
      try {
        originalBase64 = buildOriginalJpegBase64(currentEditor.sourceImage);
        editedResult = buildEditedJpegBase64(
          currentEditor.sourceImage,
          params,
          editedMaxSide
        );
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Failed to process photo.');
        void openNextPendingFile();
        return;
      }

      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tempPhoto: PhotoItem = {
        id: tempId,
        slot,
        order: photos.length + 1,
        params,
        uploading: true,
        localPreviewUrl: editedResult.dataUrl,
      };

      onUpdateSlotPhotos(slot, (prev) => [...prev, tempPhoto]);

      // Advance editor immediately to next selected file (or close) while this upload runs
      void openNextPendingFile();

      // Send ONE savePhoto call immediately per photo
      apiSavePhoto(session, {
        reportNo,
        slot,
        original: originalBase64,
        edited: editedResult.base64,
        params,
      })
        .then((res) => {
          const realId = res.photoId;
          if (!realId) {
            throw new Error('Server did not return a photoId.');
          }
          photoQueue.setCached(realId, editedResult.dataUrl);
          setThumbUrls((prev) => ({ ...prev, [realId]: editedResult.dataUrl }));
          onUpdateSlotPhotos(slot, (prev) =>
            prev.map((p) =>
              p.id === tempId
                ? {
                    id: realId,
                    slot,
                    order: p.order,
                    params,
                    uploading: false,
                  }
                : p
            )
          );
        })
        .catch((err) => {
          onUpdateSlotPhotos(slot, (prev) => prev.filter((p) => p.id !== tempId));
          onError(err instanceof Error ? err.message : 'Failed to upload photo.');
        });
      return;
    }

    // Edit existing photo: send existing photoId with ONLY edited and params
    const targetId = currentEditor.photoId;
    if (!targetId) {
      setEditorSession(null);
      return;
    }

    let editedResult: { base64: string; dataUrl: string };
    try {
      editedResult = buildEditedJpegBase64(
        currentEditor.sourceImage,
        params,
        editedMaxSide
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to process photo.');
      setEditorSession(null);
      return;
    }

    setEditorSession(null);

    const prevPhoto = photos.find((p) => p.id === targetId);
    onUpdateSlotPhotos(slot, (prev) =>
      prev.map((p) =>
        p.id === targetId
          ? { ...p, uploading: true, localPreviewUrl: editedResult.dataUrl }
          : p
      )
    );

    apiSavePhoto(session, {
      reportNo,
      slot,
      photoId: targetId,
      edited: editedResult.base64,
      params,
    })
      .then(() => {
        photoQueue.setCached(targetId, editedResult.dataUrl);
        setThumbUrls((prev) => ({ ...prev, [targetId]: editedResult.dataUrl }));
        onUpdateSlotPhotos(slot, (prev) =>
          prev.map((p) =>
            p.id === targetId
              ? {
                  id: targetId,
                  slot,
                  order: p.order,
                  params,
                  uploading: false,
                }
              : p
          )
        );
      })
      .catch((err) => {
        onUpdateSlotPhotos(slot, (prev) =>
          prev.map((p) =>
            p.id === targetId
              ? {
                  ...(prevPhoto ?? p),
                  uploading: false,
                  localPreviewUrl: undefined,
                }
              : p
          )
        );
        onError(err instanceof Error ? err.message : 'Failed to save edited photo.');
      });
  }

  const previewIndex = previewPhotoId
    ? photos.findIndex((p) => p.id === previewPhotoId)
    : -1;
  const previewPhoto = previewIndex >= 0 ? photos[previewIndex] : null;

  async function handleEditAgain() {
    if (!previewPhoto || loadingOriginal || busyAction) return;
    setLoadingOriginal(true);
    try {
      const res = await apiGetPhoto(session, previewPhoto.id, 'original');
      if (!res.data) {
        throw new Error('Original image data is empty.');
      }
      const mime = res.mime || 'image/jpeg';
      const dataUrl = res.data.startsWith('data:')
        ? res.data
        : `data:${mime};base64,${res.data}`;
      const img = await loadImageFromDataUrl(dataUrl);
      const savedParams = normalizePhotoParams(previewPhoto.params);
      setPreviewPhotoId(null);
      setEditorSession({
        mode: 'edit',
        photoId: previewPhoto.id,
        sourceImage: img,
        initialParams: savedParams,
      });
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Failed to load original photo.'
      );
    } finally {
      setLoadingOriginal(false);
    }
  }

  async function handleMove(direction: -1 | 1) {
    if (previewIndex < 0 || busyAction) return;
    const targetIndex = previewIndex + direction;
    if (targetIndex < 0 || targetIndex >= photos.length) return;

    const previousOrder = [...photos];
    const reordered = [...photos];
    const [moved] = reordered.splice(previewIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    const updatedWithOrder = reordered.map((p, idx) => ({
      ...p,
      order: idx + 1,
    }));

    const serverIds = updatedWithOrder
      .filter((p) => !p.uploading && !p.id.startsWith('temp-'))
      .map((p) => p.id);

    setBusyAction(true);
    onUpdateSlotPhotos(slot, () => updatedWithOrder);
    try {
      await apiReorderPhotos(session, reportNo, slot, serverIds);
    } catch (err) {
      onUpdateSlotPhotos(slot, () => previousOrder);
      onError(err instanceof Error ? err.message : 'Failed to reorder photos.');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTargetId || busyAction) return;
    const idToDelete = deleteTargetId;
    setBusyAction(true);
    try {
      await apiDeletePhoto(session, idToDelete);
      photoQueue.removeCached(idToDelete);
      setThumbUrls((prev) => {
        const next = { ...prev };
        delete next[idToDelete];
        return next;
      });
      onUpdateSlotPhotos(slot, (prev) =>
        prev
          .filter((p) => p.id !== idToDelete)
          .map((p, idx) => ({ ...p, order: idx + 1 }))
      );
      setDeleteTargetId(null);
      if (previewPhotoId === idToDelete) {
        setPreviewPhotoId(null);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete photo.');
      setDeleteTargetId(null);
    } finally {
      setBusyAction(false);
    }
  }

  const editorTitle =
    editorSession?.mode === 'new' &&
    editorSession.queueTotal &&
    editorSession.queueTotal > 1
      ? `Edit photo (${editorSession.queueIndex} of ${editorSession.queueTotal})`
      : 'Edit photo';

  return (
    <div className="space-y-3 border-t border-gray-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-gray-700">
          Photos{' '}
          <span className="text-gray-400 tabular-nums">
            ({photos.length}/{MAX_PHOTOS_PER_SLOT})
          </span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={isSystemPdfEnabled ? 'image/*,application/pdf,.pdf' : 'image/*'}
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={remainingSlots <= 0}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#1F3A8A]/30 bg-blue-50/70 px-3 py-1.5 text-sm font-medium text-[#1F3A8A] transition-colors hover:bg-blue-100/70 active:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap"
        >
          <Camera className="h-4 w-4" aria-hidden="true" />
          <span>{isSystemPdfEnabled ? 'Upload image or PDF' : 'Add photo'}</span>
        </button>
      </div>

      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
          {photos.map((photo, idx) => {
            const imgSrc =
              photo.localPreviewUrl ||
              thumbUrls[photo.id] ||
              photoQueue.getCached(photo.id);
            const isLoadingThumb = Boolean(loadingThumbs[photo.id]) && !imgSrc;

            return (
              <button
                key={photo.id}
                type="button"
                disabled={Boolean(photo.uploading)}
                onClick={() => setPreviewPhotoId(photo.id)}
                className="group relative aspect-square w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100 focus-visible:outline-2 focus-visible:outline-[#1F3A8A] disabled:cursor-wait"
                aria-label={`View photo ${idx + 1}`}
              >
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={`${slot} photo ${idx + 1}`}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-gray-400">
                    {isLoadingThumb ? (
                      <Loader2 className="h-5 w-5 animate-spin text-[#1F3A8A]" />
                    ) : (
                      <ImageIcon className="h-5 w-5" />
                    )}
                    <span className="text-[11px] font-medium">
                      {isLoadingThumb ? 'Loading' : 'Photo'}
                    </span>
                  </div>
                )}

                {photo.uploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  </div>
                )}

                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
                  {idx + 1}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Photo Editor Modal */}
      {editorSession && (
        <PhotoEditorModal
          key={`${editorSession.mode}-${editorSession.photoId ?? editorSession.queueIndex ?? 0}`}
          open={true}
          sourceImage={editorSession.sourceImage}
          initialParams={editorSession.initialParams}
          title={editorTitle}
          onCancel={handleEditorCancel}
          onSave={handleEditorSave}
        />
      )}

      {/* System Sheet PDF Crop-Only Modal */}
      {isSystemPdfEnabled && pdfSession && (
        <SystemPdfCropModal
          file={pdfSession.file}
          remainingSlots={pdfSession.remainingSlots}
          onSavePage={handleSaveSystemPdfPage}
          onClose={() => setPdfSession(null)}
        />
      )}

      {/* Large Preview Lightbox */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-40 flex flex-col bg-black/95 text-white"
          role="dialog"
          aria-modal="true"
          aria-label="Photo preview"
        >
          {/* Top bar */}
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
            <span className="text-sm font-medium text-white/90 tabular-nums">
              Photo {previewIndex + 1} of {photos.length}
            </span>
            <button
              type="button"
              onClick={() => setPreviewPhotoId(null)}
              aria-label="Close preview"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Large image */}
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {(() => {
              const previewSrc =
                previewPhoto.localPreviewUrl ||
                thumbUrls[previewPhoto.id] ||
                photoQueue.getCached(previewPhoto.id);
              return previewSrc ? (
                <img
                  src={previewSrc}
                  alt={`${slot} photo ${previewIndex + 1}`}
                  referrerPolicy="no-referrer"
                  className="max-h-full max-w-full rounded object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-gray-400">
                  <Loader2 className="h-7 w-7 animate-spin" />
                  <span className="text-sm">Loading photo...</span>
                </div>
              );
            })()}
          </div>

          {/* Action bar */}
          <div className="shrink-0 border-t border-white/10 bg-gray-950/90 px-4 py-3">
            <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={handleEditAgain}
                disabled={loadingOriginal || busyAction}
                className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#1F3A8A] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#2647A8] disabled:opacity-50 whitespace-nowrap"
              >
                {loadingOriginal ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                )}
                <span>{loadingOriginal ? 'Loading original...' : 'Edit again'}</span>
              </button>

              <button
                type="button"
                onClick={() => handleMove(-1)}
                disabled={previewIndex <= 0 || busyAction || loadingOriginal}
                className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 whitespace-nowrap"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Move left</span>
              </button>

              <button
                type="button"
                onClick={() => handleMove(1)}
                disabled={
                  previewIndex >= photos.length - 1 || busyAction || loadingOriginal
                }
                className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 whitespace-nowrap"
              >
                <span>Move right</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={() => setDeleteTargetId(previewPhoto.id)}
                disabled={busyAction || loadingOriginal}
                className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-red-600/90 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 whitespace-nowrap"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTargetId !== null}
        title="Delete photo"
        message="Are you sure you want to delete this photo? This action cannot be undone."
        confirmLabel={busyAction ? 'Deleting...' : 'Delete'}
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!busyAction) setDeleteTargetId(null);
        }}
      />
    </div>
  );
}
