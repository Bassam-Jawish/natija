import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';
import { REVIEW_REASONS, type ReviewItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Badge, DataTable, PageHeader, SearchInput, Segmented, Select, StatusChip, type ColumnDef } from '@/components/ui';
import { ins, keys } from '../api';
import { Code } from '../components/common';
import { ReviewDrawer } from '../components/ReviewDrawer';

const LIMIT = 50;
const ALL = 'all';

/** Analyzer values that could not be applied automatically. Nothing is dropped silently. */
export default function ReviewQueuePage() {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const [sp, setSp] = useSearchParams();
  const [status, setStatus] = useState<'open' | 'assigned' | 'dismissed' | 'all'>('open');
  const [reason, setReason] = useState(ALL);
  const [instrument, setInstrument] = useState(sp.get('instrument') ?? ALL);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search.trim(), 300);
  const opened = sp.get('item');
  const setOpened = (id: string | null) => {
    const next = new URLSearchParams(sp);
    if (id) next.set('item', id);
    else next.delete('item');
    setSp(next, { replace: true });
  };
  const instruments = useQuery({ queryKey: keys.list, queryFn: ins.list });
  const params = useMemo(
    () => ({ status, reason: reason === ALL ? undefined : reason, instrumentId: instrument === ALL ? undefined : instrument, q: q || undefined, limit: LIMIT, offset }),
    [status, reason, instrument, q, offset],
  );
  const list = useQuery({ queryKey: keys.review(params), queryFn: () => ins.review(params), placeholderData: keepPreviousData });

  const columns = useMemo<ColumnDef<ReviewItem>[]>(
    () => [
      {
        id: 'at',
        header: t('review.col.received'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="tabular">{f.time(row.original.messageReceivedAt ?? row.original.createdAt)}</span>
            <span className="text-[11.5px] text-muted tabular">{f.date(row.original.messageReceivedAt ?? row.original.createdAt)}</span>
          </div>
        ),
      },
      { id: 'reason', header: t('review.col.reason'), cell: ({ row }) => <Badge tone={row.original.reason === 'result_locked' ? 'info' : 'warn'}>{t(`reasons.${row.original.reason}`)}</Badge> },
      {
        id: 'instrument',
        header: t('review.col.instrument'),
        cell: ({ row }) => (
          <span className="flex flex-col">
            <Code className="font-semibold">{row.original.instrument.code}</Code>
            <span className="text-[11.5px] text-muted">{row.original.instrument.name}</span>
          </span>
        ),
      },
      { id: 'barcode', header: t('review.col.barcode'), cell: ({ row }) => <Code>{row.original.sampleBarcode ?? '—'}</Code> },
      { id: 'code', header: t('review.col.code'), cell: ({ row }) => <Code className="font-semibold">{row.original.instrumentCode ?? '—'}</Code> },
      {
        id: 'value',
        header: t('review.col.value'),
        cell: ({ row }) => (
          <Code>
            {row.original.valueText ?? '—'} <span className="text-muted">{row.original.unit ?? ''}</span>
            {row.original.flags && row.original.flags !== 'N' ? <span className="ms-1 text-warn">{row.original.flags}</span> : null}
          </Code>
        ),
      },
      {
        id: 'source',
        header: '',
        cell: ({ row }) => (row.original.isSimulated ? <Badge tone="violet">{t('message.simulated')}</Badge> : null),
      },
      { id: 'status', header: t('review.col.status'), cell: ({ row }) => <StatusChip kind="review" status={row.original.status} /> },
    ],
    [t, f],
  );

  return (
    <div>
      <PageHeader back="/instruments" title={t('review.title')} description={t('review.description')} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          options={[
            { value: 'open', label: t('common:status.review.open') },
            { value: 'assigned', label: t('common:status.review.assigned') },
            { value: 'dismissed', label: t('common:status.review.dismissed') },
            { value: 'all', label: t('review.all') },
          ]}
        />
        <div className="w-52">
          <Select
            value={reason}
            onValueChange={(v) => {
              setReason(v);
              setOffset(0);
            }}
            options={[{ value: ALL, label: t('review.allReasons') }, ...REVIEW_REASONS.map((r) => ({ value: r, label: t(`reasons.${r}`) }))]}
          />
        </div>
        <div className="w-52">
          <Select
            value={instrument}
            onValueChange={(v) => {
              setInstrument(v);
              setOffset(0);
            }}
            options={[{ value: ALL, label: t('review.allInstruments') }, ...(instruments.data ?? []).map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))]}
          />
        </div>
        <div className="w-60">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setOffset(0);
            }}
            placeholder={t('review.search')}
            ltr
          />
        </div>
      </div>
      <DataTable
        columns={columns}
        data={list.data?.items}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => setOpened(r.id)}
        empty={{ icon: CircleCheck, title: status === 'open' ? t('review.emptyOpen') : t('review.empty'), description: status === 'open' ? t('review.emptyOpenHint') : undefined }}
        pagination={list.data ? { total: list.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
      <ReviewDrawer itemId={opened} onClose={() => setOpened(null)} />
    </div>
  );
}
