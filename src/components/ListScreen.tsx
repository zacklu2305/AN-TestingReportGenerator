import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckSquare,
  ChevronRight,
  Download,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  ENABLE_BATCH,
  ENABLE_FORMAT_CHOICE,
  ENABLE_NEW_LIST,
  apiBuildReport,
  apiList,
  getForgetfulInputAttrs,
} from '../api';
import type { BuildReportFormat, ReportListRow } from '../types';
import { base64ToBlob, downloadBlob } from '../utils/imageProcessing';
import { ErrorBanner } from './ErrorBanner';

const COMPANY_LOGO_URL =
  'https://res.cloudinary.com/dorqvdstv/image/upload/v1785116299/AN_Logo_Color_xzz9l2.png';
const JSZIP_CDN_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const DEFAULT_ROW_LIMIT = 20;
const SEARCH_ROW_LIMIT = 50;
const MAX_BATCH_REPORTS = 10;
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

const FORMAT_OPTIONS: { value: BuildReportFormat; label: string }[] = [
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'pdf', label: 'PDF (.pdf)' },
  { value: 'both', label: 'Both (.docx + .pdf)' },
];

interface JSZipInstance {
  file: (name: string, data: Blob) => void;
  generateAsync: (options: { type: 'blob' }) => Promise<Blob>;
}

type JSZipConstructor = new () => JSZipInstance;

interface WindowWithJSZip extends Window {
  JSZip?: JSZipConstructor;
}

interface ListScreenProps {
  session: string;
  onSelectReport: (reportNo: string) => void;
  onLogout: () => void;
}

function extractNumberParts(reportNo: string): number[] {
  const matches = String(reportNo || '').match(/\d+/g);
  if (!matches) return [];
  return matches.map((part) => Number.parseInt(part, 10));
}

function compareVncaDesc(a: ReportListRow, b: ReportListRow): number {
  const aParts = extractNumberParts(a.reportNo);
  const bParts = extractNumberParts(b.reportNo);

  if (aParts.length > 0 && bParts.length === 0) return -1;
  if (aParts.length === 0 && bParts.length > 0) return 1;

  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const av = aParts[i] ?? -1;
    const bv = bParts[i] ?? -1;
    if (av !== bv) {
      return bv - av;
    }
  }

  return String(b.reportNo || '').localeCompare(
    String(a.reportNo || ''),
    undefined,
    { numeric: true, sensitivity: 'base' }
  );
}

function formatTodayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadJSZip(): Promise<JSZipConstructor | null> {
  const win = window as WindowWithJSZip;
  if (typeof win.JSZip === 'function') {
    return Promise.resolve(win.JSZip);
  }

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${JSZIP_CDN_URL}"]`
    );

    const finish = () => {
      resolve(typeof win.JSZip === 'function' ? win.JSZip : null);
    };

    const timer = window.setTimeout(finish, 8000);

    const onLoad = () => {
      window.clearTimeout(timer);
      finish();
    };
    const onError = () => {
      window.clearTimeout(timer);
      resolve(null);
    };

    if (existing) {
      existing.addEventListener('load', onLoad, { once: true });
      existing.addEventListener('error', onError, { once: true });
      // In case the script already finished loading before listener attachment
      if (typeof win.JSZip === 'function') {
        onLoad();
      }
      return;
    }

    const script = document.createElement('script');
    script.src = JSZIP_CDN_URL;
    script.async = true;
    script.onload = onLoad;
    script.onerror = onError;
    document.head.appendChild(script);
  });
}

