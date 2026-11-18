import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { InstrumentMappingItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { Badge, DataTable, Drawer, ErrorState, InfoList, Skeleton, StatusChip, type ColumnDef } from '@/components/ui';
import { ins, keys } from '../api';
import { Callout, Code, RawMessage } from './common';
import { OutcomeTable } from './OutcomeTable';
import { ParsedRecords } from './ParsedRecords';

type Attempt = { id: string; resultId: string; analyteCode: string; valueNum: number | null; valueText: string | null; unit: string | null; rawFlag: string | null; createdAt: string };

/** One stored message: raw text with control characters visible, parsed records, outcome, review items and result attempts. */
export function MessageDrawer({ messageId, onClose, mappings }: { messageId: string | null; onClose: () => void; mappings?: InstrumentMappingItem[] }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const q = useQuery({ queryKey: keys.message(messageId ?? ''), queryFn: () => ins.message(messageId!), enabled: !!messageId });
  const m = q.data;
  const attemptColumns: ColumnDef<Attempt>[] = [
    { id: 'analyte', header: t('message.attempt.analyte'), accessorKey: 'analyteCode', cell: ({ row }) => <Code className="font-semibold">{row.original.analyteCode}</Code> },
    {
      id: 'value',
      header: t('message.attempt.value'),
      cell: ({ row }) => (
        <Code>
          {row.original.valueText ?? (row.original.valueNum === null ? '—' : f.number(row.original.valueNum))} <span className="text-muted">{row.original.unit ?? ''}</span>
        </Code>
      ),
    },
    { id: 'flag', header: t('message.attempt.flag'), cell: ({ row }) => <Code>{row.original.rawFlag ?? '—'}</Code> },
    { id: 'at', header: t('message.attempt.at'), cell: ({ row }) => <span className="text-[12.5px] tabular">{f.dateTime(row.original.createdAt)}</span> },
  ];
  return (
    <Drawer open={!!messageId} onOpenChange={(o) => !o && onClose()} width="xl" title={t('message.title')} description={m ? <Code>{m.messageType ?? m.protocol}</Code> : undefined}>
      {q.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : m ? (
        <div className="flex flex-col gap-5">
          <InfoList
            columns={4}
            items={[
              { label: t('message.status'), value: <StatusChip kind="message" status={m.status} /> },
              { label: t('message.received'), value: <span className="tabular">{f.dateTime(m.receivedAt)}</span> },
              { label: t('message.barcode'), value: m.sampleBarcode ? <Code>{m.sampleBarcode}</Code> : '—' },
              { label: t('message.results'), value: <span className="tabular">{m.resultsCount}</span> },
              { label: t('message.controlId'), value: m.controlId ? <Code>{m.controlId}</Code> : '—' },
              { label: t('message.source'), value: m.isSimulated ? <Badge tone="violet">{t('message.simulated')}</Badge> : <Badge tone="info">{t('message.fromAgent')}</Badge> },
              { label: t('message.instrument'), value: <Code>{m.instrument.code}</Code> },
              { label: t('message.processed'), value: <span className="tabular">{f.dateTime(m.processedAt)}</span> },
            ]}
          />
          {m.error ? (
            <Callout tone="crit" title={t('message.errorTitle')}>
              <span dir="ltr" className="font-mono text-[12px]">
                {m.error}
              </span>
            </Callout>
          ) : null}
          <section>
            <h3 className="mb-2 text-[13.5px] font-semibold text-ink">{t('message.raw')}</h3>
            <RawMessage raw={m.raw} />
          </section>
          {m.parsed?.normalized ? (
            <section>
              <h3 className="mb-2 text-[13.5px] font-semibold text-ink">{t('message.parsed')}</h3>
              <ParsedRecords message={m.parsed.normalized} />
            </section>
          ) : null}
          {m.parsed?.items.length ? (
            <section>
              <h3 className="mb-2 text-[13.5px] font-semibold text-ink">{t('message.outcome')}</h3>
              <OutcomeTable items={m.parsed.items} mappings={mappings} />
            </section>
          ) : null}
          {m.reviewItems.length ? (
            <section>
              <h3 className="mb-2 flex items-center justify-between text-[13.5px] font-semibold text-ink">
                {t('message.review')}
                <Link to="/integration/review" className="text-[12.5px] font-medium text-accent hover:underline">
                  {t('message.openQueue')}
                </Link>
              </h3>
              <ul className="flex flex-col gap-1.5">
                {m.reviewItems.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
                    <Badge tone="warn">{t(`reasons.${r.reason}`)}</Badge>
                    <StatusChip kind="review" status={r.status} />
                    <Code>{r.instrumentCode ?? '—'}</Code>
                    <Code className="text-muted">{r.valueText ?? ''}</Code>
                    {r.sampleBarcode ? <Code className="text-muted">{r.sampleBarcode}</Code> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {m.attempts.length ? (
            <section>
              <h3 className="mb-2 text-[13.5px] font-semibold text-ink">{t('message.attempts')}</h3>
              <DataTable dense columns={attemptColumns} data={m.attempts} />
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
