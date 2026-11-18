import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileSpreadsheet } from 'lucide-react';
import type { FinanceInvoice, FinanceStatement } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Card, DataTable, EmptyState, ErrorState, Field, Money, Select, Skeleton, type ColumnDef, type DateRange } from '@/components/ui';
import { financeKeys, usePayerGroups } from '../../api';
import { Code, ExportButton, usePairName } from '../common';
import { Figure, FigureRow } from '../analytics/shared';

const end = { align: 'end' as const };

/** Statement of account for an insurer, client lab or other payer: its invoices and shares for the period. */
export function StatementsTab({ range, onOpen }: { range: DateRange; onOpen: (id: string) => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const name = usePairName();
  const payers = usePayerGroups();
  const choices = useMemo(() => (payers.data ?? []).filter((p) => p.kind !== 'public'), [payers.data]);
  const [payerGroupId, setPayer] = useState('');
  useEffect(() => {
    if (!payerGroupId && choices.length) setPayer(choices.find((p) => p.onAccount)?.id ?? choices[0]!.id);
  }, [choices, payerGroupId]);
  const query = useQuery({
    queryKey: financeKeys.statement({ payerGroupId, ...range }),
    queryFn: () => api.get<FinanceStatement>('/finance/statements', { payerGroupId, ...range }),
    enabled: !!payerGroupId,
    placeholderData: keepPreviousData,
  });
  const st = query.data;
  const columns: ColumnDef<FinanceInvoice, unknown>[] = [
    { header: t('common.date'), id: 'date', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.date(row.original.createdAt)}</span> },
    { header: t('finance.invoice.number'), accessorKey: 'number', cell: ({ row }) => <Code className="whitespace-nowrap">{row.original.number}</Code> },
    { header: t('finance.invoice.order'), accessorKey: 'accession', cell: ({ row }) => <Code>{row.original.accession}</Code> },
    { header: t('finance.invoice.patient'), id: 'patient', cell: ({ row }) => name(row.original.patientNameAr, row.original.patientNameEn) },
    { header: t('finance.invoice.subtotal'), accessorKey: 'subtotal', meta: end, cell: ({ row }) => <Money value={row.original.subtotal} /> },
    { header: t('finance.invoice.discount'), accessorKey: 'discountTotal', meta: end, cell: ({ row }) => (row.original.discountTotal ? <Money value={-row.original.discountTotal} /> : '—') },
    { header: t('finance.invoice.patientShare'), accessorKey: 'patientTotal', meta: end, cell: ({ row }) => <Money value={row.original.patientTotal} /> },
    { header: t('finance.invoice.payerShare'), accessorKey: 'insurerTotal', meta: end, cell: ({ row }) => <Money value={row.original.insurerTotal} className="font-semibold" /> },
  ];
  if (payers.data && choices.length === 0) {
    return <EmptyState icon={FileSpreadsheet} title={t('finance.statements.noPayers')} description={t('finance.statements.noPayersHint')} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t('finance.statements.payer')} className="w-[340px]">
          {(id) => (
            <Select
              id={id}
              value={payerGroupId}
              onValueChange={setPayer}
              options={choices.map((p) => ({ value: p.id, label: bi(p, 'name'), hint: t(`kinds.${p.kind}`) }))}
            />
          )}
        </Field>
        {payerGroupId ? <ExportButton path="/finance/statements/export" query={{ payerGroupId, ...range }} /> : null}
      </div>
      {query.error && !st ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {!st && !query.error ? <Skeleton className="h-64 rounded-[var(--radius-card)]" /> : null}
      {st ? (
        <>
          <Card padded>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[16px] font-semibold text-ink">{bi(st.payer, 'name')}</div>
                <div className="text-[13px] text-muted">
                  {st.payer.organization ? `${st.payer.organization} · ` : ''}
                  {t('finance.statements.period', { from: f.date(st.from), to: f.date(st.to) })}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="neutral">{t(`kinds.${st.payer.kind}`)}</Badge>
                {st.payer.onAccount ? <Badge tone="info">{t('finance.invoice.onAccount')}</Badge> : null}
                <Badge tone="neutral">{t('finance.statements.patientPays', { pct: f.percent(st.payer.patientSharePct, 0) })}</Badge>
              </div>
            </div>
          </Card>
          <FigureRow cols={5}>
            <Figure label={t('finance.statements.invoices')} value={f.number(st.totals.count)} />
            <Figure label={t('finance.invoice.subtotal')} value={f.money(st.totals.subtotal)} hint={st.totals.discountTotal ? t('finance.statements.discountHint', { amount: f.money(st.totals.discountTotal) }) : undefined} />
            <Figure label={t('finance.invoice.patientShare')} value={f.money(st.totals.patientTotal)} hint={t('finance.statements.paidHint', { amount: f.money(st.totals.paidTotal) })} />
            <Figure label={t('finance.statements.payerOwes')} value={f.money(st.totals.insurerTotal)} tone={st.totals.insurerTotal ? 'warn' : undefined} />
            <Figure label={t('finance.statements.patientsOwe')} value={f.money(st.totals.balance)} />
          </FigureRow>
          <DataTable
            columns={columns}
            data={st.invoices}
            dense
            maxHeight="60vh"
            onRowClick={(r) => onOpen(r.id)}
            getRowId={(r) => r.id}
            empty={{ title: t('finance.statements.none') }}
          />
        </>
      ) : null}
    </div>
  );
}
