import { useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { getForgetfulInputAttrs } from '../api';
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
    <div className="space-y-3 border-t border-gray-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-800">
          Color readings (L*, a*, b*)
        </span>
      </div>

      {/* Hours chips row */}
      <div className="flex flex-wrap items-center gap-2">
        {data.times.map((hr, idx) => (
          <span
            key={hr}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-gray-50 pl-2.5 pr-1 py-1 text-sm font-medium text-gray-800 tabular-nums"
          >
            <span>{hr} hr</span>
            <button
              type="button"
              onClick={() => handleRemoveHour(idx)}
              aria-label={`Remove ${hr} hours`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800"
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
            className="w-20 min-h-[38px] rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
          />
          <button
            type="button"
            onClick={handleAddHour}
            className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Add</span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="min-w-[300px] space-y-2">
          {/* Column header */}
          <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 px-1 text-xs font-semibold text-gray-500">
            <div>Time</div>
            <div>L*</div>
            <div>a*</div>
            <div>b*</div>
            <div className="text-right">DE*</div>
          </div>

          {/* 0hr baseline row */}
          <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 rounded-lg bg-gray-50 p-1.5">
            <div className="text-sm font-semibold text-gray-700 tabular-nums">0 hr</div>
            <input
              {...getForgetfulInputAttrs(`${tableKeyPrefix}_base_l`)}
              type="text"
              inputMode="decimal"
              value={data.base.L}
              onChange={(e) => handleBaseChange('L', e.target.value)}
              placeholder="L*"
              aria-label="0 hour L star"
              className="w-full min-w-0 min-h-[42px] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
            />
            <input
              {...getForgetfulInputAttrs(`${tableKeyPrefix}_base_a`)}
              type="text"
              inputMode="decimal"
              value={data.base.a}
              onChange={(e) => handleBaseChange('a', e.target.value)}
              placeholder="a*"
              aria-label="0 hour a star"
              className="w-full min-w-0 min-h-[42px] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
            />
            <input
              {...getForgetfulInputAttrs(`${tableKeyPrefix}_base_b`)}
              type="text"
              inputMode="decimal"
              value={data.base.b}
              onChange={(e) => handleBaseChange('b', e.target.value)}
              placeholder="b*"
              aria-label="0 hour b star"
              className="w-full min-w-0 min-h-[42px] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
            />
            <div className="pr-1 text-right text-sm font-medium text-gray-400 tabular-nums">
              —
            </div>
          </div>

          {/* Hour reading rows */}
          {data.times.length === 0 ? (
            <p className="px-1 py-2 text-xs text-gray-500">
              No hours configured. Add an hour above to enter readings.
            </p>
          ) : (
            data.times.map((hr, idx) => {
              const row = rows[idx];
              const deltas = computeDeltas(data.base, row);

              return (
                <div key={hr} className="space-y-1">
                  <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 px-1.5 py-1">
                    <div className="text-sm font-medium text-gray-800 tabular-nums">
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
                      className="w-full min-w-0 min-h-[42px] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
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
                      className="w-full min-w-0 min-h-[42px] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
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
                      className="w-full min-w-0 min-h-[42px] rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#1F3A8A] focus:outline-none focus:ring-2 focus:ring-[#1F3A8A]/20 tabular-nums"
                    />
                    <div className="pr-1 text-right text-sm font-semibold text-gray-900 tabular-nums">
                      {deltas ? deltas.de.toFixed(2) : '—'}
                    </div>
                  </div>

                  {tableMeta.quv === true && (
                    <div className="grid grid-cols-[54px_1fr_1fr_1fr_62px] items-center gap-1.5 rounded-md bg-blue-50/60 px-2 py-1 text-xs text-gray-600 tabular-nums">
                      <div className="font-medium text-[#1F3A8A]">Delta</div>
                      <div>
                        <span className="text-gray-400">dL </span>
                        <span className="font-medium text-gray-800">
                          {deltas ? formatSigned(deltas.dL) : '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">da </span>
                        <span className="font-medium text-gray-800">
                          {deltas ? formatSigned(deltas.da) : '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">db </span>
                        <span className="font-medium text-gray-800">
                          {deltas ? formatSigned(deltas.db) : '—'}
                        </span>
                      </div>
                      <div className="pr-0.5 text-right font-semibold text-[#1F3A8A]">
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
