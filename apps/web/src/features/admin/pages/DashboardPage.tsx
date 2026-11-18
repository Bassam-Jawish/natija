import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Banknote, ClipboardList, FlaskConical, HandCoins, Users } from 'lucide-react';
import type { AnalyticsDashboard } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth, useLab } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { cn } from '@/lib/utils';
import { Card, ErrorState, PageHeader, Skeleton, StatTile } from '@/components/ui';
import { dashboardKey } from '../api';
import { BarList, ChartFrame, ColumnChart, LineChart } from '../components/charts';
import { FilterBar, usePairName, useRangeParam } from '../components/common';
import { CriticalsPanel, InstrumentsStrip, OverduePanel, RejectionsPanel, TurnaroundPanel } from '../components/dashboard/Panels';
import { Pipeline } from '../components/dashboard/Pipeline';

const pad = (h: number) => String(h).padStart(2, '0');

export default function DashboardPage() {
  const { t } = useTranslation('admin');
  const lab = useLab();
  const bi = useBi();
  const f = useFormat();
  const name = usePairName();
  const live = useLive();
  const { can } = useAuth();
  const [range, setRange] = useRangeParam(0);
  const query = useQuery({
    queryKey: dashboardKey(range),
    queryFn: () => api.get<AnalyticsDashboard>('/analytics/dashboard', range),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const d = query.data;
  const isToday = range.from === range.to && range.to === f.today();

  return (
    <div>
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description', { lab: bi(lab, 'name') })}
        meta={
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
            <span className={cn('size-2 rounded-full', live.connected ? 'bg-ok' : 'bg-faint')} />
            {live.connected ? t('dashboard.live') : t('dashboard.notLive')}
            {query.dataUpdatedAt ? ` · ${t('dashboard.updated', { time: f.time(query.dataUpdatedAt) })}` : null}
          </span>
        }
      />
      <FilterBar range={range} onRange={setRange} />

      {query.error && !d ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {!d && !query.error ? <DashboardSkeleton /> : null}

      {d ? (
        <ChartFrame fetching={query.isPlaceholderData} className="flex flex-col gap-4">
          <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', d.money ? 'xl:grid-cols-5' : 'xl:grid-cols-3')}>
            <StatTile
              label={t('dashboard.kpi.patients')}
              value={f.number(d.kpis.patients)}
              hint={t('dashboard.kpi.newPatients', { count: d.kpis.newPatients, n: f.number(d.kpis.newPatients) })}
              icon={Users}
              tone="accent"
              to={can('patients.read') ? '/patients' : undefined}
            />
            <StatTile label={t('dashboard.kpi.orders')} value={f.number(d.kpis.orders)} icon={ClipboardList} tone="info" to={can('orders.read') ? '/orders' : undefined} />
            <StatTile
              label={t('dashboard.kpi.tests')}
              value={f.number(d.kpis.tests)}
              hint={d.kpis.orders ? t('dashboard.kpi.perOrder', { n: f.number(d.kpis.tests / d.kpis.orders, 1) }) : undefined}
              icon={FlaskConical}
              tone="violet"
            />
            {d.money ? (
              <>
                <StatTile
                  label={t('dashboard.kpi.revenue')}
                  value={f.money(d.money.revenue)}
                  hint={t('dashboard.kpi.collected', { amount: f.money(d.money.collected) })}
                  icon={Banknote}
                  tone="ok"
                  to={can('finance.read') ? '/finance/invoices' : undefined}
                />
                <StatTile
                  label={t('dashboard.kpi.outstanding')}
                  value={f.money(d.money.outstanding)}
                  hint={t('dashboard.kpi.insurer', { amount: f.money(d.money.insurer) })}
                  icon={HandCoins}
                  tone={d.money.outstanding > 0 ? 'warn' : 'muted'}
                  to={can('finance.read') ? '/finance/invoices?status=due' : undefined}
                />
              </>
            ) : null}
          </div>

          <Pipeline wip={d.wip} />

          <div className="grid gap-4 xl:grid-cols-3">
            <Card title={t('dashboard.charts.ordersByHour')} description={isToday ? t('dashboard.charts.ordersByHourToday') : t('dashboard.charts.ordersByHourRange')} className="xl:col-span-2">
              <ColumnChart
                data={d.ordersByHour}
                x="hour"
                series={[{ key: 'orders', label: t('dashboard.kpi.orders') }]}
                height={210}
                xFormat={(h) => f.number(Number(h))}
                labelFormat={(h) => `${pad(Number(h))}:00 – ${pad(Number(h))}:59`}
                valueFormat={(v) => f.number(v)}
                yWidth={32}
              />
            </Card>
            <CriticalsPanel data={d.criticals} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            {d.revenueDays ? (
              <Card title={t('dashboard.charts.revenue14')} description={t('dashboard.charts.revenue14Hint')} className="xl:col-span-2">
                <LineChart
                  data={d.revenueDays}
                  x="date"
                  series={[
                    { key: 'net', label: t('dashboard.charts.net') },
                    { key: 'collected', label: t('dashboard.charts.collected') },
                  ]}
                  height={220}
                  area={false}
                  xFormat={(v) => f.shortDay(String(v))}
                  labelFormat={(v) => f.date(String(v))}
                  valueFormat={(v) => f.number(v)}
                  yWidth={64}
                />
              </Card>
            ) : (
              <Card title={t('dashboard.charts.testsByDepartment')} className="xl:col-span-2">
                <BarList data={d.testsByDepartment} label={(r) => bi(r, 'name')} series={[{ key: 'tests', label: t('dashboard.kpi.tests') }]} valueFormat={(v) => f.number(v)} />
              </Card>
            )}
            <TurnaroundPanel tat={d.tat} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {d.revenueDays ? (
              <Card title={t('dashboard.charts.testsByDepartment')}>
                {d.testsByDepartment.length ? (
                  <BarList data={d.testsByDepartment} label={(r) => bi(r, 'name')} series={[{ key: 'tests', label: t('dashboard.kpi.tests') }]} valueFormat={(v) => f.number(v)} labelWidth={130} />
                ) : (
                  <NoData />
                )}
              </Card>
            ) : null}
            <Card title={t('dashboard.charts.topTests')}>
              {d.topTests.length ? (
                <BarList data={d.topTests} label={(r) => `${r.code} · ${bi(r, 'name')}`} series={[{ key: 'count', label: t('dashboard.kpi.tests') }]} valueFormat={(v) => f.number(v)} labelWidth={170} />
              ) : (
                <NoData />
              )}
            </Card>
            <Card title={t('dashboard.charts.payerMix')} description={t('dashboard.charts.payerMixHint')}>
              {d.payerMix.length ? (
                <BarList data={d.payerMix} label={(r) => name(r.nameAr, r.nameEn)} series={[{ key: 'orders', label: t('dashboard.kpi.orders') }]} valueFormat={(v) => f.number(v)} labelWidth={170} />
              ) : (
                <NoData />
              )}
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <OverduePanel data={d.overdue} />
            </div>
            <div className="flex flex-col gap-4">
              <InstrumentsStrip data={d.instruments} />
              <RejectionsPanel data={d.rejections} />
            </div>
          </div>
        </ChartFrame>
      ) : null}
    </div>
  );
}

function NoData() {
  const { t } = useTranslation('admin');
  return <p className="py-6 text-center text-[13px] text-muted">{t('dashboard.noData')}</p>;
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-[var(--radius-card)]" />
        ))}
      </div>
      <Skeleton className="h-[120px] rounded-[var(--radius-card)]" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-[290px] rounded-[var(--radius-card)] xl:col-span-2" />
        <Skeleton className="h-[290px] rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}
