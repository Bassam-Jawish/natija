import { useTranslation } from 'react-i18next';
import type { AnalyticsDoctors, AnalyticsInstruments, AnalyticsRevenue, DoctorReferral, FinanceMethodTotal } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Card, DataTable, Money, StatusChip, type ColumnDef, type DateRange } from '@/components/ui';
import { BarList, LineChart } from '../charts';
import { Code, usePairName } from '../common';
import { Figure, FigureRow, ReportBody, useReport } from './shared';

const end = { align: 'end' as const };

/* ================================================================== revenue */

export function RevenueTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const q = useReport<AnalyticsRevenue>('revenue', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const payerColumns: ColumnDef<AnalyticsRevenue['byPayer'][number], unknown>[] = [
          { header: t('analytics.payer'), id: 'name', cell: ({ row }) => bi(row.original, 'name') },
          { header: t('analytics.revenue.kind'), id: 'kind', cell: ({ row }) => <Badge tone="neutral">{t(`kinds.${row.original.kind}`)}</Badge> },
          { header: t('analytics.revenue.invoices'), accessorKey: 'invoices', meta: end, cell: ({ row }) => f.number(row.original.invoices) },
          { header: t('analytics.revenue.net'), accessorKey: 'net', meta: end, cell: ({ row }) => <Money value={row.original.net} /> },
          { header: t('analytics.revenue.patientShare'), accessorKey: 'patient', meta: end, cell: ({ row }) => <Money value={row.original.patient} /> },
          { header: t('analytics.revenue.payerShare'), accessorKey: 'insurer', meta: end, cell: ({ row }) => <Money value={row.original.insurer} /> },
          { header: t('analytics.revenue.paid'), accessorKey: 'paid', meta: end, cell: ({ row }) => <Money value={row.original.paid} /> },
          {
            header: t('analytics.revenue.outstanding'),
            accessorKey: 'outstanding',
            meta: end,
            cell: ({ row }) => <Money value={row.original.outstanding} className={row.original.outstanding > 0 ? 'text-warn' : 'text-muted'} />,
          },
        ];
        const testColumns: ColumnDef<AnalyticsRevenue['topTests'][number], unknown>[] = [
          { header: t('common.code'), accessorKey: 'code', cell: ({ row }) => <Code>{row.original.code}</Code> },
          { header: t('analytics.test'), id: 'name', cell: ({ row }) => bi(row.original, 'name') },
          { header: t('analytics.count'), accessorKey: 'count', meta: end, cell: ({ row }) => f.number(row.original.count) },
          { header: t('analytics.revenue.net'), accessorKey: 'net', meta: end, cell: ({ row }) => <Money value={row.original.net} /> },
        ];
        return (
          <>
            <FigureRow cols={6}>
              <Figure label={t('analytics.revenue.net')} value={f.money(d.totals.net)} hint={t('analytics.revenue.billedHint', { amount: f.money(d.totals.billed) })} />
              <Figure label={t('analytics.revenue.collected')} value={f.money(d.totals.collected)} tone="ok" />
              <Figure label={t('analytics.revenue.outstanding')} value={f.money(d.totals.outstanding)} tone={d.totals.outstanding > 0 ? 'warn' : undefined} />
              <Figure label={t('analytics.revenue.receivable')} value={f.money(d.totals.insurerShare)} />
              <Figure label={t('analytics.revenue.discounts')} value={f.money(d.totals.discounts)} />
              <Figure label={t('analytics.revenue.refunds')} value={f.money(d.totals.refunds)} />
            </FigureRow>
            <Card title={t('analytics.revenue.byDay')} description={t('analytics.revenue.byDayHint')}>
              <LineChart
                data={d.byDay}
                x="date"
                series={[
                  { key: 'net', label: t('analytics.revenue.net') },
                  { key: 'collected', label: t('analytics.revenue.collected') },
                ]}
                area={false}
                xFormat={(v) => f.shortDay(String(v))}
                labelFormat={(v) => f.date(String(v))}
                valueFormat={(v) => f.number(v)}
                yWidth={70}
              />
            </Card>
            <Card title={t('analytics.revenue.byPayer')} padded={false}>
              <DataTable columns={payerColumns} data={d.byPayer} dense className="rounded-none border-0" empty={{ title: t('analytics.empty') }} />
            </Card>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card title={t('analytics.byDepartment')}>
                {d.byDepartment.length ? (
                  <BarList data={d.byDepartment} label={(r) => bi(r, 'name')} series={[{ key: 'net', label: t('analytics.revenue.net') }]} valueFormat={(v) => f.number(v)} labelWidth={140} />
                ) : (
                  <p className="py-6 text-center text-[13px] text-muted">{t('analytics.empty')}</p>
                )}
              </Card>
              <MethodsCard methods={d.byMethod} />
            </div>
            <Card title={t('analytics.revenue.topTests')} padded={false}>
              <DataTable columns={testColumns} data={d.topTests} dense className="rounded-none border-0" maxHeight="50vh" empty={{ title: t('analytics.empty') }} />
            </Card>
          </>
        );
      }}
    </ReportBody>
  );
}

