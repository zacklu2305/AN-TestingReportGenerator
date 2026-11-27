import { useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { ENABLE_QUV_ABS_DELTA, getForgetfulInputAttrs } from '../api';
import type {
  BlockTableMeta,
  LabReading,
  LabRowReading,
  LabTableData,
} from '../types';
import { parseLabNumber } from './LabTable';

export const PER_TIME_ZERO_BLOCKS = new Set([
  'YEL_UVA_XR',
  'YEL_UVB_XR',
  'QUV100',
]);

export function isPerTimeZeroBlock(blockKey?: string): boolean {
  return Boolean(blockKey && PER_TIME_ZERO_BLOCKS.has(blockKey));
}

interface PerTimeZeroLabTableProps {
  blockKey: string;
  tableMeta: BlockTableMeta;
  data: LabTableData;
  onChange: (next: LabTableData) => void;
}

function emptyReading(): LabReading {
  return { L: '', a: '', b: '' };
}

function computeDeltas(
  base: LabReading,
  reading: LabReading
): { dL: number; da: number; db: number; de: number } | null {
  const bL = parseLabNumber(base.L);
  const ba = parseLabNumber(base.a);
  const bb = parseLabNumber(base.b);
  const rL = parseLabNumber(reading.L);
  const ra = parseLabNumber(reading.a);
  const rb = parseLabNumber(reading.b);

  if (
    bL === null ||
    ba === null ||
    bb === null ||
    rL === null ||
    ra === null ||
    rb === null
  ) {
    return null;
  }

  const dL = rL - bL;
  const da = ra - ba;
  const db = rb - bb;
  const de = Math.sqrt(dL * dL + da * da + db * db);
  return { dL, da, db, de };
}

function formatSigned(val: number): string {
  const fixed = val.toFixed(2);
  if (val > 0 && fixed !== '0.00') return `+${fixed}`;
  return fixed;
}

function formatPositive(val: number): string {
  return Math.abs(val).toFixed(2);
}

export function PerTimeZeroLabTable({
  blockKey,
  tableMeta,
  data,
  onChange,
}: PerTimeZeroLabTableProps) {
  const [newHourInput, setNewHourInput] = useState('');
  const tableKeyPrefix = `tbl_${blockKey}`;
  const useAbsDelta = ENABLE_QUV_ABS_DELTA && blockKey === 'QUV100';
  const formatDelta = useAbsDelta ? formatPositive : formatSigned;

  const rows: LabRowReading[] = data.times.map((_, idx) => {
    const existing = data.rows[idx];
    return {
      L: existing?.L ?? '',
      a: existing?.a ?? '',
      b: existing?.b ?? '',
      base: existing?.base
        ? {
            L: existing.base.L ?? '',
            a: existing.base.a ?? '',
            b: existing.base.b ?? '',
          }
        : emptyReading(),
    };
  });

  function syncFirstBase(nextRows: LabRowReading[]): LabReading {
    const first = nextRows[0]?.base;
    return first
      ? { L: first.L, a: first.a, b: first.b }
      : emptyReading();
  }

  function handleGroupBaseChange(
    index: number,
    channel: keyof LabReading,
    val: string
  ) {
    const nextRows = rows.map((row, i) =>
      i === index
        ? {
            ...row,
            base: {
              ...(row.base ?? emptyReading()),
              [channel]: val,
            },
          }
        : row
    );
    onChange({
      ...data,
      base: syncFirstBase(nextRows),
      rows: nextRows,
    });
  }

  function handleRowChange(
    index: number,
    channel: keyof LabReading,
    val: string
  ) {
    const nextRows = rows.map((row, i) =>
      i === index ? { ...row, [channel]: val } : row
    );
    onChange({
      ...data,
      base: syncFirstBase(nextRows),
      rows: nextRows,
    });
  }

  function handleRemoveHour(index: number) {
    const nextTimes = data.times.filter((_, i) => i !== index);
    const nextRows = rows.filter((_, i) => i !== index);
    onChange({
      ...data,
      times: nextTimes,
      base: syncFirstBase(nextRows),
      rows: nextRows,
    });
  }

  function handleAddHour() {
    const parsed = parseLabNumber(newHourInput);
    if (parsed === null || parsed <= 0) return;
    if (data.times.includes(parsed)) {
      setNewHourInput('');
      return;
    }

    const pairs = data.times.map((t, idx) => ({
      time: t,
      row: rows[idx] ?? { ...emptyReading(), base: emptyReading() },
    }));
    pairs.push({
      time: parsed,
      row: { ...emptyReading(), base: emptyReading() },
    });
    pairs.sort((a, b) => a.time - b.time);

    const nextRows = pairs.map((p) => p.row);
    onChange({
      ...data,
      times: pairs.map((p) => p.time),
      base: syncFirstBase(nextRows),
      rows: nextRows,
    });
    setNewHourInput('');
  }

  function handleAddHourKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddHour();
    }
  }

  return (
    <div className="space-y-3 border-t border-black/[0.06] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[14px] font-semibold text-[#1d1d1f]">
          Color readings (L*, a*, b*)
        </span>
      </div>

      {/* Hours chips row */}
      <div className="flex flex-wrap items-center gap-2">
        {data.times.map((hr, idx) => (
          <span
            key={hr}
            className="glass-pill inline-flex items-center gap-1 pl-3 pr-1.5 py-1 text-[12px] font-medium text-[#1d1d1f] font-mono-num"
          >
            <span>{hr} hr</span>
            <button
              type="button"
              onClick={() => handleRemoveHour(idx)}
              aria-label={`Remove ${hr} hours`}
              className="flex h-6 w-6 items-center justify-center rounded-full text-[#86868b] transition-colors hover:bg-black/[0.06] hover:text-[#1d1d1f]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}

        <div className="flex items-center gap-1.5">
          <input
            {...getForgetfulInputAttrs(`${tableKeyPrefix}_add_hr`)}
            type="text"
            inputMode="decimal"
            value={newHourInput}
            onChange={(e) => setNewHourInput(e.target.value)}
            onKeyDown={handleAddHourKeyDown}
            placeholder="Hr"
            aria-label="Add hour"
            className="glass-input w-20 h-9 px-2.5 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
          />
          <button
            type="button"
            onClick={handleAddHour}
            className="glass-btn-secondary inline-flex h-9 items-center gap-1 px-3.5 text-[13px] font-medium whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5 text-[#525257]" aria-hidden="true" />
            <span>Add</span>
          </button>
        </div>
      </div>

      {/* Table with per-time 0 hr groups */}
      <div className="glass-table-wrap overflow-x-auto p-3">
        <div className="min-w-[300px]">
          {/* Column header */}
          <div className="mb-2 grid grid-cols-[60px_1fr_1fr_1fr_62px] items-center gap-1.5 px-1.5 pb-1 border-b border-black/[0.07] text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b]">
            <div>Time</div>
            <div>L*</div>
            <div>a*</div>
            <div>b*</div>
            <div className="text-right">DE*</div>
          </div>

          {data.times.length === 0 ? (
            <p className="px-1.5 py-2 text-[12px] text-[#86868b]">
              No hours configured. Add an hour above to enter readings.
            </p>
          ) : (
            data.times.map((hr, idx) => {
              const row = rows[idx];
              const rowBase = row.base ?? emptyReading();
              const deltas = computeDeltas(rowBase, row);
              const hrKey = String(hr).replace('.', 'p');

              return (
                <div
                  key={hr}
                  className={
                    idx > 0
                      ? 'mt-2 border-t border-[rgba(0,0,0,0.08)] pt-2'
                      : ''
                  }
                >
                  <div className="space-y-2">
                    {/* Group 0 hr baseline row */}
                    <div className="grid grid-cols-[60px_1fr_1fr_1fr_62px] items-center gap-1.5 rounded-[12px] bg-white/55 border border-black/[0.06] p-1.5">
                      <div className="leading-tight">
                        <div className="text-[13px] font-semibold text-[#1d1d1f] font-mono-num">
                          0 hr
                        </div>
                        <div className="text-[10px] font-normal text-[#86868b] whitespace-nowrap">
                          for {hr} hr
                        </div>
                      </div>
                      <input
                        {...getForgetfulInputAttrs(
                          `${tableKeyPrefix}_hr_${hrKey}_base_l`
                        )}
                        type="text"
                        inputMode="decimal"
                        value={rowBase.L}
                        onChange={(e) =>
                          handleGroupBaseChange(idx, 'L', e.target.value)
                        }
                        placeholder="L*"
                        aria-label={`0 hour for ${hr} hour L star`}
                        className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                      />
                      <input
                        {...getForgetfulInputAttrs(
                          `${tableKeyPrefix}_hr_${hrKey}_base_a`
                        )}
                        type="text"
                        inputMode="decimal"
                        value={rowBase.a}
                        onChange={(e) =>
                          handleGroupBaseChange(idx, 'a', e.target.value)
                        }
                        placeholder="a*"
                        aria-label={`0 hour for ${hr} hour a star`}
                        className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                      />
                      <input
                        {...getForgetfulInputAttrs(
                          `${tableKeyPrefix}_hr_${hrKey}_base_b`
                        )}
                        type="text"
                        inputMode="decimal"
                        value={rowBase.b}
                        onChange={(e) =>
                          handleGroupBaseChange(idx, 'b', e.target.value)
                        }
                        placeholder="b*"
                        aria-label={`0 hour for ${hr} hour b star`}
                        className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                      />
                      <div className="pr-1 text-right text-[13px] font-medium text-[#86868b] font-mono-num">
                        –
                      </div>
                    </div>

                    {/* Group hour reading row (+ QUV100 Delta bar directly underneath) */}
                    <div className="space-y-1">
                      <div className="grid grid-cols-[60px_1fr_1fr_1fr_62px] items-center gap-1.5 px-1.5 py-1">
                        <div className="text-[13px] font-medium text-[#1d1d1f] font-mono-num">
                          {hr} hr
                        </div>
                        <input
                          {...getForgetfulInputAttrs(
                            `${tableKeyPrefix}_hr_${hrKey}_l`
                          )}
                          type="text"
                          inputMode="decimal"
                          value={row.L}
                          onChange={(e) =>
                            handleRowChange(idx, 'L', e.target.value)
                          }
                          placeholder="L*"
                          aria-label={`${hr} hour L star`}
                          className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                        />
                        <input
                          {...getForgetfulInputAttrs(
                            `${tableKeyPrefix}_hr_${hrKey}_a`
                          )}
                          type="text"
                          inputMode="decimal"
                          value={row.a}
                          onChange={(e) =>
                            handleRowChange(idx, 'a', e.target.value)
                          }
                          placeholder="a*"
                          aria-label={`${hr} hour a star`}
                          className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                        />
                        <input
                          {...getForgetfulInputAttrs(
                            `${tableKeyPrefix}_hr_${hrKey}_b`
                          )}
                          type="text"
                          inputMode="decimal"
                          value={row.b}
                          onChange={(e) =>
                            handleRowChange(idx, 'b', e.target.value)
                          }
                          placeholder="b*"
                          aria-label={`${hr} hour b star`}
                          className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                        />
                        <div className="pr-1 text-right text-[13px] font-semibold text-[#1d1d1f] font-mono-num">
                          {deltas ? deltas.de.toFixed(2) : '–'}
                        </div>
                      </div>

                      {tableMeta.quv === true && (
                        <div className="grid grid-cols-[60px_1fr_1fr_1fr_62px] items-center gap-1.5 rounded-[10px] bg-[#00227A]/[0.06] px-2 py-1.5 text-[12px] text-[#525257] font-mono-num">
                          <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-[#00227A]">
                            Delta
                          </div>
                          <div>
                            <span className="text-[#86868b]">dL </span>
                            <span className="font-medium text-[#1d1d1f]">
                              {deltas ? formatDelta(deltas.dL) : '–'}
                            </span>
                          </div>
                          <div>
                            <span className="text-[#86868b]">da </span>
                            <span className="font-medium text-[#1d1d1f]">
                              {deltas ? formatDelta(deltas.da) : '–'}
                            </span>
                          </div>
                          <div>
                            <span className="text-[#86868b]">db </span>
                            <span className="font-medium text-[#1d1d1f]">
                              {deltas ? formatDelta(deltas.db) : '–'}
                            </span>
                          </div>
                          <div className="pr-0.5 text-right font-semibold text-[#00227A]">
                            {deltas ? deltas.de.toFixed(2) : '–'}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
