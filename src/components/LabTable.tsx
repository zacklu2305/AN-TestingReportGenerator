import { useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { ENABLE_QUV_ABS_DELTA, getForgetfulInputAttrs } from '../api';
import type { BlockTableMeta, LabReading, LabTableData } from '../types';

interface LabTableProps {
  blockKey?: string;
  tableMeta: BlockTableMeta;
  data: LabTableData;
  onChange: (next: LabTableData) => void;
}

export function parseLabNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const normalized = value.trim().replace(',', '.');
  if (
    normalized === '' ||
    normalized === '-' ||
    normalized === '+' ||
    normalized === '.' ||
    normalized === '-.' ||
    normalized === '+.'
  ) {
    return null;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
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

export function LabTable({ blockKey, tableMeta, data, onChange }: LabTableProps) {
  const [newHourInput, setNewHourInput] = useState('');
  const tableKeyPrefix = blockKey ? `tbl_${blockKey}` : 'tbl';
  const formatDelta =
    ENABLE_QUV_ABS_DELTA && blockKey === 'QUV100'
      ? (val: number) => Math.abs(val).toFixed(2)
      : formatSigned;

  const rows: LabReading[] = data.times.map(
    (_, idx) => data.rows[idx] ?? { L: '', a: '', b: '' }
  );

  function handleBaseChange(channel: keyof LabReading, val: string) {
    onChange({
      ...data,
      base: {
        ...data.base,
        [channel]: val,
      },
      rows,
    });
  }

  function handleRowChange(index: number, channel: keyof LabReading, val: string) {
    const nextRows = rows.map((row, i) =>
      i === index ? { ...row, [channel]: val } : row
    );
    onChange({
      ...data,
      rows: nextRows,
    });
  }

  function handleRemoveHour(index: number) {
    const nextTimes = data.times.filter((_, i) => i !== index);
    const nextRows = rows.filter((_, i) => i !== index);
    onChange({
      ...data,
      times: nextTimes,
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
      row: rows[idx] ?? { L: '', a: '', b: '' },
    }));
    pairs.push({ time: parsed, row: { L: '', a: '', b: '' } });
    pairs.sort((a, b) => a.time - b.time);

    onChange({
      ...data,
      times: pairs.map((p) => p.time),
      rows: pairs.map((p) => p.row),
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

      {/* Table */}
      <div className="glass-table-wrap overflow-x-auto p-3">
        <div className="min-w-[300px] space-y-2">
          {/* Column header */}
          <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 px-1.5 pb-1 border-b border-black/[0.07] text-[11px] font-medium uppercase tracking-[0.04em] text-[#86868b]">
            <div>Time</div>
            <div>L*</div>
            <div>a*</div>
            <div>b*</div>
            <div className="text-right">DE*</div>
          </div>

          {/* 0hr baseline row */}
          <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 rounded-[12px] bg-white/55 border border-black/[0.06] p-1.5">
            <div className="text-[13px] font-semibold text-[#1d1d1f] font-mono-num">0 hr</div>
            <input
              {...getForgetfulInputAttrs(`${tableKeyPrefix}_base_l`)}
              type="text"
              inputMode="decimal"
              value={data.base.L}
              onChange={(e) => handleBaseChange('L', e.target.value)}
              placeholder="L*"
              aria-label="0 hour L star"
              className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
            />
            <input
              {...getForgetfulInputAttrs(`${tableKeyPrefix}_base_a`)}
              type="text"
              inputMode="decimal"
              value={data.base.a}
              onChange={(e) => handleBaseChange('a', e.target.value)}
              placeholder="a*"
              aria-label="0 hour a star"
              className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
            />
            <input
              {...getForgetfulInputAttrs(`${tableKeyPrefix}_base_b`)}
              type="text"
              inputMode="decimal"
              value={data.base.b}
              onChange={(e) => handleBaseChange('b', e.target.value)}
              placeholder="b*"
              aria-label="0 hour b star"
              className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
            />
            <div className="pr-1 text-right text-[13px] font-medium text-[#86868b] font-mono-num">
              —
            </div>
          </div>

          {/* Hour reading rows */}
          {data.times.length === 0 ? (
            <p className="px-1.5 py-2 text-[12px] text-[#86868b]">
              No hours configured. Add an hour above to enter readings.
            </p>
          ) : (
            data.times.map((hr, idx) => {
              const row = rows[idx];
              const deltas = computeDeltas(data.base, row);

              return (
                <div key={hr} className="space-y-1">
                  <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 px-1.5 py-1">
                    <div className="text-[13px] font-medium text-[#1d1d1f] font-mono-num">
                      {hr} hr
                    </div>
                    <input
                      {...getForgetfulInputAttrs(
                        `${tableKeyPrefix}_hr_${String(hr).replace('.', 'p')}_l`
                      )}
                      type="text"
                      inputMode="decimal"
                      value={row.L}
                      onChange={(e) => handleRowChange(idx, 'L', e.target.value)}
                      placeholder="L*"
                      aria-label={`${hr} hour L star`}
                      className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                    />
                    <input
                      {...getForgetfulInputAttrs(
                        `${tableKeyPrefix}_hr_${String(hr).replace('.', 'p')}_a`
                      )}
                      type="text"
                      inputMode="decimal"
                      value={row.a}
                      onChange={(e) => handleRowChange(idx, 'a', e.target.value)}
                      placeholder="a*"
                      aria-label={`${hr} hour a star`}
                      className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                    />
                    <input
                      {...getForgetfulInputAttrs(
                        `${tableKeyPrefix}_hr_${String(hr).replace('.', 'p')}_b`
                      )}
                      type="text"
                      inputMode="decimal"
                      value={row.b}
                      onChange={(e) => handleRowChange(idx, 'b', e.target.value)}
                      placeholder="b*"
                      aria-label={`${hr} hour b star`}
                      className="glass-input w-full min-w-0 h-10 px-2 text-[16px] sm:text-[13px] font-mono-num placeholder:font-sans placeholder:text-[#86868b]"
                    />
                    <div className="pr-1 text-right text-[13px] font-semibold text-[#1d1d1f] font-mono-num">
                      {deltas ? deltas.de.toFixed(2) : '—'}
                    </div>
                  </div>

                  {tableMeta.quv === true && (
                    <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 rounded-[10px] bg-[#00227A]/[0.06] px-2 py-1.5 text-[12px] text-[#525257] font-mono-num">
                      <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-[#00227A]">
                        Delta
                      </div>
                      <div>
                        <span className="text-[#86868b]">dL </span>
                        <span className="font-medium text-[#1d1d1f]">
                          {deltas ? formatDelta(deltas.dL) : '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#86868b]">da </span>
                        <span className="font-medium text-[#1d1d1f]">
                          {deltas ? formatDelta(deltas.da) : '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#86868b]">db </span>
                        <span className="font-medium text-[#1d1d1f]">
                          {deltas ? formatDelta(deltas.db) : '—'}
                        </span>
                      </div>
                      <div className="pr-0.5 text-right font-semibold text-[#00227A]">
                        {deltas ? deltas.de.toFixed(2) : '—'}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
