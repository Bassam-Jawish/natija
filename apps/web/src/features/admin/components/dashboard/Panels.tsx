import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BellRing, CheckCircle2, Cpu, Timer } from 'lucide-react';
import type { AnalyticsDashboard } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, DataTable, EmptyState, FlagChip, StatusChip, type ColumnDef } from '@/components/ui';
import { usePairName, useMinutes } from '../common';

/* ------------------------------------------------------------------ critical results */

export function CriticalsPanel({ data }: { data: AnalyticsDashboard['criticals'] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const { can } = useAuth();
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <BellRing className={cn('size-4', data.count ? 'text-crit' : 'text-muted')} />
          {t('dashboard.criticals.title')}
          {data.count ? <Badge tone="crit">{f.number(data.count)}</Badge> : null}
        </span>
      }
      description={t('dashboard.criticals.description')}
      actions={
        can('results.validate') && data.count ? (
          <Button asChild variant="ghost" size="sm">
            <Link to="/validation">{t('dashboard.criticals.open')}</Link>
          </Button>
        ) : null
      }
      padded={false}
      className="flex flex-col"
    >
      {data.items.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={t('dashboard.criticals.none')} className="py-8" />
      ) : (
        <ul className="max-h-[300px] divide-y divide-line overflow-y-auto">
          {data.items.map((c) => (
            <li key={c.resultId}>
              <Link to={`/orders/${c.orderId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken/60">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">{name(c.patientNameAr, c.patientNameEn)}</div>
                  <div className="flex items-center gap-2 text-[12px] text-muted">
                    <span className="font-mono ltr-num">{c.accession}</span>
                    <span>·</span>
                    <span>{f.relative(c.at)}</span>
                  </div>
                </div>
                <div className="text-end">
                  <div className="text-[12px] text-muted">{name(c.analyteNameAr, c.analyteNameEn)}</div>
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="font-semibold text-crit tabular ltr-num">
                      {c.value} {c.unit ?? ''}
                    </span>
                    <FlagChip flag={c.flag} critical />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ turnaround */

export function TurnaroundPanel({ tat }: { tat: AnalyticsDashboard['tat'] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const minutes = useMinutes();
  const pct = tat.onTimePct;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Timer className="size-4 text-muted" />
          {t('dashboard.tat.title')}
        </span>
      }
      description={t('dashboard.tat.description', { count: tat.count })}
    >
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[12px] text-muted">{t('dashboard.tat.median')}</div>
          <div className="text-[20px] font-semibold text-ink">{minutes(tat.median)}</div>
        </div>
        <div>
          <div className="text-[12px] text-muted">{t('dashboard.tat.p90')}</div>
          <div className="text-[20px] font-semibold text-ink">{minutes(tat.p90)}</div>
        </div>
        <div>
          <div className="text-[12px] text-muted">{t('dashboard.tat.onTime')}</div>
          <div className={cn('text-[20px] font-semibold', pct === null ? 'text-faint' : pct >= 90 ? 'text-ok' : pct >= 75 ? 'text-warn' : 'text-crit')}>{f.percent(pct, 0)}</div>
        </div>
      </div>
      {tat.byDepartment.length ? (
        <table className="mt-4 w-full text-[12.5px]">
          <thead>
            <tr className="text-muted">
              <th className="pb-1.5 text-start font-medium">{t('dashboard.tat.department')}</th>
              <th className="pb-1.5 text-end font-medium">{t('dashboard.tat.median')}</th>
              <th className="pb-1.5 text-end font-medium">{t('dashboard.tat.p90')}</th>
              <th className="pb-1.5 text-end font-medium">{t('dashboard.tat.onTimeShort')}</th>
            </tr>
          </thead>
          <tbody>
            {tat.byDepartment.map((d) => (
              <tr key={d.departmentId} className="border-t border-line">
                <td className="py-1.5 text-ink-2">{bi(d, 'name')}</td>
                <td className="py-1.5 text-end tabular">{minutes(d.median)}</td>
                <td className="py-1.5 text-end tabular">{minutes(d.p90)}</td>
                <td className="py-1.5 text-end tabular ltr-num">{f.percent(d.onTimePct, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-4 text-[12.5px] text-muted">{t('dashboard.tat.empty')}</p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ overdue tests */

type Overdue = AnalyticsDashboard['overdue']['items'][number];

export function OverduePanel({ data }: { data: AnalyticsDashboard['overdue'] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const minutes = useMinutes();
  const columns: ColumnDef<Overdue, unknown>[] = [
    {
      header: t('dashboard.overdue.order'),
      accessorKey: 'accession',
      cell: ({ row }) => (
        <Link to={`/orders/${row.original.orderId}`} className="font-mono text-[12.5px] text-accent ltr-num hover:underline">
          {row.original.accession}
        </Link>
      ),
    },
    { header: t('dashboard.overdue.patient'), id: 'patient', cell: ({ row }) => <span className="truncate">{name(row.original.patientNameAr, row.original.patientNameEn)}</span> },
    {
      header: t('dashboard.overdue.test'),
      id: 'test',
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[12px] text-ink-2 ltr-num">{row.original.testCode}</span>
          {row.original.priority !== 'routine' ? <StatusChip kind="priority" status={row.original.priority} /> : null}
        </span>
      ),
    },
    { header: t('common.status'), id: 'status', cell: ({ row }) => <StatusChip kind="item" status={row.original.status} /> },
    { header: t('dashboard.overdue.due'), id: 'due', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.time(row.original.dueAt)}</span> },
    {
      header: t('dashboard.overdue.late'),
      id: 'late',
      meta: { align: 'end' },
      cell: ({ row }) => <span className="font-medium whitespace-nowrap text-crit tabular">{minutes(row.original.overdueMinutes)}</span>,
    },
  ];
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          {t('dashboard.overdue.title')}
          {data.count ? <Badge tone="warn">{f.number(data.count)}</Badge> : null}
        </span>
      }
      description={t('dashboard.overdue.description')}
      padded={false}
    >
      <DataTable
        columns={columns}
        data={data.items}
        dense
        className="rounded-none border-0"
        empty={{ title: t('dashboard.overdue.none'), icon: CheckCircle2 }}
        getRowId={(r) => r.itemId}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ instruments & rejections */

export function InstrumentsStrip({ data }: { data: AnalyticsDashboard['instruments'] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const { can } = useAuth();
  const online = data.counts.online ?? 0;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Cpu className="size-4 text-muted" />
          {t('dashboard.instruments.title')}
        </span>
      }
      description={t('dashboard.instruments.summary', { online: f.number(online), total: f.number(data.items.length) })}
      actions={
        can('instruments.read') ? (
          <Button asChild variant="ghost" size="sm">
            <Link to="/instruments">{t('dashboard.instruments.open')}</Link>
          </Button>
        ) : null
      }
    >
      {data.items.length === 0 ? (
        <p className="text-[13px] text-muted">{t('dashboard.instruments.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">
                  {i.name} <span className="font-mono text-[11px] font-normal text-muted ltr-num">{i.code}</span>
                </div>
                <div className="text-[11.5px] text-muted">{i.lastMessageAt ? t('dashboard.instruments.last', { when: f.relative(i.lastMessageAt) }) : t('dashboard.instruments.noMessages')}</div>
              </div>
              <StatusChip kind="instrument" status={i.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RejectionsPanel({ data }: { data: AnalyticsDashboard['rejections'] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const max = Math.max(1, ...data.byReason.map((r) => r.count));
  return (
    <Card title={t('dashboard.rejections.title')} description={t('dashboard.rejections.description', { count: data.count })}>
      {data.byReason.length === 0 ? (
        <p className="text-[13px] text-muted">{t('dashboard.rejections.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.byReason.slice(0, 6).map((r) => (
            <li key={r.reasonId ?? 'none'} className="text-[12.5px]">
              <div className="mb-1 flex justify-between gap-2">
                <span className="truncate text-ink-2">{name(r.nameAr, r.nameEn) || t('dashboard.rejections.noReason')}</span>
                <span className="tabular ltr-num text-ink">{f.number(r.count)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-sunken">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(100 * r.count) / max}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
