import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { IntegrationEventItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { Badge, DataTable, Segmented, type ColumnDef, type Tone } from '@/components/ui';
import { ins, keys } from '../api';

const LIMIT = 50;
const LEVEL_TONE: Record<IntegrationEventItem['level'], Tone> = { info: 'info', warn: 'warn', error: 'crit' };

/** The integration log: connections, messages, duplicates, refusals, offline, QC. */
export function EventsPanel({ instrumentId }: { instrumentId: string }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const [level, setLevel] = useState<'all' | IntegrationEventItem['level']>('all');
  const [offset, setOffset] = useState(0);
  const params = useMemo(() => ({ level: level === 'all' ? undefined : level, limit: LIMIT, offset }), [level, offset]);
  const q = useQuery({ queryKey: keys.events(instrumentId, params), queryFn: () => ins.events(instrumentId, params), placeholderData: keepPreviousData });
  const columns = useMemo<ColumnDef<IntegrationEventItem>[]>(
    () => [
      { id: 'at', header: t('events.col.at'), cell: ({ row }) => <span className="text-[12.5px] whitespace-nowrap tabular">{f.dateTime(row.original.at)}</span> },
      {
        id: 'level',
        header: t('events.col.level'),
        cell: ({ row }) => (
          <Badge tone={LEVEL_TONE[row.original.level]} dot>
            {t(`events.levels.${row.original.level}`)}
          </Badge>
        ),
      },
      { id: 'event', header: t('events.col.event'), cell: ({ row }) => <span className="font-medium">{t(`events.names.${row.original.event}`, { defaultValue: row.original.event })}</span> },
      {
        id: 'detail',
        header: t('events.col.detail'),
        cell: ({ row }) => (
          <span dir="ltr" className="block max-w-[640px] text-start text-[12.5px] text-ink-2">
            {row.original.detail ?? ''}
          </span>
        ),
      },
    ],
    [t, f],
  );
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        size="sm"
        value={level}
        onChange={(v) => {
          setLevel(v);
          setOffset(0);
        }}
        options={[
          { value: 'all', label: t('events.all') },
          { value: 'info', label: t('events.levels.info') },
          { value: 'warn', label: t('events.levels.warn') },
          { value: 'error', label: t('events.levels.error') },
        ]}
      />
      <DataTable
        dense
        columns={columns}
        data={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={{ title: t('events.empty') }}
        pagination={q.data ? { total: q.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
    </div>
  );
}
