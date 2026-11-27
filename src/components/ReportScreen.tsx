import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Save,
} from 'lucide-react';
import {
  DISABLE_FIELD_MEMORY,
  ENABLE_NEW_LIST,
  ENABLE_PER_TIME_ZERO,
  apiBuildReport,
  apiGetReport,
  apiSaveResults,
  getForgetfulFieldId,
  getForgetfulInputAttrs,
} from '../api';
import type {
  AppMeta,
  BlockMeta,
  LabRowReading,
  LabTableData,
  PhotoItem,
  ReportSuggest,
  SavedResults,
} from '../types';
import { base64ToBlob, downloadBlob } from '../utils/imageProcessing';
import { PhotoThumbnailQueue } from '../utils/photoQueue';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBanner } from './ErrorBanner';
import { LabTable, parseLabNumber } from './LabTable';
import {
  PerTimeZeroLabTable,
  isPerTimeZeroBlock,
} from './PerTimeZeroLabTable';
import { PhotoSlotArea } from './PhotoSlotArea';

interface ReportScreenProps {
  session: string;
  meta: AppMeta;
  reportNo: string;
  onBack: () => void;
}

type ProtocolCard =
  | {
      kind: 'single';
      blockKey: string;
      block: BlockMeta;
    }
  | {
      kind: 'shared-slot';
      slot: string;
      visKey: string;
      xrKey: string;
      title: string;
    };

function deriveSharedTitle(visLabel: string, xrLabel: string): string {
  const clean = (s: string) =>
    s
      .replace(/\s*\((?:visual|x-?rite)\)\s*$/i, '')
      .replace(/\s*[-–—:]\s*(?:visual|x-?rite)\s*$/i, '')
      .replace(/\s+(?:visual|x-?rite)\s*$/i, '')
      .trim();

  const a = clean(visLabel);
  const b = clean(xrLabel);
  if (a && a.toLowerCase() === b.toLowerCase()) return a;
  if (a) return a;
  return b || visLabel || xrLabel;
}

function buildProtocolCards(meta: AppMeta): ProtocolCard[] {
  const slotToKeys = new Map<string, string[]>();
  for (const key of meta.order) {
    const block = meta.blocks[key];
    if (!block || block.always || !block.slot) continue;
    const list = slotToKeys.get(block.slot) ?? [];
    list.push(key);
    slotToKeys.set(block.slot, list);
  }

  const cards: ProtocolCard[] = [];
  const consumed = new Set<string>();

  for (const key of meta.order) {
    if (consumed.has(key)) continue;
    const block = meta.blocks[key];
    if (!block) continue;

    if (!block.always && block.slot) {
      const group = slotToKeys.get(block.slot) ?? [];
      if (group.length > 1) {
        const visKey =
          group.find((k) => k.endsWith('_VIS')) ??
          group.find((k) => !meta.blocks[k]?.table) ??
          group[0];
        const xrKey =
          group.find((k) => k.endsWith('_XR')) ??
          group.find((k) => k !== visKey) ??
          group[1];

        for (const k of group) consumed.add(k);

        cards.push({
          kind: 'shared-slot',
          slot: block.slot,
          visKey,
          xrKey,
          title: deriveSharedTitle(
            meta.blocks[visKey]?.label ?? visKey,
            meta.blocks[xrKey]?.label ?? xrKey
          ),
        });
        continue;
      }
    }

    consumed.add(key);
    cards.push({
      kind: 'single',
      blockKey: key,
      block,
    });
  }

  return cards;
}

function getHoursFieldKeyForBlock(block: BlockMeta): 'HEAT_HRS' | 'YEL_HRS' {
  const fields = Array.isArray(block.fields) ? block.fields : [];
  const hasHeatField = fields.some(([k]) => k === 'HEAT_HRS');
  if (hasHeatField || block.slot === 'HEAT') return 'HEAT_HRS';
  return 'YEL_HRS';
}

function parseHoursValue(raw: string | number | undefined): number {
  if (raw == null) return 0;
  const match = String(raw).match(/\d+(?:[.,]\d+)?/);
  if (!match) return 0;
  const num = parseLabNumber(match[0]);
  return num !== null && num > 0 ? num : 0;
}

