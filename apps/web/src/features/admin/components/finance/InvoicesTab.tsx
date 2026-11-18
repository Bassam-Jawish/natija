import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { FinanceInvoice } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { DataTable, Money, SearchInput, Select, StatusChip, type ColumnDef, type DateRange } from '@/components/ui';
import { financeKeys, usePayerGroups } from '../../api';
import { Code, usePairName } from '../common';
import { Figure, FigureRow } from '../analytics/shared';

const end = { align: 'end' as const };
const LIMIT = 50;
const STATUSES = ['all', 'due', 'open', 'partial', 'paid', 'void'] as const;

type InvoiceList = { items: FinanceInvoice[]; total: number; sums: { subtotal: number; patientTotal: number; paidTotal: number; due: number } };

export function InvoicesTab({ range, onOpen }: { range: DateRange; onOpen: (id: string) => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const name = usePairName();
  const [params] = useSearchParams();
  const initial = params.get('status');
  const [status, setStatus] = useState<string>(STATUSES.includes(initial as (typeof STATUSES)[number]) ? initial! : 'all');
  const [payerGroupId, setPayer] = useState('all');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const payers = usePayerGroups();
  const filters = { ...range, status: status === 'all' ? undefined : status, payerGroupId: payerGroupId === 'all' ? undefined : payerGroupId, q: term || undefined };
  useEffect(() => setOffset(0), [range.from, range.to, status, payerGroupId, term]);
  const query = useQuery({
    queryKey: financeKeys.invoices({ ...filters, offset }),
    queryFn: () => api.get<InvoiceList>('/finance/invoices', { ...filters, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: ColumnDef<FinanceInvoice, unknown>[] = [
    { header: t('finance.invoice.number'), accessorKey: 'number', cell: ({ row }) => <Code className="whitespace-nowrap">{row.original.number}</Code> },
    { header: t('common.date'), id: 'date', cell: ({ row }) => <span className="tabular text-muted whitespace-nowrap">{f.date(row.original.createdAt)}</span> },
    {
      header: t('finance.invoice.patient'),
      id: 'patient',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate">{name(row.original.patientNameAr, row.original.patientNameEn)}</div>
          <div className="font-mono text-[11.5px] whitespace-nowrap text-muted ltr-num">{row.original.accession}</div>
        </div>
      ),
    },
    { header: t('finance.invoice.payer'), id: 'payer', cell: ({ row }) => <span className="text-ink-2">{bi({ nameAr: row.original.payerNameAr, nameEn: row.original.payerNameEn }, 'name')}</span> },
    { header: t('finance.invoice.patientShare'), accessorKey: 'patientTotal', meta: end, cell: ({ row }) => <Money value={row.original.patientTotal} /> },
    {
      header: t('finance.invoice.payerShare'),
      accessorKey: 'insurerTotal',
      meta: end,
      cell: ({ row }) => (row.original.insurerTotal ? <Money value={row.original.insurerTotal} /> : <span className="text-faint">—</span>),
    },
    { header: t('finance.invoice.paid'), accessorKey: 'paidTotal', meta: end, cell: ({ row }) => <Money value={row.original.paidTotal} className="text-muted" /> },
    {
      header: t('finance.invoice.balance'),
      accessorKey: 'balance',
      meta: end,
      cell: ({ row }) => {
        const b = row.original.balance;
        return b === 0 ? <span className="text-faint">—</span> : <Money value={b} className={b > 0 ? 'font-semibold text-warn' : 'font-semibold text-crit'} />;
      },
    },
    { header: t('common.status'), id: 'status', cell: ({ row }) => <StatusChip kind="invoice" status={row.original.status} /> },
  ];
  const sums = query.data?.sums;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={t('finance.invoices.search')} className="w-[300px]" />
        <Select
          size="sm"
          value={status}
          onValueChange={setStatus}
          className="w-44"
          options={STATUSES.map((s) => ({ value: s, label: t(`finance.invoices.status.${s}`) }))}
        />
        <Select
          size="sm"
          value={payerGroupId}
          onValueChange={setPayer}
          className="w-60"
          options={[{ value: 'all', label: t('finance.invoices.allPayers') }, ...(payers.data ?? []).map((p) => ({ value: p.id, label: bi(p, 'name') }))]}
        />
      </div>
      {sums ? (
        <FigureRow cols={4}>
          <Figure label={t('finance.invoices.count')} value={f.number(query.data!.total)} />
          <Figure label={t('finance.invoices.billed')} value={f.money(sums.subtotal)} />
          <Figure label={t('finance.invoices.patientTotal')} value={f.money(sums.patientTotal)} hint={t('finance.invoices.paidHint', { amount: f.money(sums.paidTotal) })} />
          <Figure label={t('finance.invoices.due')} value={f.money(sums.due)} tone={sums.due > 0 ? 'warn' : undefined} />
        </FigureRow>
      ) : null}
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={(r) => onOpen(r.id)}
        getRowId={(r) => r.id}
        dense
        empty={{ title: t('finance.invoices.none') }}
        pagination={query.data ? { total: query.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
    </div>
  );
}
