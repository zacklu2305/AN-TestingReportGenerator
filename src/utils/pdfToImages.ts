const PDFJS_VERSION = '3.11.174';
const PDFJS_SCRIPT_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

export const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PDF_PAGES = 3;
export const PDF_RENDER_MAX_SIDE = 2400;
export const PDF_RENDER_JPEG_QUALITY = 0.92;

interface PdfJsViewport {
  width: number;
  height: number;
}

interface PdfJsPage {
  getViewport: (params: { scale: number }) => PdfJsViewport;
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfJsViewport;
  }) => { promise: Promise<void> };
  cleanup: () => void;
}

interface PdfJsDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
  destroy: () => Promise<void>;
}

interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (params: { data: Uint8Array }) => {
    promise: Promise<PdfJsDocument>;
    destroy?: () => Promise<void>;
  };
}

interface WindowWithPdfJs extends Window {
  pdfjsLib?: PdfJsLib;
}

export interface RenderedPdfPage {
  pageNumber: number;
  dataUrl: string;
  base64: string;
  width: number;
  height: number;
}

export interface PdfConversionResult {
  pages: RenderedPdfPage[];
  totalPdfPages: number;
  notices: string[];
}

let pdfJsLoadPromise: Promise<PdfJsLib> | null = null;

function loadPdfJs(): Promise<PdfJsLib> {
  const win = window as WindowWithPdfJs;
  if (win.pdfjsLib) {
    win.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return Promise.resolve(win.pdfjsLib);
  }

  if (pdfJsLoadPromise) {
    return pdfJsLoadPromise;
  }

  pdfJsLoadPromise = new Promise<PdfJsLib>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PDFJS_SCRIPT_URL}"]`
    );

    const onReady = () => {
      if (win.pdfjsLib) {
        win.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(win.pdfjsLib);
      } else {
        pdfJsLoadPromise = null;
        reject(new Error('PDF library failed to initialize.'));
      }
    };

    const onFail = () => {
      pdfJsLoadPromise = null;
      reject(new Error('Failed to load PDF library.'));
    };

    if (existing) {
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener('error', onFail, { once: true });
      if (win.pdfjsLib) {
        onReady();
      }
      return;
    }

    const script = document.createElement('script');
    script.src = PDFJS_SCRIPT_URL;
    script.async = true;
    script.onload = onReady;
    script.onerror = onFail;
    document.head.appendChild(script);
  });

  return pdfJsLoadPromise;
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

export function isPdfFile(file: File): boolean {
  return (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  );
}

/**
 * Lazily loads PDF.js 3.11.174 from cdnjs and renders up to min(numPages, 3, remainingSlots)
 * pages sequentially on a white background with longest side 2400 px, JPEG quality 0.92.
 * Frees each page and canvas immediately to keep mobile memory usage low.
 */
export async function convertPdfToJpegPages(
  file: File,
  remainingSlots: number,
  options?: {
    signal?: AbortSignal;
    onProgress?: (currentPage: number, totalPagesToRender: number) => void;
    onNotices?: (notices: string[]) => void;
  }
): Promise<PdfConversionResult> {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error('PDF_TOO_LARGE');
  }
  if (remainingSlots <= 0) {
    throw new Error('NO_FREE_SLOTS');
  }

  const pdfjsLib = await loadPdfJs();
  if (options?.signal?.aborted) {
    throw new Error('ABORTED');
  }

  const arrayBuffer = await file.arrayBuffer();
  if (options?.signal?.aborted) {
    throw new Error('ABORTED');
  }

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
  });

  let pdfDoc: PdfJsDocument | null = null;
  try {
    pdfDoc = await loadingTask.promise;
    const totalPdfPages = Number(pdfDoc.numPages) || 0;
    if (totalPdfPages <= 0) {
      throw new Error('PDF_EMPTY');
    }

    const cappedByMax = Math.min(totalPdfPages, MAX_PDF_PAGES);
    const pagesToUse = Math.min(cappedByMax, remainingSlots);
    const notices: string[] = [];

    if (totalPdfPages > MAX_PDF_PAGES) {
      notices.push('Only the first 3 pages are used.');
    }
    if (remainingSlots < cappedByMax) {
      notices.push(
        `Only ${remainingSlots} free place${remainingSlots === 1 ? '' : 's'} left in this slot; using the first ${pagesToUse} page${pagesToUse === 1 ? '' : 's'}.`
      );
    }

    if (notices.length > 0) {
      options?.onNotices?.(notices);
    }

    const pages: RenderedPdfPage[] = [];

    for (let pageNum = 1; pageNum <= pagesToUse; pageNum++) {
      if (options?.signal?.aborted) {
        throw new Error('ABORTED');
      }

      options?.onProgress?.(pageNum, pagesToUse);

      let page: PdfJsPage | null = null;
      let canvas: HTMLCanvasElement | null = null;
      try {
        page = await pdfDoc.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1 });
        const longest = Math.max(baseViewport.width, baseViewport.height);
        const scale = PDF_RENDER_MAX_SIDE / Math.max(1, longest);
        const viewport = page.getViewport({ scale });

        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));

        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          throw new Error('CANVAS_UNAVAILABLE');
        }

        // Paint opaque white background before rendering PDF page
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);

        await page.render({ canvasContext: ctx, viewport }).promise;

        const dataUrl = canvas.toDataURL('image/jpeg', PDF_RENDER_JPEG_QUALITY);
        const base64 = stripDataUrlPrefix(dataUrl);

        pages.push({
          pageNumber: pageNum,
          dataUrl,
          base64,
          width,
          height,
        });
      } finally {
        // Release per-page resources immediately to avoid mobile OOM
        if (page) {
          try {
            page.cleanup();
          } catch {
            // ignore cleanup errors
          }
        }
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }

      // Yield briefly to the event loop between pages so UI progress updates smoothly
      await new Promise((r) => window.setTimeout(r, 16));
    }

    return {
      pages,
      totalPdfPages,
      notices,
    };
  } finally {
    if (pdfDoc) {
      try {
        await pdfDoc.destroy();
      } catch {
        // ignore destroy errors
      }
    } else if (typeof loadingTask.destroy === 'function') {
      try {
        await loadingTask.destroy();
      } catch {
        // ignore destroy errors
      }
    }
  }
}
