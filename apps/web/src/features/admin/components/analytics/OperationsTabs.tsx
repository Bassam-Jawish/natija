import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AnalyticsProductivity, AnalyticsRejections, AnalyticsTat, AnalyticsVolume } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Card, DataTable, Segmented, type ColumnDef, type DateRange } from '@/components/ui';
import { BarList, ColumnChart, LineChart } from '../charts';
import { Code, useMinutes, usePairName } from '../common';
import { Figure, FigureRow, ReportBody, useReport } from './shared';

const end = { align: 'end' as const };

/* ================================================================== turnaround */

export function TatTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const minutes = useMinutes();
  const q = useReport<AnalyticsTat>('tat', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const phases = [
          { key: 'collectToReceive', value: d.phases.collectToReceive },
          { key: 'receiveToResult', value: d.phases.receiveToResult },
          { key: 'resultToValidate', value: d.phases.resultToValidate },
        ] as const;
        const testColumns: ColumnDef<AnalyticsTat['byTest'][number], unknown>[] = [
          { header: t('common.code'), accessorKey: 'code', cell: ({ row }) => <Code>{row.original.code}</Code> },
          { header: t('analytics.test'), id: 'name', cell: ({ row }) => bi(row.original, 'name') },
          { header: t('analytics.tat.target'), accessorKey: 'tatHours', meta: end, cell: ({ row }) => `${f.number(row.original.tatHours)} ${t('common.hoursShort')}` },
          { header: t('analytics.tests'), accessorKey: 'count', meta: end, cell: ({ row }) => f.number(row.original.count) },
          { header: t('analytics.tat.median'), accessorKey: 'median', meta: end, cell: ({ row }) => minutes(row.original.median) },
          { header: t('analytics.tat.p90'), accessorKey: 'p90', meta: end, cell: ({ row }) => minutes(row.original.p90) },
          { header: t('analytics.tat.onTime'), accessorKey: 'onTimePct', meta: end, cell: ({ row }) => <OnTime pct={row.original.onTimePct} /> },
        ];
        const deptColumns: ColumnDef<AnalyticsTat['byDepartment'][number], unknown>[] = [
          { header: t('analytics.department'), id: 'name', cell: ({ row }) => bi(row.original, 'name') },
          { header: t('analytics.tests'), accessorKey: 'count', meta: end, cell: ({ row }) => f.number(row.original.count) },
          { header: t('analytics.tat.median'), accessorKey: 'median', meta: end, cell: ({ row }) => minutes(row.original.median) },
          { header: t('analytics.tat.p90'), accessorKey: 'p90', meta: end, cell: ({ row }) => minutes(row.original.p90) },
          { header: t('analytics.tat.onTime'), accessorKey: 'onTimePct', meta: end, cell: ({ row }) => <OnTime pct={row.original.onTimePct} /> },
        ];
        return (
          <>
            <FigureRow>
              <Figure label={t('analytics.tat.validated')} value={f.number(d.overall.count)} />
              <Figure label={t('analytics.tat.median')} value={minutes(d.overall.median)} />
              <Figure label={t('analytics.tat.p90')} value={minutes(d.overall.p90)} />
              <Figure label={t('analytics.tat.mean')} value={minutes(d.overall.mean)} />
              <Figure
                label={t('analytics.tat.onTime')}
                value={f.percent(d.overall.onTimePct, 1)}
                tone={d.overall.onTimePct === null ? undefined : d.overall.onTimePct >= 90 ? 'ok' : d.overall.onTimePct >= 75 ? 'warn' : 'crit'}
              />
            </FigureRow>
            <Card title={t('analytics.tat.phases')} description={t('analytics.tat.phasesHint')}>
              <ol className="grid gap-3 sm:grid-cols-3">
                {phases.map((p, i) => (
                  <li key={p.key} className="rounded-lg border border-line px-3 py-2.5">
                    <div className="text-[12px] text-muted">
                      {i + 1}. {t(`analytics.tat.${p.key}`)}
                    </div>
                    <div className="text-[18px] font-semibold text-ink">{minutes(p.value)}</div>
                  </li>
                ))}
              </ol>
            </Card>
            <div className="grid gap-4 xl:grid-cols-5">
              <Card title={t('analytics.tat.byDay')} className="xl:col-span-3">
                <LineChart
                  data={d.byDay}
                  x="date"
                  series={[
                    { key: 'median', label: t('analytics.tat.median') },
                    { key: 'p90', label: t('analytics.tat.p90') },
                  ]}
                  xFormat={(v) => f.shortDay(String(v))}
                  labelFormat={(v) => f.date(String(v))}
                  valueFormat={(v) => f.duration(v)}
                  area={false}
                  yWidth={64}
                />
              </Card>
              <Card title={t('analytics.tat.distribution')} description={t('analytics.tat.distributionHint')} className="xl:col-span-2">
                <ColumnChart
                  data={d.histogram}
                  x="bucket"
                  series={[{ key: 'count', label: t('analytics.tests') }]}
                  xFormat={(b) => t(`analytics.tat.buckets.${String(b)}`)}
                  valueFormat={(v) => f.number(v)}
                  yWidth={36}
                />
              </Card>
            </div>
            <Card title={t('analytics.byDepartment')} padded={false}>
              <DataTable columns={deptColumns} data={d.byDepartment} dense className="rounded-none border-0" empty={{ title: t('analytics.empty') }} />
            </Card>
            <Card title={t('analytics.tat.byTest')} description={t('analytics.tat.byTestHint')} padded={false}>
              <DataTable columns={testColumns} data={d.byTest} dense className="rounded-none border-0" maxHeight="60vh" empty={{ title: t('analytics.empty') }} />
            </Card>
          </>
        );
      }}
    </ReportBody>
  );
}