export function MethodsCard({ methods, title }: { methods: FinanceMethodTotal[]; title?: string }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const total = methods.reduce((a, m) => a + m.net, 0);
  return (
    <Card title={title ?? t('analytics.revenue.byMethod')}>
      {methods.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted">{t('analytics.revenue.noPayments')}</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[12px] text-muted">
              <th className="pb-2 text-start font-medium">{t('analytics.revenue.method')}</th>
              <th className="pb-2 text-end font-medium">{t('analytics.revenue.payments')}</th>
              <th className="pb-2 text-end font-medium">{t('analytics.revenue.refunds')}</th>
              <th className="pb-2 text-end font-medium">{t('analytics.revenue.netIn')}</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.methodId} className="border-t border-line">
                <td className="py-1.5">
                  {bi(m, 'name')}
                  {m.isCash ? <span className="ms-1.5 text-[11.5px] text-muted">({t('analytics.revenue.cash')})</span> : null}
                </td>
                <td className="py-1.5 text-end">
                  <Money value={m.payments} />
                </td>
                <td className="py-1.5 text-end text-muted">{m.refunds ? <Money value={-m.refunds} /> : '—'}</td>
                <td className="py-1.5 text-end font-medium">
                  <Money value={m.net} />
                </td>
              </tr>
            ))}
            <tr className="border-t border-line-strong font-semibold">
              <td className="py-1.5">{t('common.total')}</td>
              <td />
              <td />
              <td className="py-1.5 text-end">
                <Money value={total} />
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ================================================================== instruments */

export function InstrumentsTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const q = useReport<AnalyticsInstruments>('instruments', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const columns: ColumnDef<AnalyticsInstruments['items'][number], unknown>[] = [
          {
            header: t('analytics.instruments.analyzer'),
            id: 'name',
            cell: ({ row }) => (
              <div className="min-w-0">
                <div className="font-medium text-ink">{row.original.name}</div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
                  <Code className="text-[11.5px]">{row.original.code}</Code>
                  {row.original.isSimulated ? <span>· {t('analytics.instruments.simulated')}</span> : null}
                  {!row.original.isActive ? <span>· {t('common.inactive')}</span> : null}
                </div>
              </div>
            ),
          },
          { header: t('common.status'), id: 'status', cell: ({ row }) => <StatusChip kind="instrument" status={row.original.status} /> },
          { header: t('analytics.instruments.level'), id: 'level', cell: ({ row }) => <StatusChip kind="level" status={row.original.integrationLevel} /> },
          { header: t('analytics.instruments.messages'), accessorKey: 'messages', meta: end, cell: ({ row }) => f.number(row.original.messages) },
          { header: t('analytics.instruments.errors'), accessorKey: 'errors', meta: end, cell: ({ row }) => <span className={row.original.errors ? 'font-medium text-crit' : 'text-muted'}>{f.number(row.original.errors)}</span> },
          { header: t('analytics.instruments.unmatched'), accessorKey: 'unmatched', meta: end, cell: ({ row }) => <span className={row.original.unmatched ? 'text-warn' : 'text-muted'}>{f.number(row.original.unmatched)}</span> },
          { header: t('analytics.instruments.results'), accessorKey: 'results', meta: end, cell: ({ row }) => f.number(row.original.results) },
          {
            header: t('analytics.instruments.qc'),
            id: 'qc',
            meta: end,
            cell: ({ row }) => (
              <span className="tabular ltr-num">
                {f.number(row.original.qcRuns)}
                {row.original.qcRejected ? <span className="ms-1 text-crit">({t('analytics.instruments.qcRejected', { n: f.number(row.original.qcRejected) })})</span> : null}
                {row.original.qcWarnings && !row.original.qcRejected ? <span className="ms-1 text-warn">({t('analytics.instruments.qcWarnings', { n: f.number(row.original.qcWarnings) })})</span> : null}
              </span>
            ),
          },
          { header: t('analytics.instruments.lastMessage'), id: 'last', cell: ({ row }) => <span className="text-muted">{row.original.lastMessageAt ? f.relative(row.original.lastMessageAt) : '—'}</span> },
          { header: t('analytics.instruments.maintenance'), id: 'maint', cell: ({ row }) => <span className="text-muted">{row.original.lastMaintenanceAt ? f.date(row.original.lastMaintenanceAt) : '—'}</span> },
        ];
        const statuses = ['online', 'offline', 'error', 'unknown'];
        return (
          <>
            <FigureRow cols={4}>
              {statuses.map((s) => (
                <Figure key={s} label={<StatusChip kind="instrument" status={s} />} value={f.number(d.counts[s] ?? 0)} tone={s === 'online' && d.counts[s] ? 'ok' : (s === 'offline' || s === 'error') && d.counts[s] ? 'crit' : undefined} />
              ))}
            </FigureRow>
            <Card title={t('analytics.instruments.title')} description={t('analytics.instruments.hint')} padded={false}>
              <DataTable columns={columns} data={d.items} dense className="rounded-none border-0" empty={{ title: t('analytics.instruments.none') }} />
            </Card>
          </>
        );
      }}
    </ReportBody>
  );
}

