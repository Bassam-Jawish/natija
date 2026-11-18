import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Coins, FlaskConical, Footprints, Stethoscope, Users } from 'lucide-react';
import type { AnalyticsDoctors, DoctorReferral } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Card, DataTable, EmptyState, ErrorState, Money, Skeleton, StatTile, type ColumnDef } from '@/components/ui';
import { adminKeys } from '../../api';
import { BarList, ChartFrame } from '../charts';
import { ExportButton, FilterBar, useRangeParam } from '../common';

/** Referring doctors in a period: orders, patients, tests and revenue each brought in. */
export function ReferralsTab() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const { can } = useAuth();
  const [range, setRange] = useRangeParam(29);
  const data = useQuery({
    queryKey: adminKeys.referrals(range),
    queryFn: () => api.get<AnalyticsDoctors>('/doctors/referrals', range),
    placeholderData: keepPreviousData,
  });
  const d = data.data;
  const showMoney = d ? d.totals.revenue !== null : false;
  const referred = d?.totals.orders ?? 0;
  const all = referred + (d?.walkIn.orders ?? 0);
  const name = (r: DoctorReferral) => (r.doctorId ? bi(r, 'name') || '—' : t('common.noDoctor'));

  const columns: ColumnDef<DoctorReferral>[] = [
    {
      id: 'rank',
      header: '#',
      enableSorting: false,
      size: 48,
      cell: ({ row }) => <span className="tabular ltr-num text-faint">{row.index + 1}</span>,
    },
    {
      id: 'doctor',
      accessorFn: (r) => name(r),
      header: t('doctors.doctor'),
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium">{name(row.original)}</div>
          {bi(row.original, 'specialty') ? <div className="truncate text-[12px] text-muted">{bi(row.original, 'specialty')}</div> : null}
        </div>
      ),
    },
    { accessorKey: 'orders', header: t('doctors.orders'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num font-medium">{f.number(row.original.orders)}</span> },
    {
      id: 'share',
      accessorFn: (r) => (referred ? r.orders / referred : 0),
      header: t('doctors.referrals.share'),
      meta: { align: 'end' },
      cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{referred ? f.percent((100 * row.original.orders) / referred, 1) : '—'}</span>,
    },
    { accessorKey: 'patients', header: t('doctors.referrals.patients'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.number(row.original.patients)}</span> },
    { accessorKey: 'tests', header: t('doctors.referrals.tests'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.number(row.original.tests)}</span> },
    ...(showMoney
      ? [
          {
            accessorKey: 'revenue',
            header: t('doctors.referrals.revenue'),
            meta: { align: 'end' },
            cell: ({ row }) => <Money value={row.original.revenue} />,
          } satisfies ColumnDef<DoctorReferral>,
        ]
      : []),
  ];

  return (
    <div>
      <FilterBar range={range} onRange={setRange} end={can('analytics.read') ? <ExportButton path="/analytics/export/doctors" query={range} /> : null} />
      {data.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px]" />
          ))}
        </div>
      ) : d ? (
        <ChartFrame fetching={data.isFetching}>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatTile label={t('doctors.referrals.referredOrders')} value={f.number(referred)} hint={all ? t('doctors.referrals.ofAll', { pct: f.percent((100 * referred) / all) }) : undefined} icon={ClipboardList} tone="accent" />
            <StatTile label={t('doctors.referrals.patients')} value={f.number(d.totals.patients)} icon={Users} />
            <StatTile label={t('doctors.referrals.tests')} value={f.number(d.totals.tests)} icon={FlaskConical} />
            {showMoney ? <StatTile label={t('doctors.referrals.revenue')} value={f.money(d.totals.revenue)} icon={Coins} /> : null}
            <StatTile label={t('doctors.referrals.walkIn')} value={f.number(d.walkIn.orders)} hint={t('doctors.referrals.walkInHint', { tests: f.number(d.walkIn.tests) })} icon={Footprints} />
          </div>
          {d.items.length ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <Card title={t('doctors.referrals.top')} description={t('doctors.referrals.topHint')}>
                <BarList
                  data={d.items.slice(0, 10)}
                  label={(r) => name(r)}
                  series={[{ key: 'orders', label: t('doctors.orders') }]}
                  valueFormat={(v) => f.number(v)}
                  labelWidth={170}
                />
              </Card>
              <DataTable
                dense
                columns={columns}
                data={d.items}
                getRowId={(r) => r.doctorId ?? 'walk-in'}
                maxHeight="60vh"
                empty={{ title: t('doctors.referrals.empty') }}
              />
            </div>
          ) : (
            <Card>
              <EmptyState icon={Stethoscope} title={t('doctors.referrals.empty')} description={t('doctors.referrals.emptyHint')} />
            </Card>
          )}
        </ChartFrame>
      ) : data.error ? (
        <Card>
          <ErrorState error={data.error} onRetry={() => void data.refetch()} />
        </Card>
      ) : null}
    </div>
  );
}