function OnTime({ pct }: { pct: number | null }) {
  const f = useFormat();
  if (pct === null) return <span className="text-faint">—</span>;
  return <span className={pct >= 90 ? 'text-ok' : pct >= 75 ? 'text-warn' : 'font-medium text-crit'}>{f.percent(pct, 0)}</span>;
}

/* ================================================================== volume */

export function VolumeTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const [measure, setMeasure] = useState<'orders' | 'tests' | 'patients'>('orders');
  const q = useReport<AnalyticsVolume>('volume', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const testColumns: ColumnDef<AnalyticsVolume['byTest'][number], unknown>[] = [
          { header: '#', id: 'rank', cell: ({ row }) => <span className="text-muted tabular">{f.number(row.index + 1)}</span>, size: 40 },
          { header: t('common.code'), accessorKey: 'code', cell: ({ row }) => <Code>{row.original.code}</Code> },
          { header: t('analytics.test'), id: 'name', cell: ({ row }) => bi(row.original, 'name') },
          { header: t('analytics.count'), accessorKey: 'count', meta: end, cell: ({ row }) => f.number(row.original.count) },
          {
            header: t('analytics.share'),
            id: 'share',
            meta: end,
            cell: ({ row }) => <span className="text-muted">{d.totals.tests ? f.percent((100 * row.original.count) / d.totals.tests, 1) : '—'}</span>,
          },
        ];
        return (
          <>
            <FigureRow>
              <Figure label={t('analytics.orders')} value={f.number(d.totals.orders)} />
              <Figure label={t('analytics.tests')} value={f.number(d.totals.tests)} hint={d.totals.orders ? t('analytics.volume.perOrder', { n: f.number(d.totals.tests / d.totals.orders, 1) }) : undefined} />
              <Figure label={t('analytics.patients')} value={f.number(d.totals.patients)} />
              <Figure label={t('analytics.volume.newPatients')} value={f.number(d.totals.newPatients)} />
              <Figure label={t('analytics.volume.samples')} value={f.number(d.totals.samples)} />
            </FigureRow>
            <Card
              title={t('analytics.volume.byDay')}
              actions={
                <Segmented
                  size="sm"
                  value={measure}
                  onChange={setMeasure}
                  options={[
                    { value: 'orders', label: t('analytics.orders') },
                    { value: 'tests', label: t('analytics.tests') },
                    { value: 'patients', label: t('analytics.patients') },
                  ]}
                />
              }
            >
              <LineChart
                data={d.byDay}
                x="date"
                series={[{ key: measure, label: t(`analytics.${measure}`) }]}
                xFormat={(v) => f.shortDay(String(v))}
                labelFormat={(v) => f.date(String(v))}
                valueFormat={(v) => f.number(v)}
                yWidth={40}
              />
            </Card>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card title={t('analytics.volume.byHour')} description={t('analytics.volume.byHourHint')}>
                <ColumnChart data={d.byHour} x="hour" series={[{ key: 'orders', label: t('analytics.orders') }]} xFormat={(h) => f.number(Number(h))} valueFormat={(v) => f.number(v)} yWidth={36} />
              </Card>
              <Card title={t('analytics.volume.byWeekday')}>
                <ColumnChart
                  data={d.byWeekday}
                  x="weekday"
                  series={[{ key: 'orders', label: t('analytics.orders') }]}
                  xFormat={(w) => t(`analytics.weekday${Number(w)}`)}
                  valueFormat={(v) => f.number(v)}
                  yWidth={36}
                />
              </Card>
            </div>
            <div className="grid gap-4 xl:grid-cols-5">
              <Card title={t('analytics.byDepartment')} className="xl:col-span-2">
                {d.byDepartment.length ? (
                  <BarList data={d.byDepartment} label={(r) => bi(r, 'name')} series={[{ key: 'tests', label: t('analytics.tests') }]} valueFormat={(v) => f.number(v)} labelWidth={140} />
                ) : (
                  <p className="text-[13px] text-muted">{t('analytics.empty')}</p>
                )}
                <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-3 text-[12.5px]">
                  <div>
                    <div className="mb-1 font-medium text-ink-2">{t('analytics.volume.bySource')}</div>
                    {d.bySource.map((s) => (
                      <div key={s.source} className="flex justify-between py-0.5">
                        <span className="text-muted">{t(`analytics.sources.${s.source}`, { defaultValue: s.source })}</span>
                        <span className="tabular ltr-num">{f.number(s.orders)}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div className="mb-1 font-medium text-ink-2">{t('analytics.volume.byPriority')}</div>
                    {d.byPriority.map((s) => (
                      <div key={s.priority} className="flex justify-between py-0.5">
                        <span className="text-muted">{t(`status.priority.${s.priority}`, { ns: 'common', defaultValue: s.priority })}</span>
                        <span className="tabular ltr-num">{f.number(s.orders)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
              <Card title={t('analytics.volume.topTests')} padded={false} className="xl:col-span-3">
                <DataTable columns={testColumns} data={d.byTest} dense className="rounded-none border-0" maxHeight="52vh" empty={{ title: t('analytics.empty') }} />
              </Card>
            </div>
          </>
        );
      }}
    </ReportBody>
  );
}

/* ================================================================== productivity */

export function ProductivityTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const q = useReport<AnalyticsProductivity>('productivity', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const label = (u: AnalyticsProductivity['users'][number]) => (u.userId ? name(u.nameAr, u.nameEn) : t('common.analyzers'));
        const bench = d.users.filter((u) => u.entered + u.verified + u.validated > 0);
        const columns: ColumnDef<AnalyticsProductivity['users'][number], unknown>[] = [
          { header: t('analytics.productivity.person'), id: 'name', cell: ({ row }) => <span className={row.original.userId ? '' : 'text-muted'}>{label(row.original)}</span> },
          { header: t('analytics.productivity.entered'), accessorKey: 'entered', meta: end, cell: ({ row }) => f.number(row.original.entered) },
          { header: t('analytics.productivity.verified'), accessorKey: 'verified', meta: end, cell: ({ row }) => f.number(row.original.verified) },
          { header: t('analytics.productivity.validated'), accessorKey: 'validated', meta: end, cell: ({ row }) => f.number(row.original.validated) },
          { header: t('analytics.productivity.orders'), accessorKey: 'ordersCreated', meta: end, cell: ({ row }) => f.number(row.original.ordersCreated) },
          { header: t('analytics.productivity.collected'), accessorKey: 'samplesCollected', meta: end, cell: ({ row }) => f.number(row.original.samplesCollected) },
          { header: t('analytics.productivity.received'), accessorKey: 'samplesReceived', meta: end, cell: ({ row }) => f.number(row.original.samplesReceived) },
        ];
        return (
          <>
            <Card title={t('analytics.productivity.results')} description={t('analytics.productivity.resultsHint')}>
              {bench.length ? (
                <BarList
                  data={bench}
                  label={label}
                  series={[
                    { key: 'entered', label: t('analytics.productivity.entered') },
                    { key: 'verified', label: t('analytics.productivity.verified') },
                    { key: 'validated', label: t('analytics.productivity.validated') },
                  ]}
                  valueFormat={(v) => f.number(v)}
                  labelWidth={160}
                />
              ) : (
                <p className="py-6 text-center text-[13px] text-muted">{t('analytics.empty')}</p>
              )}
            </Card>
            <Card title={t('analytics.productivity.all')} padded={false}>
              <DataTable columns={columns} data={d.users} dense className="rounded-none border-0" empty={{ title: t('analytics.empty') }} />
            </Card>
          </>
        );
      }}
    </ReportBody>
  );
}

/* ================================================================== rejections */

export function RejectionsTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const q = useReport<AnalyticsRejections>('rejections', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const recentColumns: ColumnDef<AnalyticsRejections['recent'][number], unknown>[] = [
          { header: t('analytics.rejections.at'), id: 'at', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.dateTime(row.original.rejectedAt)}</span> },
          {
            header: t('analytics.rejections.tube'),
            id: 'tube',
            cell: ({ row }) => (
              <Link to={`/orders/${row.original.orderId}`} className="font-mono text-[12.5px] text-accent ltr-num hover:underline">
                {row.original.barcode}
              </Link>
            ),
          },
          { header: t('analytics.patient'), id: 'patient', cell: ({ row }) => name(row.original.patientNameAr, row.original.patientNameEn) },
          { header: t('analytics.rejections.reason'), id: 'reason', cell: ({ row }) => name(row.original.reasonNameAr, row.original.reasonNameEn) || '—' },
          { header: t('common.notes'), id: 'note', cell: ({ row }) => <span className="text-muted">{row.original.note ?? ''}</span> },
          { header: t('common.by'), id: 'by', cell: ({ row }) => name(row.original.rejectedByNameAr, row.original.rejectedByNameEn) },
        ];
        const peopleColumns: ColumnDef<AnalyticsRejections['byCollector'][number], unknown>[] = [
          { header: t('analytics.rejections.collector'), id: 'name', cell: ({ row }) => name(row.original.nameAr, row.original.nameEn) || t('common.none') },
          { header: t('analytics.rejections.samples'), accessorKey: 'count', meta: end, cell: ({ row }) => f.number(row.original.count) },
        ];
        return (
          <>
            <FigureRow cols={3}>
              <Figure label={t('analytics.rejections.evaluated')} value={f.number(d.totals.evaluated)} />
              <Figure label={t('analytics.rejections.rejected')} value={f.number(d.totals.rejected)} />
              <Figure
                label={t('analytics.rejections.rate')}
                value={f.percent(d.totals.ratePct, 1)}
                tone={d.totals.ratePct === null ? undefined : d.totals.ratePct <= 1 ? 'ok' : d.totals.ratePct <= 3 ? 'warn' : 'crit'}
                hint={t('analytics.rejections.rateHint')}
              />
            </FigureRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card title={t('analytics.rejections.byReason')}>
                {d.byReason.length ? (
                  <BarList data={d.byReason} label={(r) => name(r.nameAr, r.nameEn) || t('dashboard.rejections.noReason')} series={[{ key: 'count', label: t('analytics.rejections.samples') }]} valueFormat={(v) => f.number(v)} labelWidth={170} />
                ) : (
                  <p className="py-6 text-center text-[13px] text-muted">{t('analytics.rejections.none')}</p>
                )}
              </Card>
              <Card title={t('analytics.rejections.byDay')}>
                <ColumnChart data={d.byDay} x="date" series={[{ key: 'rejected', label: t('analytics.rejections.rejected') }]} xFormat={(v) => f.shortDay(String(v))} labelFormat={(v) => f.date(String(v))} valueFormat={(v) => f.number(v)} yWidth={32} />
              </Card>
            </div>
            <div className="grid gap-4 xl:grid-cols-3">
              <Card title={t('analytics.rejections.byCollector')} padded={false}>
                <DataTable columns={peopleColumns} data={d.byCollector} dense className="rounded-none border-0" empty={{ title: t('analytics.rejections.none') }} />
              </Card>
              <Card title={t('analytics.rejections.recent')} padded={false} className="xl:col-span-2">
                <DataTable columns={recentColumns} data={d.recent} dense className="rounded-none border-0" maxHeight="50vh" empty={{ title: t('analytics.rejections.none') }} />
              </Card>
            </div>
          </>
        );
      }}
    </ReportBody>
  );
}