/* ================================================================== doctors */

export function DoctorsTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const q = useReport<AnalyticsDoctors>('doctors', range);
  return (
    <ReportBody query={q}>
      {(d) => {
        const allOrders = d.totals.orders + d.walkIn.orders;
        const columns: ColumnDef<DoctorReferral, unknown>[] = [
          {
            header: t('analytics.doctors.doctor'),
            id: 'name',
            cell: ({ row }) => (
              <div>
                <div className="font-medium text-ink">{row.original.doctorId ? name(row.original.nameAr, row.original.nameEn) : t('common.noDoctor')}</div>
                <div className="text-[11.5px] text-muted">{name(row.original.specialtyAr, row.original.specialtyEn)}</div>
              </div>
            ),
          },
          { header: t('analytics.orders'), accessorKey: 'orders', meta: end, cell: ({ row }) => f.number(row.original.orders) },
          { header: t('analytics.share'), id: 'share', meta: end, cell: ({ row }) => <span className="text-muted">{allOrders ? f.percent((100 * row.original.orders) / allOrders, 1) : '—'}</span> },
          { header: t('analytics.patients'), accessorKey: 'patients', meta: end, cell: ({ row }) => f.number(row.original.patients) },
          { header: t('analytics.tests'), accessorKey: 'tests', meta: end, cell: ({ row }) => f.number(row.original.tests) },
          ...(d.totals.revenue !== null
            ? [{ header: t('analytics.revenue.net'), accessorKey: 'revenue', meta: end, cell: ({ row }: { row: { original: DoctorReferral } }) => <Money value={row.original.revenue} /> } as ColumnDef<DoctorReferral, unknown>]
            : []),
        ];
        return (
          <>
            <FigureRow cols={d.totals.revenue !== null ? 5 : 4}>
              <Figure label={t('analytics.doctors.referred')} value={f.number(d.totals.orders)} hint={allOrders ? t('analytics.doctors.ofAll', { pct: f.percent((100 * d.totals.orders) / allOrders, 0) }) : undefined} />
              <Figure label={t('analytics.doctors.doctors')} value={f.number(d.items.length)} />
              <Figure label={t('analytics.patients')} value={f.number(d.totals.patients)} />
              <Figure label={t('analytics.doctors.walkIn')} value={f.number(d.walkIn.orders)} />
              {d.totals.revenue !== null ? <Figure label={t('analytics.doctors.revenue')} value={f.money(d.totals.revenue)} /> : null}
            </FigureRow>
            <div className="grid gap-4 xl:grid-cols-5">
              <Card title={t('analytics.doctors.top')} className="xl:col-span-2">
                {d.items.length ? (
                  <BarList data={d.items.slice(0, 12)} label={(r) => name(r.nameAr, r.nameEn)} series={[{ key: 'orders', label: t('analytics.orders') }]} valueFormat={(v) => f.number(v)} labelWidth={160} />
                ) : (
                  <p className="py-6 text-center text-[13px] text-muted">{t('analytics.doctors.none')}</p>
                )}
              </Card>
              <Card title={t('analytics.doctors.all')} padded={false} className="xl:col-span-3">
                <DataTable columns={columns} data={[...d.items, ...(d.walkIn.orders ? [d.walkIn] : [])]} dense className="rounded-none border-0" maxHeight="56vh" empty={{ title: t('analytics.doctors.none') }} />
              </Card>
            </div>
          </>
        );
      }}
    </ReportBody>
  );
}
