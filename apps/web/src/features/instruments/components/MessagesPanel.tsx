import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MESSAGE_STATUSES, type IntegrationMessageItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Badge, DataTable, SearchInput, Segmented, Select, StatusChip, type ColumnDef } from '@/components/ui';
import { ins, keys } from '../api';
import { Code } from './common';

const LIMIT = 30;
const ALL = 'all';

/** Messages received for one analyzer, newest first; refreshes live as messages arrive. */
export function MessagesPanel({ instrumentId, onOpen }: { instrumentId: string; onOpen: (id: string) => void }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const [status, setStatus] = useState(ALL);
  const [source, setSource] = useState<'all' | 'real' | 'simulated'>('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const barcode = useDebounced(search.trim(), 300);
  const params = useMemo(
    () => ({
      status: status === ALL ? undefined : status,
      simulated: source === 'all' ? undefined : source === 'simulated' ? 'true' : 'false',
      barcode: barcode || undefined,
      limit: LIMIT,
      offset,
    }),
    [status, source, barcode, offset],
  );
  const q = useQuery({ queryKey: keys.messages(instrumentId, params), queryFn: () => ins.messages(instrumentId, params), placeholderData: keepPreviousData });
  const columns = useMemo<ColumnDef<IntegrationMessageItem>[]>(
    () => [
      {
        id: 'at',
        header: t('messages.col.received'),
        accessorKey: 'receivedAt',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="tabular">{f.time(row.original.receivedAt)}</span>
            <span className="text-[11.5px] text-muted tabular">{f.date(row.original.receivedAt)}</span>
          </div>
        ),
      },
      { id: 'type', header: t('messages.col.type'), cell: ({ row }) => <Code>{row.original.messageType ?? '—'}</Code> },
      { id: 'barcode', header: t('messages.col.barcode'), cell: ({ row }) => <Code>{row.original.sampleBarcode ?? '—'}</Code> },
      { id: 'status', header: t('messages.col.status'), cell: ({ row }) => <StatusChip kind="message" status={row.original.status} /> },
      { id: 'results', header: t('messages.col.results'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular">{row.original.resultsCount}</span> },
      {
        id: 'source',
        header: t('messages.col.source'),
        cell: ({ row }) => (row.original.isSimulated ? <Badge tone="violet">{t('message.simulated')}</Badge> : <Badge tone="info">{t('message.fromAgent')}</Badge>),
      },
      {
        id: 'error',
        header: t('messages.col.error'),
        cell: ({ row }) => {
          const e = row.original.error;
          if (!e) return null;
          // Server errors are technical English; show a translated label, the detail on hover.
          const kind = e.startsWith('Incomplete message') ? 'incomplete' : e.startsWith('Unreadable message') ? 'unreadable' : e.startsWith('Processing failed') ? 'processing' : 'other';
          return (
            <span className="line-clamp-1 max-w-72 text-[12.5px] text-crit" title={e}>
              {t(`messages.errors.${kind}`)}
            </span>
          );
        },
      },
    ],
    [t, f],
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setOffset(0); }} placeholder={t('messages.search')} ltr />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onValueChange={(v) => { setStatus(v); setOffset(0); }}
            options={[{ value: ALL, label: t('messages.allStatuses') }, ...MESSAGE_STATUSES.filter((s) => s !== 'received' && s !== 'duplicate').map((s) => ({ value: s, label: t(`common:status.message.${s}`) }))]}
          />
        </div>
        <Segmented
          size="sm"
          value={source}
          onChange={(v) => { setSource(v); setOffset(0); }}
          options={[
            { value: 'all', label: t('messages.sourceAll') },
            { value: 'real', label: t('messages.sourceReal') },
            { value: 'simulated', label: t('messages.sourceSimulated') },
          ]}
        />
      </div>
      <DataTable
        columns={columns}
        data={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(m) => onOpen(m.id)}
        empty={{ title: t('messages.empty'), description: t('messages.emptyHint') }}
        pagination={q.data ? { total: q.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
    </div>
  );
}
