import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Info, Mail, MessageCircle, MessageSquareText, RotateCcw } from 'lucide-react';
import type { OutboxList, OutboxMessage } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Button, DataTable, Drawer, InfoList, PageHeader, SearchInput, Segmented, Select, StatusChip, toast, type ColumnDef } from '@/components/ui';
import { outboxKey } from '../api';
import { Code, FilterBar, SectionTitle, useAdminError, useRangeParam } from '../components/common';

const LIMIT = 50;
const CHANNEL_ICON = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail } as const;

export default function MessagesPage() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const { can } = useAuth();
  const [range, setRange] = useRangeParam(6);
  const [channel, setChannel] = useState<'all' | 'sms' | 'whatsapp' | 'email'>('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<OutboxMessage | null>(null);
  useEffect(() => setOffset(0), [range.from, range.to, channel, status, term]);
  const filters = { ...range, channel: channel === 'all' ? undefined : channel, status: status === 'all' ? undefined : status, q: term || undefined };
  const query = useQuery({
    queryKey: outboxKey({ ...filters, offset }),
    queryFn: () => api.get<OutboxList>('/outbox', { ...filters, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/outbox/${id}/retry`),
    onSuccess: () => {
      toast.success(t('messages.requeued'));
      setOpen(null);
      void qc.invalidateQueries({ queryKey: ['outbox'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const counts = query.data?.counts;
  const columns: ColumnDef<OutboxMessage, unknown>[] = [
    { header: t('messages.created'), id: 'at', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.dateTime(row.original.createdAt)}</span> },
    {
      header: t('messages.channel'),
      id: 'channel',
      cell: ({ row }) => {
        const Icon = CHANNEL_ICON[row.original.channel];
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Icon className="size-4 text-muted" />
            {t(`messages.channels.${row.original.channel}`)}
          </span>
        );
      },
    },
    { header: t('messages.to'), id: 'to', cell: ({ row }) => <Code className="text-ink">{row.original.toAddress}</Code> },
    {
      header: t('messages.message'),
      id: 'body',
      cell: ({ row }) => (
        <div className="max-w-[420px] min-w-0">
          {row.original.subject ? <div className="truncate font-medium text-ink">{row.original.subject}</div> : null}
          <div className="truncate text-ink-2">{row.original.body}</div>
        </div>
      ),
    },
    {
      header: t('messages.order'),
      id: 'order',
      cell: ({ row }) =>
        row.original.orderId && row.original.accession ? (
          <Link to={`/orders/${row.original.orderId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[12.5px] text-accent ltr-num hover:underline">
            {row.original.accession}
          </Link>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { header: t('common.status'), id: 'status', cell: ({ row }) => <StatusChip kind="outbox" status={row.original.status} /> },
  ];
  return (
    <div>
      <PageHeader title={t('messages.title')} description={t('messages.description')} />
      {query.data && !query.data.providerConfigured ? (
        <div className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-info/30 bg-info-soft px-4 py-3" role="note">
          <Info className="mt-0.5 size-5 shrink-0 text-info" />
          <div className="text-[13px]">
            <div className="font-semibold text-info">{t('messages.simulatedTitle')}</div>
            <div className="text-ink-2">{t('messages.simulatedBody')}</div>
          </div>
        </div>
      ) : null}
      <FilterBar range={range} onRange={setRange}>
        <Segmented
          size="sm"
          value={channel}
          onChange={setChannel}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'whatsapp', label: t('messages.channels.whatsapp') },
            { value: 'sms', label: t('messages.channels.sms') },
            { value: 'email', label: t('messages.channels.email') },
          ]}
        />
        <Select
          size="sm"
          value={status}
          onValueChange={setStatus}
          className="w-44"
          options={[
            { value: 'all', label: t('messages.allStatuses') },
            ...(['pending', 'simulated', 'sent', 'failed'] as const).map((s) => ({
              value: s,
              label: t(`status.outbox.${s}`, { ns: 'common' }),
              hint: counts ? f.number(counts[s] ?? 0) : undefined,
            })),
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder={t('messages.search')} className="h-8 w-60" />
      </FilterBar>
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={setOpen}
        getRowId={(r) => r.id}
        dense
        empty={{ title: t('messages.none'), description: t('messages.noneHint') }}
        pagination={query.data ? { total: query.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
      <Drawer
        open={!!open}
        onOpenChange={(o) => !o && setOpen(null)}
        width="md"
        title={open ? t(`messages.channels.${open.channel}`) : ''}
        description={open ? f.dateTime(open.createdAt) : undefined}
        footer={
          open && open.status === 'failed' && can('settings.manage') ? (
            <Button variant="primary" loading={retry.isPending} onClick={() => retry.mutate(open.id)}>
              <RotateCcw />
              {t('messages.retry')}
            </Button>
          ) : null
        }
      >
        {open ? (
          <div className="flex flex-col gap-5">
            <InfoList
              columns={2}
              items={[
                { label: t('messages.to'), value: <Code className="text-ink">{open.toAddress}</Code> },
                { label: t('common.status'), value: <StatusChip kind="outbox" status={open.status} /> },
                { label: t('messages.provider'), value: open.provider ?? '—' },
                { label: t('messages.attempts'), value: f.number(open.attempts) },
                { label: t('messages.sentAt'), value: open.sentAt ? f.dateTime(open.sentAt) : '—' },
                { label: t('messages.order'), value: open.accession ? <Code>{open.accession}</Code> : '—' },
              ]}
            />
            {open.lastError ? (
              <section>
                <SectionTitle>{t('messages.error')}</SectionTitle>
                <pre className="rounded-md bg-crit-soft p-2 font-mono text-[11.5px] whitespace-pre-wrap text-crit" dir="ltr">
                  {open.lastError}
                </pre>
              </section>
            ) : null}
            <section>
              <SectionTitle>{t('messages.message')}</SectionTitle>
              {open.subject ? <div className="mb-1 font-medium text-ink">{open.subject}</div> : null}
              <p className="rounded-lg border border-line bg-sunken p-3 text-[13.5px] whitespace-pre-wrap text-ink" dir="auto">
                {open.body}
              </p>
            </section>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
