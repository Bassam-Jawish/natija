import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Eye, Send } from 'lucide-react';
import type { BenchDeliveryChannel, BenchDeliveryRow } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import {
  Badge,
  DataTable,
  DateRangePicker,
  PageHeader,
  SearchInput,
  Segmented,
  StatusChip,
  Tooltip,
  useTodayRange,
  type ColumnDef,
  type DateRange,
} from '@/components/ui';
import { benchApi, benchKeys } from '../api';
import { PatientCell, PriorityBadge } from '../components/common';
import { DeliverActions } from '../components/DeliverActions';

const CHANNELS: BenchDeliveryChannel[] = ['print', 'whatsapp', 'sms', 'email', 'portal'];

/** Report hand-over desk: released reports and how each was delivered. */
export default function DeliveryPage() {
  const { t } = useTranslation('bench');
  const f = useFormat();
  const navigate = useNavigate();
  const today = useTodayRange();
  const [range, setRange] = useState<DateRange>(today);
  const [status, setStatus] = useState<'pending' | 'delivered' | 'all'>('pending');
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const [offset, setOffset] = useState(0);
  const params = { from: range.from, to: range.to, status, q: search || undefined, limit: 50, offset };
  const query = useQuery({ queryKey: benchKeys.deliveries(params), queryFn: () => benchApi.deliveries(params) });

  const columns = useMemo<ColumnDef<BenchDeliveryRow>[]>(
    () => [
      {
        id: 'order',
        header: t('table.order'),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="ltr-num font-mono text-[13px]">{row.original.order.accession}</span>
            <PriorityBadge priority={row.original.order.priority} />
          </div>
        ),
      },
      {
        id: 'patient',
        header: t('table.patient'),
        cell: ({ row }) => (
          <div>
            <PatientCell patient={row.original.patient} orderId={row.original.order.id} />
            {row.original.patient.phone ? <div className="ltr-num text-[12px] text-muted">{row.original.patient.phone}</div> : null}
          </div>
        ),
      },
      {
        id: 'report',
        header: t('table.report'),
        cell: ({ row }) => (
          <div className="text-[12.5px]">
            <div className="flex items-center gap-1.5">
              <span className="tabular">{f.time(row.original.report.releasedAt)}</span>
              <Badge tone="neutral" className="h-[20px] text-[11px] ltr-num">
                v{row.original.report.version}
              </Badge>
              {row.original.report.partial ? (
                <Badge tone="warn" className="h-[20px] text-[11px]">
                  {t('delivery.partial')}
                </Badge>
              ) : null}
            </div>
            <div className="text-muted">{f.date(row.original.report.releasedAt)}</div>
          </div>
        ),
      },
      {
        id: 'channels',
        header: t('table.delivered'),
        cell: ({ row }) => {
          const last = row.original.lastByChannel;
          const used = CHANNELS.filter((c) => last[c]);
          return (
            <div className="flex flex-wrap items-center gap-1">
              {used.length ? (
                used.map((c) => (
                  <Tooltip key={c} content={`${t(`delivery.channels.${c}`)} · ${f.dateTime(last[c]!.at)}`}>
                    <Badge tone={last[c]!.status === 'failed' ? 'crit' : last[c]!.status === 'simulated' ? 'info' : 'ok'} className="h-[20px] text-[11px]">
                      {t(`delivery.channels.${c}`)}
                    </Badge>
                  </Tooltip>
                ))
              ) : (
                <span className="text-[12px] text-faint">{t('delivery.notYet')}</span>
              )}
              {row.original.openedAt ? (
                <Tooltip content={f.dateTime(row.original.openedAt)}>
                  <Badge tone="violet" className="h-[20px] text-[11px]">
                    <Eye className="size-3" />
                    {t('delivery.opened')}
                  </Badge>
                </Tooltip>
              ) : null}
            </div>
          );
        },
      },
      { id: 'status', header: t('table.status'), cell: ({ row }) => <StatusChip kind="order" status={row.original.order.status} /> },
      {
        id: 'actions',
        header: '',
        meta: { align: 'end' },
        cell: ({ row }) => (
          <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
            <DeliverActions orderId={row.original.order.id} />
          </div>
        ),
      },
    ],
    [t, f],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('delivery.title')} description={t('delivery.description')} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          options={[
            { value: 'pending', label: t('delivery.status.pending') },
            { value: 'delivered', label: t('delivery.status.delivered') },
            { value: 'all', label: t('delivery.status.all') },
          ]}
        />
        <DateRangePicker
          value={range}
          onChange={(r) => {
            setRange(r);
            setOffset(0);
          }}
        />
        <div className="w-64">
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v);
              setOffset(0);
            }}
            placeholder={t('delivery.search')}
          />
        </div>
      </div>
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        getRowId={(r) => r.order.id}
        onRowClick={(r) => navigate(`/orders/${r.order.id}`)}
        empty={{ title: t('delivery.empty'), description: t('delivery.emptyHint'), icon: Send }}
        pagination={query.data ? { total: query.data.total, limit: 50, offset, onChange: setOffset } : undefined}
      />
      <p className="text-[12px] text-muted">{t('delivery.whatsappNote')}</p>
    </div>
  );
}
