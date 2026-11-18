/**
 * Chart wrappers (recharts) styled with the design tokens and mirrored for right-to-left.
 * Thin marks (bars ≤ 24px with a 4px rounded end, 2px lines), hairline solid grid, values in
 * the tooltip first, a legend whenever there are two or more series, and categorical colours
 * in a fixed order (validated for colour-blind separation on both themes).
 */
import type { ReactNode } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const VIZ_CSS = `
:root { --viz-1: #2a78d6; --viz-2: #eb6834; --viz-3: #1baf7a; --viz-4: #6250d6; }
.dark { --viz-1: #3987e5; --viz-2: #d95926; --viz-3: #199e70; --viz-4: #9085e9; }
`;

/** Series colours in fixed order: identity, never rank. */
export const VIZ = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)'] as const;

function VizStyle() {
  return (
    <style href="natija-viz-palette" precedence="default">
      {VIZ_CSS}
    </style>
  );
}

export type Series = { key: string; label: string; color?: string };
type Fmt = (v: number) => string;

const tick = { fill: 'var(--c-muted)', fontSize: 11 };
const grid = <CartesianGrid vertical={false} stroke="var(--c-line)" />;

/** Tooltip: the value leads, the series name follows, keyed with a short line in its colour. */
function TipBox({
  active,
  payload,
  label,
  labelFormat,
  valueFormat,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: unknown; value?: unknown; color?: string; dataKey?: unknown; payload?: unknown }>;
  label?: unknown;
  labelFormat?: (label: unknown, row: unknown) => ReactNode;
  valueFormat: Fmt;
}) {
  const rtl = useLang() === 'ar';
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="min-w-36 rounded-lg border border-line bg-raised px-3 py-2 text-start text-[12.5px] shadow-pop">
      <div className="mb-1 text-muted">{labelFormat ? labelFormat(label, row) : String(label ?? '')}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 py-0.5">
          <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: p.color }} />
          <span className="font-semibold text-ink tabular ltr-num">{typeof p.value === 'number' ? valueFormat(p.value) : '—'}</span>
          <span className="text-muted">{String(p.name ?? '')}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend above the plot (only for two or more series); rect keys for bars, line keys for lines. */
