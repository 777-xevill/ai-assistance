import { useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cx } from './ui';

// Chart tokens (validated with the dataviz palette script against the white card surface).
export const VIZ = {
  series: '#2a78d6', // single-series accent (categorical slot 1)
  ordinal: ['#86b6ef', '#3987e5', '#256abf', '#184f95'], // ordered stages, light → dark
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
};

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function tickDate(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, days <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }).format(d);
}

interface TooltipPayload {
  value: number;
  payload: Record<string, unknown>;
}

function ChartTooltip({
  active,
  payload,
  label,
  seriesLabel,
  format,
  extra,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  seriesLabel: string;
  format: (v: number) => string;
  extra?: (row: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload?.length || !label) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="mb-1 text-zinc-500">{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${label}T12:00:00`))}</div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-0.5 w-3 rounded" style={{ background: VIZ.series }} />
        <span className="text-sm font-semibold text-zinc-900">{format(payload[0].value)}</span>
        <span className="text-zinc-500">{seriesLabel}</span>
      </div>
      {extra?.(row)}
    </div>
  );
}

/**
 * One series over time: 2px line with a 10% wash, hairline grid, crosshair tooltip,
 * and a table-view twin so values never depend on hovering.
 */
export function DailyAreaChart<T extends { date: string }>({
  data,
  dataKey,
  title,
  seriesLabel,
  days,
  format = (v) => String(v),
  extra,
  dim,
}: {
  data: T[];
  dataKey: keyof T & string;
  title: string;
  seriesLabel: string;
  days: number;
  format?: (v: number) => string;
  extra?: (row: Record<string, unknown>) => ReactNode;
  dim?: boolean;
}) {
  const [table, setTable] = useState(false);
  const total = data.reduce((s, r) => s + Number(r[dataKey] ?? 0), 0);
  const gradientId = `wash-${dataKey}`;
  return (
    <section className={cx('rounded-xl border border-zinc-200 bg-white shadow-xs transition-opacity', dim && 'opacity-60')}>
      <header className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="text-sm font-medium text-zinc-500">{title}</h2>
          <div className="text-2xl font-semibold tracking-tight text-zinc-900">{format(total)}</div>
        </div>
        <button onClick={() => setTable(!table)} className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800">
          {table ? 'Chart' : 'Table'}
        </button>
      </header>
      {table ? (
        <div className="scroll-thin max-h-[212px] overflow-y-auto px-5 py-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1 font-medium">Day</th>
                <th className="py-1 text-right font-medium">{seriesLabel}</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((r) => (
                <tr key={r.date} className="border-t border-zinc-100">
                  <td className="py-1.5 text-zinc-700">{tickDate(r.date, 30)}</td>
                  <td className="py-1.5 text-right text-zinc-900 tabular-nums">{format(Number(r[dataKey] ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-[212px] px-2 pb-3">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={VIZ.series} stopOpacity={0.14} />
                  <stop offset="100%" stopColor={VIZ.series} stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={VIZ.grid} strokeWidth={1} />
              <XAxis
                dataKey="date"
                tickFormatter={(v: string) => tickDate(v, days)}
                tick={{ fill: VIZ.muted, fontSize: 11 }}
                axisLine={{ stroke: VIZ.axis }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                allowDecimals={false}
                width={44}
                tickFormatter={(v: number) => compact.format(v)}
                tick={{ fill: VIZ.muted, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ stroke: VIZ.axis, strokeWidth: 1 }}
                content={<ChartTooltip seriesLabel={seriesLabel} format={format} extra={extra} />}
              />
              <Area
                type="monotone"
                dataKey={(row: T) => Number(row[dataKey] ?? 0)}
                stroke={VIZ.series}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                strokeLinecap="round"
                strokeLinejoin="round"
                activeDot={{ r: 5, fill: VIZ.series, stroke: '#ffffff', strokeWidth: 2 }}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** Text shown at the bar's tip (defaults to the value). */
  display?: string;
  /** Extra detail on hover/focus. */
  detail?: string;
  color?: string;
}

/** Horizontal bars: ≤16px thick, square at the baseline, 4px rounded data-end, value at the tip. */
export function BarList({ rows, empty = 'No data yet' }: { rows: BarRow[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li
          key={r.key}
          tabIndex={0}
          title={r.detail ?? `${typeof r.label === 'string' ? r.label : ''} ${r.display ?? r.value}`.trim()}
          className="group grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-3 rounded focus:outline-2 focus:outline-brand-600"
        >
          <div className="truncate text-sm text-zinc-700">{r.label}</div>
          <div className="flex min-w-0 items-center gap-2">
            <div
              className="h-4 rounded-r-[4px] transition-[filter] group-hover:brightness-110"
              style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, maxWidth: 'calc(100% - 3.5rem)', background: r.color ?? VIZ.series }}
            />
            <span className="shrink-0 text-sm font-medium text-zinc-900 tabular-nums">{r.display ?? r.value}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