function makeUniqueFileName(rawName: string, usedNames: Set<string>): string {
  const clean = rawName.trim() || 'Report.docx';
  if (!usedNames.has(clean)) {
    usedNames.add(clean);
    return clean;
  }
  const dotIdx = clean.lastIndexOf('.');
  const base = dotIdx > 0 ? clean.slice(0, dotIdx) : clean;
  const ext = dotIdx > 0 ? clean.slice(dotIdx) : '';
  let counter = 2;
  let candidate = `${base}_${counter}${ext}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${base}_${counter}${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

interface BuiltDownloadFile {
  fileName: string;
  blob: Blob;
}

function validateBuiltFile(
  file: { fileName?: string; mime?: string; data?: string } | undefined,
  expectedExt: '.docx' | '.pdf',
  fallbackMime: string
): BuiltDownloadFile | null {
  if (!file || typeof file.data !== 'string' || !file.data) return null;
  const trimmedName =
    typeof file.fileName === 'string' ? file.fileName.trim() : '';
  if (!trimmedName || !trimmedName.toLowerCase().endsWith(expectedExt)) {
    return null;
  }
  try {
    const blob = base64ToBlob(file.data, file.mime || fallbackMime);
    return { fileName: trimmedName, blob };
  } catch {
    return null;
  }
}

function alignMatchingPdfName(
  docxFile: BuiltDownloadFile,
  pdfFile: BuiltDownloadFile
): BuiltDownloadFile {
  const docxBase = docxFile.fileName.slice(0, -5);
  const pdfBase = pdfFile.fileName.slice(0, -4);
  if (docxBase && docxBase !== pdfBase) {
    return { ...pdfFile, fileName: `${docxBase}.pdf` };
  }
  return pdfFile;
}

export function ListScreen({
  session,
  onSelectReport,
  onLogout,
}: ListScreenProps) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ReportListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  // Batch download state (used when ENABLE_BATCH is true)
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [maxLimitNotice, setMaxLimitNotice] = useState(false);
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [formatModalOpen, setFormatModalOpen] = useState(false);
  const [selectedFormat, setSelectedFormat] =
    useState<BuildReportFormat>('docx');

  const requestCounterRef = useRef(0);
  const isFirstRunRef = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const selectedFormatRef = useRef<BuildReportFormat>(selectedFormat);
  selectedFormatRef.current = selectedFormat;
  const batchDownloadRef = useRef<(fmt: BuildReportFormat) => Promise<void>>(
    async () => {}
  );

  const fetchList = useCallback(async (searchText: string) => {
    const reqId = ++requestCounterRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiList(sessionRef.current, searchText);
      if (reqId !== requestCounterRef.current) return;
      setRows(Array.isArray(res.rows) ? res.rows : []);
    } catch (err) {
      if (reqId !== requestCounterRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load reports.');
    } finally {
      if (reqId === requestCounterRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Load reports:
  // - When ENABLE_NEW_LIST is true: fetch all reports once on mount (and on Refresh); filter client-side.
  // - When ENABLE_NEW_LIST is false: keep previous server search with 400 ms debounce.
  useEffect(() => {
    if (ENABLE_NEW_LIST) {
      fetchList('');
      return;
    }

    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      fetchList(query);
      return;
    }
    const timer = window.setTimeout(() => {
      fetchList(query);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [query, fetchList]);

  // Sorted and filtered rows for the new list screen
  const visibleRows = useMemo(() => {
    if (!ENABLE_NEW_LIST) return rows;

    const sorted = [...rows].sort(compareVncaDesc);
    const trimmed = query.trim().toLowerCase();

    if (!trimmed) {
      return sorted.slice(0, DEFAULT_ROW_LIMIT);
    }

    const matched = sorted.filter((row) => {
      const haystack = [row.reportNo, row.buyer, row.factory, row.color]
        .map((v) => (v == null ? '' : String(v).toLowerCase()))
        .join(' ');
      return haystack.includes(trimmed);
    });

    return matched.slice(0, SEARCH_ROW_LIMIT);
  }, [rows, query]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const isBatchWorking = batchProgress !== null;

  function handleToggleSelectMode() {
    if (isBatchWorking) return;
    if (selectMode) {
      setSelectMode(false);
      setSelectedIds([]);
      setMaxLimitNotice(false);
    } else {
      setSelectMode(true);
      setSelectedIds([]);
      setMaxLimitNotice(false);
    }
  }

  function handleToggleRowSelection(reportNo: string) {
    if (isBatchWorking) return;
    setSelectedIds((prev) => {
      if (prev.includes(reportNo)) {
        setMaxLimitNotice(false);
        return prev.filter((id) => id !== reportNo);
      }
      if (prev.length >= MAX_BATCH_REPORTS) {
        setMaxLimitNotice(true);
        return prev;
      }
      setMaxLimitNotice(false);
      return [...prev, reportNo];
    });
  }

  function handleDownloadSelectedClick() {
    if (isBatchWorking || selectedIds.length === 0) return;
    if (!ENABLE_FORMAT_CHOICE) {
      void handleBatchDownload('docx');
      return;
    }
    setSelectedFormat('docx');
    setFormatModalOpen(true);
  }

  function handleConfirmFormatModal() {
    const chosen = selectedFormatRef.current;
    setFormatModalOpen(false);
    void handleBatchDownload(chosen);
  }

  async function handleBatchDownload(format: BuildReportFormat = 'docx') {
    if (isBatchWorking || selectedIds.length === 0) return;
    const targets = [...selectedIds];
    const total = targets.length;
    setError(null);
    setMaxLimitNotice(false);

    const succeeded: BuiltDownloadFile[] = [];
    const failed: string[] = [];

    try {
      for (let i = 0; i < total; i++) {
        const reportNo = targets[i];

        if (!ENABLE_FORMAT_CHOICE) {
          setBatchProgress(`Report ${i + 1} of ${total}...`);
          try {
            const res = await apiBuildReport(sessionRef.current, reportNo, 'docx');
            if (!res.data) {
              throw new Error('Missing file data');
            }
            const mime = res.mime || DOCX_MIME;
            const fileName = res.fileName || `${reportNo}.docx`;
            const blob = base64ToBlob(res.data, mime);
            succeeded.push({ fileName, blob });
          } catch {
            failed.push(reportNo);
          }
          continue;
        }

        setBatchProgress(`Building report ${i + 1} of ${total}...`);

        if (format === 'docx') {
          try {
            const res = await apiBuildReport(sessionRef.current, reportNo, 'docx');
            const docxFile = validateBuiltFile(res, '.docx', DOCX_MIME);
            if (docxFile) {
              succeeded.push(docxFile);
            } else {
              failed.push(`${reportNo} (Word)`);
            }
          } catch {
            failed.push(`${reportNo} (Word)`);
          }
        } else if (format === 'pdf') {
          try {
            const res = await apiBuildReport(sessionRef.current, reportNo, 'pdf');
            const pdfFile = validateBuiltFile(res, '.pdf', PDF_MIME);
            if (pdfFile) {
              succeeded.push(pdfFile);
            } else {
              failed.push(`${reportNo} (PDF)`);
            }
          } catch {
            failed.push(`${reportNo} (PDF)`);
          }
        } else {
          // format === 'both'
          let initialDocx: BuiltDownloadFile | null = null;
          let initialPdf: BuiltDownloadFile | null = null;
          try {
            const res = await apiBuildReport(sessionRef.current, reportNo, 'both');
            initialDocx = validateBuiltFile(res, '.docx', DOCX_MIME);
            initialPdf = validateBuiltFile(res.pdf, '.pdf', PDF_MIME);
          } catch {
            initialDocx = null;
            initialPdf = null;
          }

          if (initialDocx && initialPdf) {
            succeeded.push(
              initialDocx,
              alignMatchingPdfName(initialDocx, initialPdf)
            );
          } else {
            // Fallback: try once more with two separate requests (docx then pdf)
            let retryDocx: BuiltDownloadFile | null = null;
            try {
              const docxRes = await apiBuildReport(
                sessionRef.current,
                reportNo,
                'docx'
              );
              retryDocx = validateBuiltFile(docxRes, '.docx', DOCX_MIME);
            } catch {
              retryDocx = null;
            }

            let retryPdf: BuiltDownloadFile | null = null;
            try {
              const pdfRes = await apiBuildReport(
                sessionRef.current,
                reportNo,
                'pdf'
              );
              retryPdf = validateBuiltFile(pdfRes, '.pdf', PDF_MIME);
            } catch {
              retryPdf = null;
            }

            const finalDocx = retryDocx ?? initialDocx;
            const finalPdf = retryPdf ?? initialPdf;

            if (finalDocx && finalPdf) {
              succeeded.push(
                finalDocx,
                alignMatchingPdfName(finalDocx, finalPdf)
              );
            } else {
              if (finalDocx) {
                succeeded.push(finalDocx);
              } else {
                failed.push(`${reportNo} (Word)`);
              }
              if (finalPdf) {
                succeeded.push(finalPdf);
              } else {
                failed.push(`${reportNo} (PDF)`);
              }
            }
          }
        }
      }

      if (succeeded.length === 1) {
        downloadBlob(succeeded[0].blob, succeeded[0].fileName);
      } else if (succeeded.length > 1) {
        let zipped = false;
        try {
          const JSZipCtor = await loadJSZip();
          if (JSZipCtor) {
            const zip = new JSZipCtor();
            const usedNames = new Set<string>();
            for (const item of succeeded) {
              const uniqueName = makeUniqueFileName(item.fileName, usedNames);
              zip.file(uniqueName, item.blob);
            }
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            downloadBlob(zipBlob, `Testing_Reports_${formatTodayYmd()}.zip`);
            zipped = true;
          }
        } catch {
          zipped = false;
        }

        // Fallback: download files one by one if JSZip failed to load or zip
        if (!zipped) {
          for (let i = 0; i < succeeded.length; i++) {
            downloadBlob(succeeded[i].blob, succeeded[i].fileName);
            if (i < succeeded.length - 1) {
              await new Promise((r) => window.setTimeout(r, 250));
            }
          }
        }
      }

      if (failed.length > 0) {
        if (!ENABLE_FORMAT_CHOICE) {
          setError(`Failed to download: ${failed.join(', ')}`);
        } else {
          const fileCountLabel =
            failed.length === 1 ? '1 file' : `${failed.length} files`;
          setError(`${fileCountLabel} could not be built: ${failed.join(', ')}`);
        }
      }

      if (succeeded.length > 0) {
        setSelectMode(false);
        setSelectedIds([]);
      }
    } finally {
      setBatchProgress(null);
    }
  }

  batchDownloadRef.current = handleBatchDownload;

  useEffect(() => {
    if (!ENABLE_FORMAT_CHOICE || !formatModalOpen) return;

    function handleModalKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFormatModalOpen(false);
        return;
      }
      if (e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        if (target?.dataset.formatCancel === 'true') {
          return;
        }
        e.preventDefault();
        const chosen = selectedFormatRef.current;
        setFormatModalOpen(false);
        void batchDownloadRef.current(chosen);
      }
    }

    window.addEventListener('keydown', handleModalKeyDown, true);
    return () => window.removeEventListener('keydown', handleModalKeyDown, true);
  }, [formatModalOpen]);

  // Fallback: previous list screen & previous header when ENABLE_NEW_LIST is false
  if (!ENABLE_NEW_LIST) {
    return (
      <div className="min-h-dvh flex flex-col bg-gray-100">
        <header className="sticky top-0 z-30 bg-[#1F3A8A] text-white shadow-sm">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4">
            <h1 className="text-lg font-semibold tracking-tight whitespace-nowrap">
              Testing Report
            </h1>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => fetchList(query)}
                disabled={loading}
                className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20 active:bg-white/25 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>Refresh</span>
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20 active:bg-white/25 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>Log out</span>
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-4 sm:py-6">
          <div className="mb-4">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                {...getForgetfulInputAttrs('list_q_alt')}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search report no., buyer, factory, color..."
                aria-label="Search testing reports"
                className="block w-full min-h-[46px] rounded-xl border border-gray-300 bg-white pl-11 pr-10 py-2.5 text-base text-gray-900 shadow-xs placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="mt-1.5 px-0.5 text-xs text-gray-500">
              Showing open reports only (no completion date yet)
            </p>
          </div>

          {error && (
            <div className="mb-4">
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </div>
          )}

          {loading && rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-gray-200 bg-white py-14 text-gray-500">
              <Loader2 className="h-7 w-7 animate-spin text-[#1F3A8A]" aria-hidden="true" />
              <p className="mt-3 text-sm">Loading reports...</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border border-gray-200 bg-white px-6 py-12 text-center">
              <p className="text-base font-medium text-gray-900">
                No open reports found.
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {query.trim()
                  ? 'Try a different search keyword or clear the search box.'
                  : 'No open testing reports are available right now.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {rows.map((row) => {
                const subtitleParts = [row.buyer, row.factory, row.color]
                  .map((part) => (part == null ? '' : String(part).trim()))
                  .filter(Boolean);
                const subtitle = subtitleParts.join(' · ');

                return (
                  <button
                    key={row.reportNo}
                    type="button"
                    onClick={() => onSelectReport(row.reportNo)}
                    className="group flex w-full items-start justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left shadow-xs transition-colors hover:border-[#1F3A8A]/40 hover:bg-blue-50/20 active:bg-gray-50 focus-visible:outline-2 focus-visible:outline-[#1F3A8A]"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-bold text-gray-900 tabular-nums break-words">
                          {row.reportNo}
                        </span>
                        {row.saved === true && (
                          <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
                            Saved
                          </span>
                        )}
                      </div>

                      {subtitle && (
                        <p className="text-sm text-gray-700 leading-snug break-words">
                          {subtitle}
                        </p>
                      )}

                      {row.request && (
                        <p className="text-xs text-gray-500 leading-relaxed line-clamp-2 break-words">
                          {row.request}
                        </p>
                      )}
                    </div>

                    <ChevronRight
                      className="mt-1 h-5 w-5 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5 group-hover:text-[#1F3A8A]"
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div
      className={`glass-page-bg min-h-dvh flex flex-col ${
        selectMode ? 'pb-24' : ''
      }`}
    >
      {/* Liquid Glass Navy Header */}
      <header className="glass-header sticky top-0 z-30 text-white">
        <div className="mx-auto flex h-15 max-w-5xl items-center justify-between gap-2 px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {!logoFailed && (
              <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/95 px-2.5 py-1 shadow-xs">
                <img
                  src={COMPANY_LOGO_URL}
                  alt="Company logo"
                  referrerPolicy="no-referrer"
                  onError={() => setLogoFailed(true)}
                  className="h-[28px] w-auto object-contain"
                />
              </span>
            )}
            <h1 className="truncate text-base font-semibold tracking-tight text-white sm:text-lg">
              Testing Report
            </h1>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={() => fetchList('')}
              disabled={loading || isBatchWorking}
              className="flex min-h-[40px] items-center gap-1.5 rounded-2xl border border-white/20 bg-white/12 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-white/22 active:bg-white/28 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              type="button"
              onClick={onLogout}
              disabled={isBatchWorking}
              className="flex min-h-[40px] items-center gap-1.5 rounded-2xl border border-white/20 bg-white/12 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-white/22 active:bg-white/28 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>Log out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-4 pb-6 sm:pt-6">
        {/* Search box */}
        <div className="mb-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500"
              aria-hidden="true"
            />
            <input
              {...getForgetfulInputAttrs('list_q')}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search VNCA No., Buyer, Factory, or Color Name..."
              aria-label="Search testing reports"
              className="glass-input block w-full min-h-[46px] pl-11 pr-10 py-2.5 text-base text-gray-900 placeholder:text-gray-500 focus:border-[#1F3A8A] focus:bg-white/95 focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-xl text-gray-500 hover:bg-gray-200/70 hover:text-gray-800"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Toolbar row above list: Select button (when ENABLE_BATCH is true) */}
        {ENABLE_BATCH && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-gray-600">
              {selectMode
                ? maxLimitNotice
                  ? 'Max 10 reports'
                  : `Selected ${selectedIds.length} of ${MAX_BATCH_REPORTS} max`
                : query.trim()
                  ? `${visibleRows.length} result${visibleRows.length === 1 ? '' : 's'}`
                  : `Latest ${visibleRows.length} report${visibleRows.length === 1 ? '' : 's'}`}
            </div>

            <button
              type="button"
              onClick={handleToggleSelectMode}
              disabled={loading || isBatchWorking || visibleRows.length === 0}
              className={`glass-btn inline-flex min-h-[40px] items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap ${
                selectMode
                  ? 'border-[#1F3A8A]/40 bg-[#1F3A8A]/10 text-[#1F3A8A]'
                  : 'text-gray-800 hover:bg-white/95'
              }`}
            >
              <CheckSquare className="h-4 w-4" aria-hidden="true" />
              <span>{selectMode ? 'Cancel' : 'Select'}</span>
            </button>
          </div>
        )}

        {/* Max 10 reports notice */}
        {selectMode && maxLimitNotice && (
          <div
            role="status"
            className="mb-3 rounded-2xl border border-amber-300 bg-amber-50/90 px-4 py-2.5 text-sm font-medium text-amber-900 backdrop-blur-md"
          >
            Max 10 reports
          </div>
        )}

        {error && (
          <div className="mb-3">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {/* Report Rows */}
        {loading && rows.length === 0 ? (
          <div className="glass-card flex flex-col items-center justify-center py-14 text-gray-600">
            <Loader2
              className="h-7 w-7 animate-spin text-[#1F3A8A]"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-medium">Loading reports...</p>
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="glass-card px-6 py-12 text-center">
            <p className="text-base font-semibold text-gray-900">
              No report found
            </p>
          </div>
        ) : (
          <div className="glass-card overflow-hidden">
            {/* Desktop column header */}
            <div
              className={`hidden md:grid items-center gap-3 border-b border-slate-200/80 bg-white/50 px-4 py-2.5 text-xs font-semibold text-gray-600 ${
                selectMode
                  ? 'md:grid-cols-[36px_minmax(150px,1.2fr)_minmax(110px,1fr)_minmax(110px,1fr)_minmax(120px,1.2fr)]'
                  : 'md:grid-cols-[minmax(150px,1.2fr)_minmax(110px,1fr)_minmax(110px,1fr)_minmax(120px,1.2fr)_24px]'
              }`}
            >
              {selectMode && <div aria-hidden="true" />}
              <div>VNCA No.</div>
              <div>Buyer</div>
              <div>Factory</div>
              <div>Color Name</div>
              {!selectMode && <div aria-hidden="true" />}
            </div>

            <div className="divide-y divide-slate-200/75">
              {visibleRows.map((row) => {
                const isChecked = selectedSet.has(row.reportNo);
                const buyer = row.buyer ? String(row.buyer).trim() : '';
                const factory = row.factory ? String(row.factory).trim() : '';
                const color = row.color ? String(row.color).trim() : '';
                const mobileDetails = [buyer, factory, color]
                  .filter(Boolean)
                  .join(' · ');

                return (
                  <button
                    key={row.reportNo}
                    type="button"
                    disabled={isBatchWorking}
                    onClick={() => {
                      if (selectMode) {
                        handleToggleRowSelection(row.reportNo);
                      } else {
                        onSelectReport(row.reportNo);
                      }
                    }}
                    className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#1F3A8A] disabled:opacity-70 ${
                      isChecked
                        ? 'bg-blue-50/75 hover:bg-blue-50/90'
                        : 'hover:bg-white/75 active:bg-blue-50/40'
                    }`}
                  >
                    {/* Checkbox in select mode */}
                    {selectMode && (
                      <span
                        role="checkbox"
                        aria-checked={isChecked}
                        aria-label={`Select ${row.reportNo}`}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                          isChecked
                            ? 'border-[#1F3A8A] bg-[#1F3A8A] text-white'
                            : 'border-gray-400 bg-white/90'
                        }`}
                      >
                        {isChecked && (
                          <Check className="h-3.5 w-3.5 stroke-[3]" aria-hidden="true" />
                        )}
                      </span>
                    )}

                    {/* Mobile layout: 2-line row */}
                    <div className="min-w-0 flex-1 md:hidden">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-bold text-gray-900 tabular-nums break-words">
                          {row.reportNo}
                        </span>
                        {row.saved === true && (
                          <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
                            Saved
                          </span>
                        )}
                      </div>
                      {mobileDetails && (
                        <p className="mt-0.5 text-sm text-gray-700 truncate">
                          {mobileDetails}
                        </p>
                      )}
                    </div>

                    {/* Desktop layout: aligned row columns */}
                    <div className="hidden min-w-0 flex-1 md:grid md:grid-cols-[minmax(150px,1.2fr)_minmax(110px,1fr)_minmax(110px,1fr)_minmax(120px,1.2fr)] md:items-center md:gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-bold text-gray-900 tabular-nums">
                          {row.reportNo}
                        </span>
                        {row.saved === true && (
                          <span className="inline-flex shrink-0 items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
                            Saved
                          </span>
                        )}
                      </div>
                      <div className="truncate text-sm text-gray-800">
                        {buyer || '—'}
                      </div>
                      <div className="truncate text-sm text-gray-800">
                        {factory || '—'}
                      </div>
                      <div className="truncate text-sm text-gray-800">
                        {color || '—'}
                      </div>
                    </div>

                    {!selectMode && (
                      <ChevronRight
                        className="h-5 w-5 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5 group-hover:text-[#1F3A8A]"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-xs text-gray-500">
        Developed by Zack Lu
      </footer>

      {/* Batch Download Bottom Bar */}
      {ENABLE_BATCH && selectMode && (
        <div className="glass-bar fixed bottom-0 left-0 right-0 z-30 px-4 py-3">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              {batchProgress ? (
                <div className="flex items-center gap-2 text-sm font-semibold text-[#1F3A8A]">
                  <Loader2
                    className="h-4 w-4 shrink-0 animate-spin"
                    aria-hidden="true"
                  />
                  <span className="truncate">{batchProgress}</span>
                </div>
              ) : (
                <span className="text-sm font-medium text-gray-700">
                  {maxLimitNotice
                    ? 'Max 10 reports'
                    : `${selectedIds.length} selected`}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleToggleSelectMode}
                disabled={isBatchWorking}
                className="glass-btn min-h-[44px] px-4 py-2 text-sm font-medium text-gray-800 hover:bg-white disabled:opacity-50 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDownloadSelectedClick}
                disabled={isBatchWorking || selectedIds.length === 0}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-2xl bg-[#1F3A8A] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#193073] active:bg-[#152861] disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
              >
                {isBatchWorking ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="h-4 w-4" aria-hidden="true" />
                )}
                <span>
                  {isBatchWorking
                    ? batchProgress
                    : `Download (${selectedIds.length})`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Download Format Choice Pop-up */}
      {ENABLE_BATCH && ENABLE_FORMAT_CHOICE && formatModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="download-format-title"
          onClick={() => setFormatModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.5)]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="glass-format-panel w-[92vw] max-w-[420px] p-[24px]"
          >
            <h2
              id="download-format-title"
              className="text-[18px] font-semibold leading-snug text-[#0F172A]"
            >
              Download format
            </h2>
            <p className="mt-1 text-[14px] text-[#475569]">
              {selectedIds.length}{' '}
              {selectedIds.length === 1 ? 'report' : 'reports'} selected
            </p>

            <div
              role="radiogroup"
              aria-labelledby="download-format-title"
              className="mt-5 flex flex-col gap-[10px]"
            >
              {FORMAT_OPTIONS.map((option) => {
                const isSelected = selectedFormat === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedFormat(option.value)}
                    className={`flex h-[56px] w-full items-center gap-3 rounded-[14px] border-[1.5px] px-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[#1F3A8A] ${
                      isSelected
                        ? 'border-[#1F3A8A] bg-[rgba(31,58,138,0.10)]'
                        : 'border-[rgba(15,23,42,0.12)] bg-[rgba(255,255,255,0.75)] hover:bg-[rgba(255,255,255,0.9)]'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors ${
                        isSelected
                          ? 'border-[#1F3A8A] bg-white'
                          : 'border-[rgba(15,23,42,0.28)] bg-white/80'
                      }`}
                    >
                      {isSelected && (
                        <span className="h-2.5 w-2.5 rounded-full bg-[#1F3A8A]" />
                      )}
                    </span>
                    <span className="text-[16px] font-medium text-[#0F172A]">
                      {option.label}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                data-format-cancel="true"
                onClick={() => setFormatModalOpen(false)}
                className="flex h-[48px] items-center justify-center rounded-[14px] border border-[rgba(15,23,42,0.12)] bg-[rgba(255,255,255,0.75)] text-[15px] font-semibold text-[#0F172A] transition-colors hover:bg-[rgba(255,255,255,0.9)] active:bg-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmFormatModal}
                className="flex h-[48px] items-center justify-center rounded-[14px] bg-[#1F3A8A] text-[15px] font-semibold text-white transition-colors hover:bg-[#193073] active:bg-[#152861]"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