export function Legend({ series, kind = 'bar' }: { series: Series[]; kind?: 'bar' | 'line' }) {
  if (series.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {series.map((s, i) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className={kind === 'bar' ? 'size-2.5 rounded-[3px]' : 'h-0.5 w-3.5 rounded-full'} style={{ background: s.color ?? VIZ[i % VIZ.length] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Keeps the previous render visible (dimmed) while new data loads. */
export function ChartFrame({ fetching, children, className }: { fetching?: boolean; children: ReactNode; className?: string }) {
  return <div className={cn('min-w-0 transition-opacity', fetching && 'opacity-60', className)}>{children}</div>;
}

/* ------------------------------------------------------------------ columns */

export function ColumnChart<T extends object>({
  data,
  x,
  series,
  height = 220,
  xFormat,
  valueFormat,
  labelFormat,
  stacked,
  yWidth = 44,
}: {
  data: T[];
  x: keyof T & string;
  series: Series[];
  height?: number;
  xFormat?: (v: unknown) => string;
  valueFormat: Fmt;
  labelFormat?: (label: unknown, row: unknown) => ReactNode;
  stacked?: boolean;
  yWidth?: number;
}) {
  const rtl = useLang() === 'ar';
  return (
    <div className="min-w-0">
      <VizStyle />
      <Legend series={series} />
      <div dir="ltr">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }} barGap={2} barCategoryGap="22%">
          {grid}
          <XAxis dataKey={x as never} reversed={rtl} tick={tick} tickLine={false} axisLine={{ stroke: 'var(--c-line-strong)' }} tickFormatter={xFormat} interval="preserveStartEnd" minTickGap={8} />
          <YAxis orientation={rtl ? 'right' : 'left'} tick={tick} tickLine={false} axisLine={false} width={yWidth} tickFormatter={(v: number) => valueFormat(v)} allowDecimals={false} />
          <Tooltip cursor={{ fill: 'var(--c-sunken)', opacity: 0.7 }} content={(p) => <TipBox {...(p as object)} labelFormat={labelFormat ?? (xFormat ? (l) => xFormat(l) : undefined)} valueFormat={valueFormat} />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color ?? VIZ[i % VIZ.length]}
              maxBarSize={24}
              radius={stacked && i < series.length - 1 ? 0 : [4, 4, 0, 0]}
              stackId={stacked ? 'a' : undefined}
              isAnimationActive={false}
              stroke={stacked ? 'var(--c-surface)' : undefined}
              strokeWidth={stacked ? 2 : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ ranked horizontal bars */

/**
 * Ranked horizontal bars for categories (departments, tests, payers, reasons). One colour for a
 * single series; the value sits at the bar's tip. Mirrored in Arabic: bars grow from the right.
 */
export function BarList<T extends object>({
  data,
  label,
  series,
  valueFormat,
  labelWidth = 150,
  rowHeight = 28,
  showValues = true,
}: {
  data: T[];
  label: (row: T) => string;
  series: Series[];
  valueFormat: Fmt;
  labelWidth?: number;
  rowHeight?: number;
  showValues?: boolean;
}) {
  const rtl = useLang() === 'ar';
  const maxChars = Math.max(8, Math.floor(labelWidth / 6.6));
  const rows = data.map((d) => {
    const text = label(d);
    return { ...d, __label: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text, __full: text };
  });
  const height = Math.max(80, rows.length * rowHeight * (series.length > 1 ? 1.5 : 1) + 16);
  const single = series.length === 1;
  const longest = showValues && single ? Math.max(0, ...rows.map((r) => valueFormat(Number((r as Record<string, unknown>)[series[0]!.key] ?? 0)).length)) : 0;
  const valueRoom = showValues && single ? Math.min(140, 14 + longest * 7.2) : 8;
  return (
    <div className="min-w-0">
      <VizStyle />
      <Legend series={series} />
      <div dir="ltr">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: rtl ? 4 : valueRoom, bottom: 0, left: rtl ? valueRoom : 4 }} barGap={2} barCategoryGap="24%">
          <XAxis type="number" reversed={rtl} hide domain={[0, 'dataMax']} />
          <YAxis
            type="category"
            dataKey="__label"
            orientation={rtl ? 'right' : 'left'}
            width={labelWidth}
            tick={{ ...tick, fill: 'var(--c-ink-2)', fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--c-line-strong)' }}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: 'var(--c-sunken)', opacity: 0.7 }}
            content={(p) => <TipBox {...(p as object)} labelFormat={(_l, row) => (row as { __full?: string })?.__full ?? ''} valueFormat={valueFormat} />}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color ?? VIZ[i % VIZ.length]}
              maxBarSize={single ? 18 : 12}
              radius={rtl ? [4, 0, 0, 4] : [0, 4, 4, 0]}
              isAnimationActive={false}
              label={
                showValues && single
                  ? (props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown }) => {
                      const x = Number(props.x ?? 0);
                      const y = Number(props.y ?? 0);
                      const w = Number(props.width ?? 0);
                      const h = Number(props.height ?? 0);
                      const v = typeof props.value === 'number' ? props.value : Number(props.value ?? 0);
                      const tx = rtl ? x + w - 6 : x + w + 6;
                      return (
                        <text x={tx} y={y + h / 2} dy={4} textAnchor={rtl ? 'end' : 'start'} fontSize={11.5} fill="var(--c-ink-2)" style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>
                          {valueFormat(v)}
                        </text>
                      );
                    }
                  : undefined
              }
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ lines over time */

export function LineChart<T extends object>({
  data,
  x,
  series,
  height = 220,
  xFormat,
  valueFormat,
  labelFormat,
  area = true,
  yWidth = 52,
}: {
  data: T[];
  x: keyof T & string;
  series: Series[];
  height?: number;
  xFormat?: (v: unknown) => string;
  valueFormat: Fmt;
  labelFormat?: (label: unknown, row: unknown) => ReactNode;
  area?: boolean;
  yWidth?: number;
}) {
  const rtl = useLang() === 'ar';
  return (
    <div className="min-w-0">
      <VizStyle />
      <Legend series={series} kind="line" />
      <div dir="ltr">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          {grid}
          <XAxis dataKey={x as never} reversed={rtl} tick={tick} tickLine={false} axisLine={{ stroke: 'var(--c-line-strong)' }} tickFormatter={xFormat} interval="preserveStartEnd" minTickGap={16} />
          <YAxis orientation={rtl ? 'right' : 'left'} tick={tick} tickLine={false} axisLine={false} width={yWidth} tickFormatter={(v: number) => valueFormat(v)} />
          <Tooltip cursor={{ stroke: 'var(--c-line-strong)', strokeWidth: 1 }} content={(p) => <TipBox {...(p as object)} labelFormat={labelFormat ?? (xFormat ? (l) => xFormat(l) : undefined)} valueFormat={valueFormat} />} />
          {area && series.length === 1 ? (
            <Area dataKey={series[0]!.key} name={series[0]!.label} stroke="none" fill={series[0]!.color ?? VIZ[0]} fillOpacity={0.1} isAnimationActive={false} tooltipType="none" />
          ) : null}
          {series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stroke={s.color ?? VIZ[i % VIZ.length]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--c-surface)' }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ segmented bar */

/** One whole split into parts (≤ 6), e.g. work in progress by stage or instruments by status. */
export function SegmentedBar({ parts, valueFormat }: { parts: Array<{ key: string; label: string; value: number; color: string }>; valueFormat: Fmt }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <div className="h-2 rounded-full bg-sunken" />;
  return (
    <div>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div key={p.key} title={`${p.label}: ${valueFormat(p.value)}`} className="h-full first:rounded-s-full last:rounded-e-full" style={{ width: `${(100 * p.value) / total}%`, background: p.color }} />
          ))}
      </div>
    </div>
  );
}
