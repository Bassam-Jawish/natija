import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Banknote, Receipt } from 'lucide-react';
import type { FinanceInvoice, FinanceMethodTotal, FinancePayment } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, DataTable, Money, PageHeader, SearchInput, Segmented, Tabs, TabsContent, TabsList, TabsTrigger, type ColumnDef } from '@/components/ui';
import { financeKeys } from '../api';
import { MethodsCard } from '../components/analytics/BusinessTabs';
import { Code, usePairName, useTabParam } from '../components/common';
import { TakePaymentDialog, type PayTarget } from '../components/finance/dialogs';
import { ExpenseForm } from '../components/finance/ExpenseForm';
import { InvoiceDrawer } from '../components/finance/InvoiceDrawer';
import { SessionCard, useMySession } from '../components/finance/SessionCard';

const end = { align: 'end' as const };

export default function CashierPage() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const { can } = useAuth();
  const session = useMySession();
  const today = f.today();
  const [tab, setTab] = useTabParam(['due', 'payments'] as const, 'due');
  const [mine, setMine] = useState<'mine' | 'all'>('mine');
  const [open, setOpen] = useState<string | null>(null);
  const canRead = can('finance.read');
  const payments = useQuery({
    queryKey: financeKeys.payments({ from: today, to: today, mine }),
    queryFn: () => api.get<{ items: FinancePayment[]; total: number; byMethod: FinanceMethodTotal[] }>('/finance/payments', { from: today, to: today, mine: mine === 'mine', limit: 200 }),
    enabled: canRead,
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader
        title={t('finance.cashier.title')}
        description={t('finance.cashier.description')}
        actions={
          can('finance.read') ? (
            <Button asChild variant="secondary">
              <Link to="/finance/invoices">
                <Receipt />
                {t('finance.cashier.allInvoices')}
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4">
          <SessionCard />
          {canRead ? <MethodsCard methods={payments.data?.byMethod ?? []} title={mine === 'mine' ? t('finance.cashier.byMethodMine') : t('finance.cashier.byMethodAll')} /> : null}
          {can('finance.expenses') ? (
            <Card title={t('finance.cashier.quickExpense')} description={t('finance.cashier.quickExpenseHint')}>
              <ExpenseForm drawer={!!session.data?.session} compact />
            </Card>
          ) : null}
        </div>
        <div className="min-w-0 xl:col-span-2">
          {canRead ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="due">{t('finance.cashier.due')}</TabsTrigger>
                <TabsTrigger value="payments" count={payments.data?.total}>
                  {t('finance.cashier.todayPayments')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="due">
                <DueInvoices onOpen={setOpen} />
              </TabsContent>
              <TabsContent value="payments">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <Segmented
                    size="sm"
                    value={mine}
                    onChange={setMine}
                    options={[
                      { value: 'mine', label: t('finance.cashier.mine') },
                      { value: 'all', label: t('finance.cashier.everyone') },
                    ]}
                  />
                </div>
                <PaymentsTable payments={payments.data?.items} loading={payments.isLoading} error={payments.error} onRetry={() => void payments.refetch()} onOpen={setOpen} />
              </TabsContent>
            </Tabs>
          ) : (
            <Card>
              <p className="text-[13px] text-muted">{t('finance.cashier.noRead')}</p>
            </Card>
          )}
        </div>
      </div>
      <InvoiceDrawer invoiceId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function DueInvoices({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const name = usePairName();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [pay, setPay] = useState<PayTarget | null>(null);
  const query = useQuery({
    queryKey: financeKeys.invoices({ status: 'due', q: term }),
    queryFn: () => api.get<{ items: FinanceInvoice[]; total: number; sums: { due: number } }>('/finance/invoices', { status: 'due', q: term || undefined, limit: 100 }),
    placeholderData: keepPreviousData,
  });
  const columns: ColumnDef<FinanceInvoice, unknown>[] = [
    {
      header: t('finance.invoice.number'),
      accessorKey: 'number',
      cell: ({ row }) => (
        <div className="whitespace-nowrap">
          <Code>{row.original.number}</Code>
          <div className="text-[11.5px] text-muted">{f.dateTime(row.original.createdAt)}</div>
        </div>
      ),
    },
    {
      header: t('finance.invoice.patient'),
      id: 'patient',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate">{name(row.original.patientNameAr, row.original.patientNameEn)}</div>
          <div className="text-[11.5px] text-muted">
            <span className="font-mono ltr-num">{row.original.accession}</span> · {bi({ nameAr: row.original.payerNameAr, nameEn: row.original.payerNameEn }, 'name')}
          </div>
        </div>
      ),
    },
    { header: t('finance.invoice.patientShare'), accessorKey: 'patientTotal', meta: end, cell: ({ row }) => <Money value={row.original.patientTotal} className="text-muted" /> },
    { header: t('finance.invoice.balance'), accessorKey: 'balance', meta: end, cell: ({ row }) => <Money value={row.original.balance} className="font-semibold text-warn" /> },
    {
      id: 'act',
      header: '',
      meta: end,
      cell: ({ row }) =>
        can('finance.payment') ? (
          <Button
            size="sm"
            variant="subtle"
            onClick={(e) => {
              e.stopPropagation();
              const r = row.original;
              setPay({ invoiceId: r.id, orderId: r.orderId, number: r.number, accession: r.accession, patient: name(r.patientNameAr, r.patientNameEn), balance: r.balance });
            }}
          >
            <Banknote />
            {t('finance.pay.action')}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={t('finance.cashier.searchDue')} className="w-[320px]" />
        {query.data ? (
          <div className="text-[13px] text-muted">
            {t('finance.cashier.dueTotal')} <Money value={query.data.sums.due} className="font-semibold text-ink" />
          </div>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={(r) => onOpen(r.id)}
        getRowId={(r) => r.id}
        dense
        maxHeight="64vh"
        empty={{ title: term ? t('finance.cashier.noMatch') : t('finance.cashier.noDue'), description: term ? undefined : t('finance.cashier.noDueHint') }}
      />
      <TakePaymentDialog target={pay} onClose={() => setPay(null)} />
    </>
  );
}

function PaymentsTable({
  payments,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  payments: FinancePayment[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (invoiceId: string) => void;
}) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const name = usePairName();
  const columns: ColumnDef<FinancePayment, unknown>[] = [
    { header: t('common.time'), id: 'time', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.time(row.original.receivedAt)}</span> },
    {
      header: t('finance.invoice.patient'),
      id: 'patient',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate">{name(row.original.patientNameAr, row.original.patientNameEn)}</div>
          <div className="font-mono text-[11.5px] text-muted ltr-num">{row.original.invoiceNumber}</div>
        </div>
      ),
    },
    {
      header: t('fields.methodId'),
      id: 'method',
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          {row.original.kind === 'refund' ? <Badge tone="crit">{t('finance.refund.badge')}</Badge> : null}
          {bi(row.original, 'methodName')}
        </span>
      ),
    },
    { header: t('common.by'), id: 'by', cell: ({ row }) => <span className="text-muted">{name(row.original.receivedByNameAr, row.original.receivedByNameEn)}</span> },
    {
      header: t('common.amount'),
      id: 'amount',
      meta: end,
      cell: ({ row }) => <Money value={row.original.kind === 'refund' ? -row.original.amount : row.original.amount} className={row.original.kind === 'refund' ? 'text-crit' : 'font-medium'} />,
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={payments}
      loading={loading}
      error={error}
      onRetry={onRetry}
      onRowClick={(r) => onOpen(r.invoiceId)}
      getRowId={(r) => r.id}
      dense
      maxHeight="64vh"
      empty={{ title: t('finance.cashier.noPayments') }}
    />
  );
}
