import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Plus, RotateCcw } from 'lucide-react';
import type { OrderListItem } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import {
  Badge,
  Button,
  Combobox,
  DataTable,
  DateRangePicker,
  PageHeader,
  SearchInput,
  Select,
  StatusChip,
  Switch,
  useTodayRange,
  type ColumnDef,
} from '@/components/ui';
import { fd, keys, useFormData } from '../api';
import { useDoctorOptions } from '../components/OrderDetailsFields';
import { Accession, AgeText, CriticalBadge, DailyNo, LinkButton, SexText, usePatientName } from '../components/shared';

const LIMIT = 50;
const ALL = 'all';

/** Today's orders by default; search, filter and open one. Filters live in the address bar. */
export default function OrdersPage() {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const name = usePatientName();
  const navigate = useNavigate();
  const today = useTodayRange();
  const [sp, setSp] = useSearchParams();
  const { data: form } = useFormData();
  const doctors = useDoctorOptions(form);

  const get = (k: string) => sp.get(k) ?? '';
  const from = sp.get('from') ?? today.from;
  const to = sp.get('to') ?? today.to;
  const offset = Number(sp.get('offset') ?? 0) || 0;
  const [qInput, setQInput] = useState(get('q'));
  const q = useDebounced(qInput.trim(), 300);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '' || v === ALL) next.delete(k);
      else next.set(k, v);
    }
    if (!('offset' in patch)) next.delete('offset');
    setSp(next, { replace: true });
  };
  useEffect(() => {
    if (q !== get('q')) update({ q }); // eslint-disable-line react-hooks/exhaustive-deps
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = useMemo(
    () => ({
      // A search looks at every day unless a range was picked on purpose.
      from: q && !sp.get('from') ? undefined : from,
      to: q && !sp.get('to') ? undefined : to,
      q: q || undefined,
      status: get('status') || undefined,
      priority: get('priority') || undefined,
      source: get('source') || undefined,
      payerGroupId: get('payer') || undefined,
      doctorId: get('doctor') || undefined,
      unpaid: get('unpaid') === '1' ? 'true' : undefined,
      limit: LIMIT,
      offset,
    }),
    [sp, q, from, to, offset], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const list = useQuery({ queryKey: keys.orders(params), queryFn: () => fd.orders(params), placeholderData: keepPreviousData });

  const multiDay = !params.from || params.from !== params.to;
  const columns = useMemo<ColumnDef<OrderListItem>[]>(
    () => [
      {
        id: 'no',
        header: t('orders.col.no'),
        accessorKey: 'dailyNo',
        size: 64,
        cell: ({ row }) => <DailyNo value={row.original.dailyNo} size="sm" />,
      },
      {
        id: 'accession',
        header: t('orders.col.accession'),
        accessorKey: 'createdAt',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Accession value={row.original.accession} />
            <span className="text-[12px] text-muted tabular">{multiDay ? f.dateTime(row.original.createdAt) : f.time(row.original.createdAt)}</span>
          </div>
        ),
      },
      {
        id: 'patient',
        header: t('orders.col.patient'),
        accessorFn: (o) => name(o.patient),
        cell: ({ row }) => {
          const p = row.original.patient;
          return (
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-ink">{name(p)}</span>
              <span className="text-[12px] text-muted">
                <SexText sex={p.sex} /> · <AgeText birthDate={p.birthDate} estimated={p.birthDateEstimated} /> · <span className="font-mono ltr-num">{p.mrn}</span>
              </span>
            </div>
          );
        },
      },
      {
        id: 'tests',
        header: t('orders.col.tests'),
        enableSorting: false,
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="flex max-w-[260px] items-center gap-1.5">
              <span className="truncate font-mono text-[12px] text-ink-2 ltr-num" title={o.testCodes.join(' · ')}>
                {o.testCodes.join(' · ')}
              </span>
              {o.testCount > 1 ? <Badge tone="muted">{o.testCount}</Badge> : null}
            </div>
          );
        },
      },
      {
        id: 'status',
        header: t('orders.col.status'),
        accessorKey: 'status',
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <StatusChip kind="order" status={row.original.status} />
            {row.original.priority !== 'routine' ? <StatusChip kind="priority" status={row.original.priority} /> : null}
            {row.original.hasCritical ? <CriticalBadge /> : null}
          </div>
        ),
      },
      {
        id: 'payer',
        header: t('orders.col.payer'),
        accessorFn: (o) => bi(o.payer),
        cell: ({ row }) => <span className="text-[12.5px] text-ink-2">{bi(row.original.payer)}</span>,
      },
      {
        id: 'balance',
        header: t('orders.col.balance'),
        accessorKey: 'balance',
        meta: { align: 'end' },
        cell: ({ row }) => <BalanceCell o={row.original} />,
      },
    ],
    [t, f, bi, name, multiDay],
  );

  const reset = () => {
    setQInput('');
    setSp(new URLSearchParams(), { replace: true });
  };
  const filtered = [...sp.keys()].some((k) => k !== 'offset');

  return (
    <>
      <PageHeader
        title={t('orders.title')}
        description={t('orders.description')}
        actions={
          can('orders.create') ? (
            <LinkButton to="/reception" variant="primary">
              <Plus />
              {t('orders.new')}
            </LinkButton>
          ) : null
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={qInput} onChange={setQInput} placeholder={t('orders.search')} className="w-72" />
        <DateRangePicker value={{ from, to }} onChange={(r) => update({ from: r.from, to: r.to })} />
        <Select
          size="sm"
          className="w-40"
          value={get('status') || ALL}
          onValueChange={(v) => update({ status: v })}
          options={[{ value: ALL, label: t('orders.allStatuses') }, ...(['registered', 'collected', 'in_progress', 'partial', 'completed', 'delivered', 'cancelled'] as const).map((s) => ({ value: s, label: t(`common:status.order.${s}`) }))]}
        />
        <Select
          size="sm"
          className="w-32"
          value={get('priority') || ALL}
          onValueChange={(v) => update({ priority: v })}
          options={[{ value: ALL, label: t('orders.allPriorities') }, ...(['routine', 'urgent', 'stat'] as const).map((p) => ({ value: p, label: t(`common:status.priority.${p}`) }))]}
        />
        <Select
          size="sm"
          className="w-36"
          value={get('source') || ALL}
          onValueChange={(v) => update({ source: v })}
          options={[{ value: ALL, label: t('orders.allSources') }, ...(['walk_in', 'referral', 'client_lab', 'home'] as const).map((s) => ({ value: s, label: t(`order.sources.${s}`) }))]}
        />
        <Select
          size="sm"
          className="w-48"
          value={get('payer') || ALL}
          onValueChange={(v) => update({ payer: v })}
          options={[{ value: ALL, label: t('orders.allPayers') }, ...(form?.payerGroups ?? []).map((p) => ({ value: p.id, label: bi(p) }))]}
        />
        <Combobox className="h-8 w-48" clearable value={get('doctor') || null} onChange={(v) => update({ doctor: v })} options={doctors} placeholder={t('orders.allDoctors')} />
        <Switch checked={get('unpaid') === '1'} onCheckedChange={(v) => update({ unpaid: v ? '1' : null })} label={t('orders.unpaidOnly')} />
        {filtered ? (
          <Button size="sm" variant="ghost" onClick={reset}>
            <RotateCcw />
            {t('common:actions.reset')}
          </Button>
        ) : null}
      </div>
      {q && !sp.get('from') ? <p className="mb-2 text-[12.5px] text-muted">{t('orders.searchAllDates')}</p> : null}
      <DataTable
        columns={columns}
        data={list.data?.items}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        getRowId={(o) => o.id}
        onRowClick={(o) => navigate(`/orders/${o.id}`)}
        rowClassName={(o) => (o.status === 'cancelled' ? 'opacity-60' : o.priority === 'stat' && o.status === 'registered' ? 'bg-crit-soft/40' : undefined)}
        empty={{
          icon: ClipboardList,
          title: t('orders.empty'),
          description: filtered ? t('orders.emptyFiltered') : t('orders.emptyToday'),
          action: can('orders.create') ? (
            <LinkButton to="/reception" size="sm">
              {t('orders.new')}
            </LinkButton>
          ) : undefined,
        }}
        pagination={{ total: list.data?.total ?? 0, limit: LIMIT, offset, onChange: (o) => update({ offset: String(o) }) }}
        maxHeight="calc(100dvh - 260px)"
      />
    </>
  );
}

function BalanceCell({ o }: { o: OrderListItem }) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  if (o.invoiceStatus === 'void') return <span className="text-muted">—</span>;
  if (o.balance > 0) return <span className="font-medium text-warn tabular ltr-num">{f.money(o.balance)}</span>;
  if (o.balance < 0) return <Badge tone="crit">{t('billing.refundDue')}</Badge>;
  return <Badge tone="ok">{t('billing.settled')}</Badge>;
}