function generateDefaultTimes(
  block: BlockMeta,
  values: Record<string, string>
): number[] {
  if (block.table?.times && block.table.times.length > 0) {
    return [...block.table.times];
  }
  const hrsKey = getHoursFieldKeyForBlock(block);
  const totalHrs = parseHoursValue(values[hrsKey]);
  if (totalHrs <= 0) return [];
  const list: number[] = [];
  for (let h = 24; h <= totalHrs; h += 24) {
    list.push(h);
  }
  if (list.length === 0) {
    list.push(totalHrs);
  }
  return list;
}

function createEmptyLabTable(
  times: number[],
  perTimeZero = false
): LabTableData {
  return {
    times: [...times],
    base: { L: '', a: '', b: '' },
    rows: times.map(() =>
      perTimeZero
        ? { L: '', a: '', b: '', base: { L: '', a: '', b: '' } }
        : { L: '', a: '', b: '' }
    ),
  };
}

function normalizeLabTable(
  saved: LabTableData | undefined,
  fallbackTimes: number[],
  perTimeZero = false
): LabTableData {
  if (!saved || !Array.isArray(saved.times)) {
    return createEmptyLabTable(fallbackTimes, perTimeZero);
  }
  const times = saved.times
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0);
  const base = {
    L: saved.base?.L != null ? String(saved.base.L) : '',
    a: saved.base?.a != null ? String(saved.base.a) : '',
    b: saved.base?.b != null ? String(saved.base.b) : '',
  };
  const rows: LabRowReading[] = times.map((_, idx) => {
    const r = saved.rows?.[idx];
    const baseFields = {
      L: r?.L != null ? String(r.L) : '',
      a: r?.a != null ? String(r.a) : '',
      b: r?.b != null ? String(r.b) : '',
    };
    if (!perTimeZero) {
      return baseFields;
    }
    const savedRowBase =
      r && r.base && typeof r.base === 'object'
        ? {
            L: r.base.L != null ? String(r.base.L) : '',
            a: r.base.a != null ? String(r.base.a) : '',
            b: r.base.b != null ? String(r.base.b) : '',
          }
        : { L: base.L, a: base.a, b: base.b };
    return {
      ...baseFields,
      base: savedRowBase,
    };
  });
  const effectiveBase =
    perTimeZero && rows[0]?.base ? { ...rows[0].base } : base;
  return { times, base: effectiveBase, rows };
}

function isTableEmpty(table: LabTableData | undefined): boolean {
  if (!table) return true;
  if (table.base.L || table.base.a || table.base.b) return false;
  return table.rows.every(
    (r) =>
      !r.L && !r.a && !r.b && !r.base?.L && !r.base?.a && !r.base?.b
  );
}

