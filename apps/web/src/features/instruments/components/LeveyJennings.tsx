import { useTranslation } from 'react-i18next';
import { ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { QcChart, QcRunStatus } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useLang } from '@/lib/i18n';

type Point = { i: number; value: number; z: number; status: QcRunStatus; violations: string[]; runAt: string; source: string };

const STATUS_COLOR: Record<QcRunStatus, string> = { accepted: 'var(--c-ok)', warning: 'var(--c-warn)', rejected: 'var(--c-crit)' };

/** Status by colour AND shape (circle, triangle, square) so it reads in print and for colour-blind staff. */
function StatusDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: Point }) {
  if (cx === undefined || cy === undefined || !payload) return null;
  const fill = STATUS_COLOR[payload.status];
  if (payload.status === 'rejected') return <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} fill={fill} stroke="var(--c-surface)" strokeWidth={1.5} />;
  if (payload.status === 'warning') return <path d={`M${cx},${cy - 5.5} L${cx + 5.5},${cy + 4.5} L${cx - 5.5},${cy + 4.5} Z`} fill={fill} stroke="var(--c-surface)" strokeWidth={1.5} />;
  return <circle cx={cx} cy={cy} r={4} fill={fill} stroke="var(--c-surface)" strokeWidth={1.5} />;
}

function Tip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const p = payload?.[0]?.payload as Point | undefined;
  if (!active || !p) return null;
  return (
    <div className="min-w-44 rounded-lg border border-line bg-raised px-3 py-2 text-[12.5px] shadow-pop">
      <div className="mb-1 text-muted tabular">{f.dateTime(p.runAt)}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold text-ink tabular ltr-num">{f.number(p.value)}</span>
        <span className="text-muted ltr-num">z = {f.number(p.z, 2)}</span>
      </div>
      <div className="mt-1 font-medium" style={{ color: STATUS_COLOR[p.status] }}>
        {t(`common:status.qc.${p.status}`)}
        {p.violations.length ? <span className="ltr-num"> · {p.violations.join(', ')}</span> : null}
      </div>
      <div className="text-[11.5px] text-muted">{t(`qc.sources.${p.source}`)}</div>
    </div>
  );
}

/** Levey-Jennings chart: runs in time order against the target mean and ±1/2/3 SD. */
export function LeveyJennings({ chart }: { chart: QcChart }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const rtl = useLang() === 'ar';
  const { mean, sd, lines } = chart;
  const data: Point[] = chart.points.map((p, i) => ({ i: i + 1, value: p.value, z: p.z, status: p.status, violations: p.violations, runAt: p.runAt, source: p.source }));
  const values = data.map((d) => d.value);
  const lo = Math.min(lines.minus3 - sd * 0.6, ...values);
  const hi = Math.max(lines.plus3 + sd * 0.6, ...values);
  const refs = [
    { y: lines.plus3, label: '+3SD', stroke: 'var(--c-crit)', dash: '6 4' },
    { y: lines.plus2, label: '+2SD', stroke: 'var(--c-warn)', dash: '6 4' },
    { y: lines.plus1, label: '+1SD', stroke: 'var(--c-line-strong)', dash: '2 4' },
    { y: mean, label: t('qc.mean'), stroke: 'var(--c-ink-2)', dash: undefined },
    { y: lines.minus1, label: '−1SD', stroke: 'var(--c-line-strong)', dash: '2 4' },
    { y: lines.minus2, label: '−2SD', stroke: 'var(--c-warn)', dash: '6 4' },
    { y: lines.minus3, label: '−3SD', stroke: 'var(--c-crit)', dash: '6 4' },
  ];
  return (
    <div className="h-72 w-full" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: rtl ? 8 : 44, left: rtl ? 44 : 8, bottom: 4 }}>
          <XAxis
            dataKey="i"
            type="number"
            domain={[0.5, Math.max(1, data.length) + 0.5]}
            ticks={data.map((d) => d.i)}
            interval="preserveStartEnd"
            minTickGap={18}
            reversed={rtl}
            tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
            tickFormatter={(v: number) => (data[v - 1] ? f.shortDay(data[v - 1]!.runAt) : '')}
            stroke="var(--c-line-strong)"
          />
          <YAxis
            orientation={rtl ? 'right' : 'left'}
            domain={[lo, hi]}
            ticks={[lines.minus3, lines.minus2, lines.minus1, mean, lines.plus1, lines.plus2, lines.plus3]}
            tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
            tickFormatter={(v: number) => f.number(v)}
            width={52}
            stroke="var(--c-line-strong)"
          />
          {refs.map((r) => (
            <ReferenceLine
              key={r.label}
              y={r.y}
              stroke={r.stroke}
              strokeDasharray={r.dash}
              strokeWidth={r.dash ? 1 : 1.5}
              ifOverflow="extendDomain"
              label={{ value: r.label, position: rtl ? 'insideLeft' : 'right', fill: 'var(--c-muted)', fontSize: 10.5 }}
            />
          ))}
          <Tooltip content={<Tip />} cursor={{ stroke: 'var(--c-line-strong)' }} />
          <Line type="linear" dataKey="value" stroke="var(--c-accent)" strokeWidth={1.5} isAnimationActive={false} dot={<StatusDot />} activeDot={{ r: 6 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
