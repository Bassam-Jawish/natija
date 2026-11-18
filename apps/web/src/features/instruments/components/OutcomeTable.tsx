import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ExternalLink } from 'lucide-react';
import type { IngestItem, InstrumentMappingItem } from '@natija/contracts';
import { useBi } from '@/lib/i18n';
import { Badge, DataTable, FlagChip, type ColumnDef, type Tone } from '@/components/ui';
import { Code } from './common';

const OUTCOME_TONE: Record<IngestItem['outcome'], Tone> = { applied: 'ok', qc: 'info', review: 'warn', locked: 'warn', skipped: 'muted' };

export function OutcomeChip({ item }: { item: Pick<IngestItem, 'outcome' | 'reason' | 'qcStatus'> }) {
  const { t } = useTranslation('instruments');
  const label =
    item.outcome === 'review' || item.outcome === 'locked'
      ? `${t(`outcome.${item.outcome}`)} · ${t(`reasons.${item.reason}`, { defaultValue: item.reason ?? '' })}`
      : item.outcome === 'skipped'
        ? `${t('outcome.skipped')} · ${t(`reasons.${item.reason}`, { defaultValue: item.reason ?? '' })}`
        : item.outcome === 'qc'
          ? `${t('outcome.qc')}${item.qcStatus ? ` · ${t(`common:status.qc.${item.qcStatus}`)}` : ''}`
          : t('outcome.applied');
  const tone = item.outcome === 'qc' && item.qcStatus === 'rejected' ? 'crit' : OUTCOME_TONE[item.outcome];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

/**
 * One row per value: instrument code → lab analyte (from the code map), the value as sent and
 * as written after unit conversion, the lab's flag, and what happened to it.
 */
export function OutcomeTable({ items, mappings, linkOrders = true }: { items: IngestItem[]; mappings?: InstrumentMappingItem[]; linkOrders?: boolean }) {
  const { t } = useTranslation('instruments');
  const bi = useBi();
  const byCode = useMemo(() => new Map((mappings ?? []).map((m) => [m.instrumentCode, m])), [mappings]);
  const columns = useMemo<ColumnDef<IngestItem>[]>(
    () => [
      { id: 'sample', header: t('outcome.col.sample'), accessorKey: 'sampleId', cell: ({ row }) => <Code>{row.original.sampleId || '—'}</Code> },
      {
        id: 'mapping',
        header: t('outcome.col.mapping'),
        accessorKey: 'code',
        cell: ({ row }) => {
          const it = row.original;
          const map = byCode.get(it.code);
          return (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Code className="rounded bg-sunken px-1">{it.code}</Code>
              <ArrowRight className="size-3 text-faint rtl:rotate-180" />
              {it.analyteCode || map ? (
                <span className="inline-flex items-baseline gap-1">
                  <Code className="font-semibold">{it.analyteCode ?? map!.analyte.code}</Code>
                  {map ? <span className="text-[12px] text-muted">{bi(map.analyte, 'name')}</span> : null}
                  {map && map.unitFactor !== 1 ? <Code className="text-[11px] text-muted">×{map.unitFactor}</Code> : null}
                </span>
              ) : (
                <span className="text-[12px] text-warn">{t('outcome.notMapped')}</span>
              )}
            </span>
          );
        },
      },
      {
        id: 'value',
        header: t('outcome.col.received'),
        cell: ({ row }) => (
          <Code>
            {row.original.value || '—'}
            {row.original.unit ? <span className="ms-1 text-muted">{row.original.unit}</span> : null}
          </Code>
        ),
      },
      {
        id: 'written',
        header: t('outcome.col.written'),
        cell: ({ row }) => {
          const it = row.original;
          return (
            <span className="inline-flex items-center gap-1.5">
              <Code>{it.convertedValue ?? '—'}</Code>
              <FlagChip flag={it.flag} critical={it.isCritical} />
              {it.isCritical ? <Badge tone="crit">{t('outcome.critical')}</Badge> : null}
            </span>
          );
        },
      },
      { id: 'outcome', header: t('outcome.col.outcome'), cell: ({ row }) => <OutcomeChip item={row.original} /> },
      ...(linkOrders
        ? [
            {
              id: 'order',
              header: '',
              cell: ({ row }: { row: { original: IngestItem } }) =>
                row.original.orderId ? (
                  <Link to={`/orders/${row.original.orderId}`} className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
                    {t('outcome.openOrder')}
                    <ExternalLink className="size-3" />
                  </Link>
                ) : null,
            } satisfies ColumnDef<IngestItem>,
          ]
        : []),
    ],
    [t, bi, byCode, linkOrders],
  );
  return <DataTable dense columns={columns} data={items} empty={{ title: t('outcome.empty') }} maxHeight="420px" />;
}