function formatCurrentTime(): string {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ReportScreen({
  session,
  meta,
  reportNo,
  onBack,
}: ReportScreenProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [general, setGeneral] = useState<Record<string, unknown>>({});
  const [suggest, setSuggest] = useState<ReportSuggest>({});

  // Editable report state
  const [size, setSize] = useState('');
  const [enabledBlocks, setEnabledBlocks] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [tables, setTables] = useState<Record<string, LabTableData>>({});
  const [customTimedTables, setCustomTimedTables] = useState<Set<string>>(
    new Set()
  );

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Photos grouped as flat array, filtered by slot
  const [photos, setPhotos] = useState<PhotoItem[]>([]);

  // Save & build states
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTime, setSavedTime] = useState<string | null>(null);
  const [savedSinceChange, setSavedSinceChange] = useState(false);
  const [downloadPhase, setDownloadPhase] = useState<
    null | 'saving' | 'preparing'
  >(null);
  const [confirmBackOpen, setConfirmBackOpen] = useState(false);

  const photoQueueRef = useRef<PhotoThumbnailQueue>(new PhotoThumbnailQueue());

  const protocolCards = useMemo(() => buildProtocolCards(meta), [meta]);
  const hasUploadingPhotos = useMemo(
    () => photos.some((p) => p.uploading),
    [photos]
  );

  // Clear thumbnail queue on reportNo change or unmount
  useEffect(() => {
    const queue = photoQueueRef.current;
    return () => {
      queue.clear();
    };
  }, [reportNo]);

  // Fetch report data
  useEffect(() => {
    let cancelled = false;
    photoQueueRef.current.clear();
    setLoading(true);
    setError(null);
    setIsDirty(false);
    setSavedTime(null);
    setSavedSinceChange(false);
    setCustomTimedTables(new Set());
    if (DISABLE_FIELD_MEMORY) {
      setGeneral({});
      setSuggest({});
      setSize('');
      setEnabledBlocks(new Set());
      setValues({});
      setTables({});
      setPhotos([]);
    }

    apiGetReport(sessionRef.current, reportNo)
      .then((res) => {
        if (cancelled) return;

        const nextGeneral =
          res.general && typeof res.general === 'object' ? res.general : {};
        const nextSuggest: ReportSuggest = res.suggest ?? {};
        const savedResults = res.results ?? null;

        setGeneral(nextGeneral);
        setSuggest(nextSuggest);

        // Size (cm)
        setSize(savedResults?.size != null ? String(savedResults.size) : '');

        // Enabled blocks: results.blocks if results is saved, otherwise suggest.blocks
        const sourceBlocks =
          savedResults && Array.isArray(savedResults.blocks)
            ? savedResults.blocks
            : Array.isArray(nextSuggest.blocks)
              ? nextSuggest.blocks
              : [];

        const nextEnabled = new Set<string>(sourceBlocks);
        // Always include blocks with always: true
        for (const key of meta.order) {
          if (meta.blocks[key]?.always) {
            nextEnabled.add(key);
          }
        }
        // Ensure at most one active block per shared slot
        for (const card of protocolCards) {
          if (card.kind === 'shared-slot') {
            if (nextEnabled.has(card.visKey) && nextEnabled.has(card.xrKey)) {
              if (nextSuggest.xrite) {
                nextEnabled.delete(card.visKey);
              } else {
                nextEnabled.delete(card.xrKey);
              }
            }
          }
        }
        setEnabledBlocks(nextEnabled);

        // Field values: start from saved results, then pre-fill empty hours from suggest
        const nextValues: Record<string, string> = {};
        if (savedResults?.values) {
          for (const [k, v] of Object.entries(savedResults.values)) {
            nextValues[k] = v != null ? String(v) : '';
          }
        }
        if (
          !nextValues.YEL_HRS &&
          nextSuggest.yelHrs != null &&
          String(nextSuggest.yelHrs).trim() !== ''
        ) {
          nextValues.YEL_HRS = String(nextSuggest.yelHrs);
        }
        if (
          !nextValues.WATER_HRS &&
          nextSuggest.waterHrs != null &&
          String(nextSuggest.waterHrs).trim() !== ''
        ) {
          nextValues.WATER_HRS = String(nextSuggest.waterHrs);
        }
        if (
          !nextValues.HEAT_HRS &&
          nextSuggest.heatHrs != null &&
          String(nextSuggest.heatHrs).trim() !== ''
        ) {
          nextValues.HEAT_HRS = String(nextSuggest.heatHrs);
        }
        setValues(nextValues);

        // Tables initialization
        const nextTables: Record<string, LabTableData> = {};
        const nextCustom = new Set<string>();
        for (const key of meta.order) {
          const block = meta.blocks[key];
          if (!block?.table) continue;
          const savedTable = savedResults?.tables?.[key];
          const defaultTimes = generateDefaultTimes(block, nextValues);
          const usePerTimeZero = ENABLE_PER_TIME_ZERO && isPerTimeZeroBlock(key);
          nextTables[key] = normalizeLabTable(
            savedTable,
            defaultTimes,
            usePerTimeZero
          );
          if (savedTable && Array.isArray(savedTable.times)) {
            nextCustom.add(key);
          }
        }
        setTables(nextTables);
        setCustomTimedTables(nextCustom);

        // Photos
        const incomingPhotos = Array.isArray(res.photos) ? res.photos : [];
        const sortedPhotos = [...incomingPhotos].sort(
          (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)
        );
        setPhotos(sortedPhotos);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load report.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reportNo, meta, protocolCards]);

  // Warn before leaving page when there are unsaved changes or active uploads/builds
  useEffect(() => {
    if (!isDirty && !downloadPhase && !hasUploadingPhotos) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty, downloadPhase, hasUploadingPhotos]);

  const handleFieldChange = useCallback(
    (fieldKey: string, val: string) => {
      setValues((prev) => {
        const nextValues = { ...prev, [fieldKey]: val };

        // If YEL_HRS or HEAT_HRS changed, sync default times on untouched empty tables
        if (fieldKey === 'YEL_HRS' || fieldKey === 'HEAT_HRS') {
          setTables((prevTables) => {
            let changed = false;
            const nextTables = { ...prevTables };
            for (const key of meta.order) {
              const block = meta.blocks[key];
              if (!block?.table || block.table.times?.length) continue;
              if (getHoursFieldKeyForBlock(block) !== fieldKey) continue;
              if (customTimedTables.has(key)) continue;
              if (!isTableEmpty(prevTables[key])) continue;

              const newTimes = generateDefaultTimes(block, nextValues);
              nextTables[key] = createEmptyLabTable(
                newTimes,
                ENABLE_PER_TIME_ZERO && isPerTimeZeroBlock(key)
              );
              changed = true;
            }
            return changed ? nextTables : prevTables;
          });
        }

        return nextValues;
      });
      setIsDirty(true);
    },
    [meta, customTimedTables]
  );

  const handleTableChange = useCallback(
    (blockKey: string, nextTable: LabTableData) => {
      setTables((prev) => {
        const old = prev[blockKey];
        if (
          old &&
          (old.times.length !== nextTable.times.length ||
            old.times.some((t, i) => t !== nextTable.times[i]))
        ) {
          setCustomTimedTables((prevCustom) => {
            const copy = new Set(prevCustom);
            copy.add(blockKey);
            return copy;
          });
        }
        return { ...prev, [blockKey]: nextTable };
      });
      setIsDirty(true);
    },
    []
  );

  function handleToggleSingleBlock(blockKey: string, nextOn: boolean) {
    setEnabledBlocks((prev) => {
      const next = new Set(prev);
      if (nextOn) {
        next.add(blockKey);
      } else {
        next.delete(blockKey);
      }
      return next;
    });
    if (nextOn && meta.blocks[blockKey]?.table && !tables[blockKey]) {
      const defaultTimes = generateDefaultTimes(meta.blocks[blockKey], values);
      setTables((prev) => ({
        ...prev,
        [blockKey]: createEmptyLabTable(
          defaultTimes,
          ENABLE_PER_TIME_ZERO && isPerTimeZeroBlock(blockKey)
        ),
      }));
    }
    setIsDirty(true);
  }

  function handleSharedSlotMode(
    visKey: string,
    xrKey: string,
    mode: 'off' | 'visual' | 'xrite'
  ) {
    setEnabledBlocks((prev) => {
      const next = new Set(prev);
      next.delete(visKey);
      next.delete(xrKey);
      if (mode === 'visual') next.add(visKey);
      if (mode === 'xrite') next.add(xrKey);
      return next;
    });
    if (mode === 'xrite' && meta.blocks[xrKey]?.table && !tables[xrKey]) {
      const defaultTimes = generateDefaultTimes(meta.blocks[xrKey], values);
      setTables((prev) => ({
        ...prev,
        [xrKey]: createEmptyLabTable(
          defaultTimes,
          ENABLE_PER_TIME_ZERO && isPerTimeZeroBlock(xrKey)
        ),
      }));
    }
    setIsDirty(true);
  }

  const handleUpdateSlotPhotos = useCallback(
    (slot: string, updater: (prevSlotPhotos: PhotoItem[]) => PhotoItem[]) => {
      setSavedSinceChange(false);
      setPhotos((prevAll) => {
        const currentSlotPhotos = prevAll.filter((p) => p.slot === slot);
        const others = prevAll.filter((p) => p.slot !== slot);
        const nextSlotPhotos = updater(currentSlotPhotos);
        return [...others, ...nextSlotPhotos];
      });
    },
    []
  );

  function buildResultsPayload(): SavedResults {
    const orderedBlocks = meta.order.filter(
      (key) => meta.blocks[key]?.always || enabledBlocks.has(key)
    );

    const outTables: Record<string, LabTableData> = {};
    for (const key of orderedBlocks) {
      const block = meta.blocks[key];
      if (!block?.table) continue;
      const usePerTimeZero = ENABLE_PER_TIME_ZERO && isPerTimeZeroBlock(key);
      const t =
        tables[key] ??
        createEmptyLabTable(generateDefaultTimes(block, values), usePerTimeZero);
      if (usePerTimeZero) {
        const outRows = t.times.map((_, idx) => {
          const r = t.rows[idx];
          const rowBase = r?.base
            ? {
                L: r.base.L ?? '',
                a: r.base.a ?? '',
                b: r.base.b ?? '',
              }
            : { L: '', a: '', b: '' };
          return {
            L: r?.L ?? '',
            a: r?.a ?? '',
            b: r?.b ?? '',
            base: rowBase,
          };
        });
        const firstBase = outRows[0]?.base
          ? { ...outRows[0].base }
          : { L: t.base.L, a: t.base.a, b: t.base.b };
        outTables[key] = {
          times: [...t.times],
          base: firstBase,
          rows: outRows,
        };
      } else {
        outTables[key] = {
          times: [...t.times],
          base: { L: t.base.L, a: t.base.a, b: t.base.b },
          rows: t.times.map((_, idx) => ({
            L: t.rows[idx]?.L ?? '',
            a: t.rows[idx]?.a ?? '',
            b: t.rows[idx]?.b ?? '',
          })),
        };
      }
    }

    return {
      size,
      blocks: orderedBlocks,
      values: { ...values },
      tables: outTables,
    };
  }

  async function performSave(): Promise<boolean> {
    if (saving || downloadPhase !== null) return false;
    setSaving(true);
    setError(null);
    try {
      const payload = buildResultsPayload();
      await apiSaveResults(sessionRef.current, reportNo, payload);
      setIsDirty(false);
      setSavedTime(formatCurrentTime());
      setSavedSinceChange(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save results.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleDownloadWord() {
    if (downloadPhase !== null || saving || loading) return;
    setError(null);

    try {
      // Silently save first when user taps Download without tapping Save first
      if (isDirty || !savedSinceChange) {
        setDownloadPhase('saving');
        try {
          const payload = buildResultsPayload();
          await apiSaveResults(sessionRef.current, reportNo, payload);
          setIsDirty(false);
          setSavedTime(formatCurrentTime());
          setSavedSinceChange(true);
        } catch {
          setError('Save failed, please try again');
          return;
        }
      }

      setDownloadPhase('preparing');
      const res = await apiBuildReport(sessionRef.current, reportNo, 'docx');
      if (!res.data) {
        throw new Error('Server did not return report file data.');
      }
      const mime =
        res.mime ||
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const fileName = res.fileName || `${reportNo}.docx`;
      const blob = base64ToBlob(res.data, mime);
      downloadBlob(blob, fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build report.');
    } finally {
      setDownloadPhase(null);
    }
  }

  function handleBackClick() {
    if (isDirty) {
      setConfirmBackOpen(true);
      return;
    }
    onBack();
  }

  const isBusy = saving || downloadPhase !== null;
  const generalEntries = Object.entries(general);
  const warnings = Array.isArray(suggest.warnings)
    ? suggest.warnings.filter((w) => w && String(w).trim() !== '')
    : [];

  function getSlotPhotos(slot: string): PhotoItem[] {
    return photos
      .filter((p) => p.slot === slot)
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  }

  function renderBlockBody(blockKey: string, block: BlockMeta) {
    const fields = Array.isArray(block.fields) ? block.fields : [];
    return (
      <div className="mt-4 space-y-4">
        {fields.length > 0 && (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {fields.map(([fieldKey, label]) => {
              const rawKey = `${blockKey}_${fieldKey}`;
              const fallbackId = `field-${blockKey}-${fieldKey}`;
              return (
                <div key={fieldKey} className="flex flex-col gap-1.5">
                  <label
                    htmlFor={getForgetfulFieldId(rawKey, fallbackId)}
                    className="px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b]"
                  >
                    {label}
                  </label>
                  <input
                    {...getForgetfulInputAttrs(rawKey, fallbackId)}
                    type="text"
                    value={values[fieldKey] ?? ''}
                    onChange={(e) => handleFieldChange(fieldKey, e.target.value)}
                    placeholder={`Enter ${label.toLowerCase()}`}
                    className="glass-input h-10 w-full px-3.5 text-[16px] sm:text-[13px] placeholder:text-[#86868b]"
                  />
                </div>
              );
            })}
          </div>
        )}

        {block.table &&
          (ENABLE_PER_TIME_ZERO && isPerTimeZeroBlock(blockKey) ? (
            <PerTimeZeroLabTable
              blockKey={blockKey}
              tableMeta={block.table}
              data={
                tables[blockKey] ??
                createEmptyLabTable(generateDefaultTimes(block, values), true)
              }
              onChange={(next) => handleTableChange(blockKey, next)}
            />
          ) : (
            <LabTable
              blockKey={blockKey}
              tableMeta={block.table}
              data={
                tables[blockKey] ??
                createEmptyLabTable(generateDefaultTimes(block, values))
              }
              onChange={(next) => handleTableChange(blockKey, next)}
            />
          ))}

        {block.slot && (
          <PhotoSlotArea
            session={session}
            reportNo={reportNo}
            slot={block.slot}
            photos={getSlotPhotos(block.slot)}
            photoQueue={photoQueueRef.current}
            onUpdateSlotPhotos={handleUpdateSlotPhotos}
            onError={(msg) => setError(msg)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col pb-12">
      {/* Top Sticky Liquid Glass Nav */}
      <header
        className={
          ENABLE_NEW_LIST
            ? 'glass-nav mx-auto w-[calc(100%-2rem)] sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)] max-w-[1376px] mt-3 px-4 sm:px-6 py-3'
            : 'sticky top-0 z-30 bg-[#00227A] text-white shadow-sm'
        }
      >
        <div
          className={
            ENABLE_NEW_LIST
              ? 'flex flex-wrap items-center justify-between gap-2.5'
              : 'mx-auto flex h-14 max-w-4xl items-center justify-between gap-2 px-3 sm:px-4'
          }
        >
          {/* Left: Back + Report number */}
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={handleBackClick}
              className={
                ENABLE_NEW_LIST
                  ? 'glass-pill inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] font-medium shrink-0 whitespace-nowrap'
                  : 'flex min-h-[40px] items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-medium text-white hover:bg-white/15 shrink-0 whitespace-nowrap'
              }
            >
              <ArrowLeft
                className={`h-3.5 w-3.5 ${ENABLE_NEW_LIST ? 'text-[#525257]' : ''}`}
                aria-hidden="true"
              />
              <span>Back</span>
            </button>

            <h1
              className={`truncate text-[16px] sm:text-[17px] font-semibold tracking-[-0.01em] font-mono-num ${
                ENABLE_NEW_LIST ? 'text-[#1d1d1f]' : 'text-white'
              }`}
            >
              {reportNo}
            </h1>
          </div>

          {/* Right: Save + Word Download button */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void performSave()}
              disabled={loading || isBusy}
              className="glass-btn-primary relative inline-flex h-9 items-center gap-1.5 px-4 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : savedTime && !isDirty ? (
                <Check className="h-3.5 w-3.5 text-[#34c759]" aria-hidden="true" />
              ) : (
                <Save className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {saving
                  ? 'Saving...'
                  : savedTime && !isDirty
                    ? `Saved ${savedTime}`
                    : 'Save'}
              </span>
              {isDirty && (
                <span
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                  className="ml-0.5 inline-block h-2 w-2 rounded-full bg-[#ff9500] ring-2 ring-white"
                />
              )}
            </button>

            <button
              type="button"
              onClick={() => void handleDownloadWord()}
              disabled={loading || isBusy || hasUploadingPhotos}
              className="glass-btn-secondary inline-flex h-9 items-center gap-1.5 px-4 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              {downloadPhase ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin text-[#00227A]"
                  aria-hidden="true"
                />
              ) : (
                <Download className="h-3.5 w-3.5 text-[#525257]" aria-hidden="true" />
              )}
              <span>
                {downloadPhase === 'saving'
                  ? 'Saving...'
                  : downloadPhase === 'preparing'
                    ? 'Preparing file...'
                    : 'Download'}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1040px] flex-1 space-y-6 px-4 sm:px-6 pt-6">
        {/* Building report status banner */}
        {downloadPhase === 'preparing' && (
          <div
            role="status"
            className="glass-panel flex items-center gap-3 px-4 py-3.5 text-[13px] font-medium text-[#1d1d1f]"
          >
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-[#00227A]"
              aria-hidden="true"
            />
            <span>Building report... this can take 10 to 40 seconds</span>
          </div>
        )}

        {/* Red error banner */}
        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        )}

        {loading ? (
          <div className="glass-panel flex min-h-[320px] flex-col items-center justify-center p-10">
            <div
              className="h-8 w-8 animate-spin rounded-full border-2 border-[#00227A]/25 border-t-[#00227A]"
              aria-hidden="true"
            />
            <p className="mt-4 text-[15px] font-semibold text-[#1d1d1f]">
              Loading report {reportNo}...
            </p>
          </div>
        ) : (
          <>
            {/* SECTION A: General information */}
            <section aria-labelledby="section-general" className="glass-panel p-5 sm:p-6">
              <h2
                id="section-general"
                className="mb-4 text-[15px] font-semibold tracking-[-0.01em] text-[#1d1d1f]"
              >
                General information
              </h2>

              {generalEntries.length === 0 ? (
                <div className="glass-inset px-4 py-6 text-center text-[13px] text-[#86868b]">
                  No general information available.
                </div>
              ) : (
                <div className="glass-table-wrap overflow-hidden">
                  <dl className="grid grid-cols-1 divide-y divide-black/[0.06] sm:grid-cols-2 sm:divide-y-0">
                    {generalEntries.map(([key, val]) => (
                      <div
                        key={key}
                        className="px-4 py-3 sm:border-b sm:border-black/[0.06]"
                      >
                        <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b]">
                          {key}
                        </dt>
                        <dd className="mt-0.5 text-[13px] font-medium text-[#1d1d1f] break-words">
                          {val == null || String(val).trim() === ''
                            ? '—'
                            : String(val)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              <div className="mt-5 grid grid-cols-1 gap-4 border-t border-black/[0.06] pt-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={getForgetfulFieldId('size', 'report-size')}
                    className="px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b]"
                  >
                    Size (cm)
                  </label>
                  <input
                    {...getForgetfulInputAttrs('size', 'report-size')}
                    type="text"
                    value={size}
                    onChange={(e) => {
                      setSize(e.target.value);
                      setIsDirty(true);
                    }}
                    placeholder="Enter panel size in cm"
                    className="glass-input h-10 w-full px-3.5 text-[16px] sm:text-[13px] placeholder:text-[#86868b]"
                  />
                </div>
              </div>
            </section>

            {/* SECTION B: Finishing system sheet */}
            <section aria-labelledby="section-system" className="glass-panel p-5 sm:p-6">
              <h2
                id="section-system"
                className="mb-4 text-[15px] font-semibold tracking-[-0.01em] text-[#1d1d1f]"
              >
                Finishing system sheet
              </h2>

              <div className="[&>div]:border-t-0 [&>div]:pt-0">
                <PhotoSlotArea
                  session={session}
                  reportNo={reportNo}
                  slot="SYSTEM"
                  photos={getSlotPhotos('SYSTEM')}
                  photoQueue={photoQueueRef.current}
                  onUpdateSlotPhotos={handleUpdateSlotPhotos}
                  onError={(msg) => setError(msg)}
                />
              </div>
              <p className="mt-3 text-[12px] text-[#86868b]">
                Each photo is printed as one full page in the report. The order here is the page order.
              </p>
            </section>

            {/* SECTION C: Testing protocol */}
            <section aria-labelledby="section-protocol" className="space-y-4">
              <h2
                id="section-protocol"
                className="px-1 text-[15px] font-semibold tracking-[-0.01em] text-[#1d1d1f]"
              >
                Testing protocol
              </h2>

              {/* Suggest warnings banner */}
              {warnings.length > 0 && (
                <div
                  role="status"
                  className="rounded-[14px] border border-[#ff9500]/30 bg-[#ff9500]/[0.1] px-4 py-3 text-[13px] text-[#1d1d1f]"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#ff9500]"
                      aria-hidden="true"
                    />
                    <div className="space-y-1">
                      {warnings.map((w, idx) => (
                        <p key={idx} className="leading-relaxed">
                          {w}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {protocolCards.map((card) => {
                  if (card.kind === 'shared-slot') {
                    const mode: 'off' | 'visual' | 'xrite' = enabledBlocks.has(
                      card.xrKey
                    )
                      ? 'xrite'
                      : enabledBlocks.has(card.visKey)
                        ? 'visual'
                        : 'off';

                    const activeKey =
                      mode === 'xrite'
                        ? card.xrKey
                        : mode === 'visual'
                          ? card.visKey
                          : null;
                    const activeBlock = activeKey ? meta.blocks[activeKey] : null;

                    return (
                      <div
                        key={`slot-${card.slot}`}
                        className="glass-panel p-5 sm:p-6"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#1d1d1f]">
                            {activeBlock ? activeBlock.label : card.title}
                          </h3>

                          {/* 3-way selector: Off / Visual / X-rite */}
                          <div
                            role="radiogroup"
                            aria-label={`${card.title} mode`}
                            className="flex flex-wrap items-center gap-1.5"
                          >
                            {(
                              [
                                ['off', 'Off'],
                                ['visual', 'Visual'],
                                ['xrite', 'X-rite'],
                              ] as const
                            ).map(([value, label]) => {
                              const selected = mode === value;
                              return (
                                <button
                                  key={value}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  onClick={() =>
                                    handleSharedSlotMode(
                                      card.visKey,
                                      card.xrKey,
                                      value
                                    )
                                  }
                                  className={`${
                                    selected
                                      ? value === 'off'
                                        ? 'rounded-full bg-white/90 border border-black/[0.12] text-[#1d1d1f] font-semibold shadow-xs transition-colors'
                                        : 'glass-pill-active'
                                      : 'glass-pill'
                                  } px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap shrink-0`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {activeKey && activeBlock && renderBlockBody(activeKey, activeBlock)}
                      </div>
                    );
                  }

                  // Single block card
                  const { blockKey, block } = card;
                  const isAlways = block.always === true;
                  const isOn = isAlways || enabledBlocks.has(blockKey);

                  return (
                    <div
                      key={blockKey}
                      className="glass-panel p-5 sm:p-6"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#1d1d1f]">
                          {block.label}
                        </h3>

                        {isAlways ? (
                          <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b] whitespace-nowrap">
                            Always included
                          </span>
                        ) : (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isOn}
                            aria-label={`Toggle ${block.label}`}
                            onClick={() => handleToggleSingleBlock(blockKey, !isOn)}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00227A] ${
                              isOn ? 'bg-[#00227A]' : 'bg-black/15'
                            }`}
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                                isOn ? 'translate-x-[22px]' : 'translate-x-[2px]'
                              }`}
                            />
                          </button>
                        )}
                      </div>

                      {isOn && renderBlockBody(blockKey, block)}
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>

      {/* Unsaved changes dialog when pressing Back */}
      <ConfirmDialog
        open={confirmBackOpen}
        title="Unsaved changes"
        message="You have unsaved changes in this report. Would you like to save before leaving?"
        confirmLabel="Save & leave"
        secondaryLabel="Discard"
        onConfirm={async () => {
          setConfirmBackOpen(false);
          const ok = await performSave();
          if (ok) onBack();
        }}
        onSecondary={() => {
          setConfirmBackOpen(false);
          onBack();
        }}
        onCancel={() => setConfirmBackOpen(false)}
      />
    </div>
  );
}
