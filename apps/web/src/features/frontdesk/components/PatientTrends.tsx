import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, LineChart as LineIcon } from 'lucide-react';
import { Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip as ChartTooltip, YAxis } from 'recharts';
import type { AnalyteTrend } from '@natija/contracts';
import { formatValue } from '@natija/domain';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyState, FlagChip, Segmented } from '@/components/ui';

/** Small trend line with the reference range shaded; time runs left to right in both languages. */
function Sparkline({ trend }: { trend: AnalyteTrend }) {
  const f = useFormat();
  const data = trend.points.map((p) => ({ at: p.at, value: p.value, flag: p.flag }));
  const values = data.map((d) => d.value);
  const lo = Math.min(...values, trend.refLow ?? Infinity);
  const hi = Math.max(...values, trend.refHigh ?? -Infinity);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.15;
  return (
    <div dir="ltr" className="h-14 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis hide domain={[lo - pad, hi + pad]} />
          {trend.refLow !== null || trend.refHigh !== null ? (
            <ReferenceArea y1={trend.refLow ?? lo - pad} y2={trend.refHigh ?? hi + pad} fill="var(--c-ok)" fillOpacity={0.08} stroke="none" ifOverflow="hidden" />
          ) : null}
          <ChartTooltip
            cursor={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as { at: string; value: number; flag: string | null } | undefined) : undefined;
              if (!p) return null;
              return (
                <div className="rounded-md bg-ink px-2 py-1 text-[11.5px] text-paper shadow-pop">
                  {f.date(p.at)} · <span className="font-semibold">{formatValue(p.value, trend.decimals)}</span> {trend.unit ?? ''} {p.flag && p.flag !== 'N' ? `(${p.flag})` : ''}
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--c-accent)"
            strokeWidth={1.75}
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: { flag: string | null } }) => {
              const abnormal = !!props.payload?.flag && props.payload.flag !== 'N';
              return (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={abnormal ? 3 : 2.25}
                  fill={abnormal ? 'var(--c-warn)' : 'var(--c-accent)'}
                  stroke="var(--c-surface)"
                  strokeWidth={1}
                />
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendCard({ trend }: { trend: AnalyteTrend }) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const bi = useBi();
  const [open, setOpen] = useState(false);
  const last = trend.points[trend.points.length - 1]!;
  const range = trend.refLow !== null && trend.refHigh !== null ? `${formatValue(trend.refLow, trend.decimals)} – ${formatValue(trend.refHigh, trend.decimals)}` : null;
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">{bi(trend)}</p>
          <p className="font-mono text-[11.5px] text-muted ltr-num">{trend.code}</p>
        </div>
        <div className="text-end">
          <p className="text-[17px] font-semibold text-ink tabular ltr-num">
            {formatValue(last.value, trend.decimals)} <span className="text-[11.5px] font-normal text-muted">{trend.unit}</span>
          </p>
          <FlagChip flag={last.flag} critical={last.isCritical} />
        </div>
      </div>
      <div className="px-2">{trend.points.length > 1 ? <Sparkline trend={trend} /> : <div className="grid h-14 place-items-center text-[12px] text-muted">{t('trends.single')}</div>}</div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-[12px] text-muted hover:text-ink"
      >
        <span>
          {t('trends.count', { count: trend.points.length })}
          {range ? (
            <span className="ms-2">
              · {t('trends.range')} <span className="ltr-num">{range}</span>
            </span>
          ) : null}
        </span>
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <ul className="max-h-48 overflow-y-auto border-t border-line text-[12.5px]">
          {[...trend.points].reverse().map((p) => (
            <li key={`${p.orderId}-${p.at}`} className="flex items-center gap-2 border-b border-line px-3 py-1 last:border-0">
              <span className="text-muted tabular">{f.date(p.at)}</span>
              <Link to={`/orders/${p.orderId}?tab=results`} className="font-mono text-[11.5px] text-accent hover:underline ltr-num">
                {p.accession}
              </Link>
              <span className="ms-auto font-medium tabular ltr-num">{formatValue(p.value, trend.decimals)}</span>
              <FlagChip flag={p.flag} critical={p.isCritical} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Cumulative validated numeric results, one card per analyte, the most repeated first. */
export function PatientTrends({ analytes }: { analytes: AnalyteTrend[] }) {
  const { t } = useTranslation('frontdesk');
  const [show, setShow] = useState<'repeated' | 'all'>('repeated');
  if (!analytes.length) return <EmptyState icon={LineIcon} title={t('trends.empty')} description={t('trends.emptyHint')} />;
  const repeated = analytes.filter((a) => a.points.length > 1);
  const list = show === 'repeated' && repeated.length ? repeated : analytes;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted">{t('trends.hint')}</p>
        {repeated.length && repeated.length < analytes.length ? (
          <Segmented<'repeated' | 'all'>
            size="sm"
            value={show}
            onChange={setShow}
            options={[
              { value: 'repeated', label: t('trends.repeated'), count: repeated.length },
              { value: 'all', label: t('trends.all'), count: analytes.length },
            ]}
          />
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {list.map((a) => (
          <TrendCard key={a.analyteId} trend={a} />
        ))}
      </div>
    </div>
  );
}
