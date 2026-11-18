import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgePercent, Receipt, Wallet } from 'lucide-react';
import type { InvoiceDetail, InvoiceLineRow, PaymentRow } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { Badge, Button, Card, DataTable, EmptyState, StatusChip, type ColumnDef } from '@/components/ui';
import { DiscountDialog, TakePaymentDialog } from './PaymentDialogs';
import { Notice, SumRow } from './shared';

/** Invoice lines, payments and discount requests of one order, with the desk's money actions. */
export function OrderBilling({ invoice, orderId, cancelled }: { invoice: InvoiceDetail | null; orderId: string; cancelled: boolean }) {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const [paying, setPaying] = useState(false);
  const [discounting, setDiscounting] = useState(false);

  const lineColumns = useMemo<ColumnDef<InvoiceLineRow>[]>(
    () => [
      {
        id: 'test',
        header: t('billing.col.test'),
        cell: ({ row }) => {
          const l = row.original;
          return (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 font-mono text-[12px] font-medium ltr-num">{l.code ?? '—'}</span>
              <span className="truncate">{l.nameAr ? bi(l) : l.description}</span>
              {l.packageCode ? <Badge tone="violet">{l.packageCode}</Badge> : null}
            </div>
          );
        },
      },
      { id: 'units', header: t('billing.col.units'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular">{f.number(row.original.units)}</span> },
      { id: 'price', header: t('billing.col.price'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.money(row.original.price)}</span> },
      {
        id: 'discount',
        header: t('billing.col.discount'),
        meta: { align: 'end' },
        cell: ({ row }) => (row.original.discount ? <span className="text-ok tabular ltr-num">−{f.money(row.original.discount)}</span> : <span className="text-faint">—</span>),
      },
      { id: 'insurer', header: t('billing.col.insurer'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.money(row.original.insurerShare)}</span> },
      { id: 'patient', header: t('billing.col.patient'), meta: { align: 'end' }, cell: ({ row }) => <span className="font-medium tabular ltr-num">{f.money(row.original.patientShare)}</span> },
    ],
    [t, f, bi],
  );

  const paymentColumns = useMemo<ColumnDef<PaymentRow>[]>(
    () => [
      { id: 'at', header: t('billing.col.when'), cell: ({ row }) => <span className="tabular">{f.dateTime(row.original.receivedAt)}</span> },
      {
        id: 'method',
        header: t('billing.col.method'),
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            {bi({ nameAr: row.original.methodNameAr, nameEn: row.original.methodNameEn })}
            {row.original.kind === 'refund' ? <Badge tone="crit">{t('billing.refund')}</Badge> : null}
          </span>
        ),
      },
      { id: 'ref', header: t('billing.col.reference'), cell: ({ row }) => <span className="font-mono text-[12px] ltr-num">{row.original.reference ?? '—'}</span> },
      { id: 'by', header: t('billing.col.by'), cell: ({ row }) => <span className="text-ink-2">{row.original.receivedBy ? bi({ nameAr: row.original.receivedBy.fullNameAr, nameEn: row.original.receivedBy.fullNameEn }) : '—'}</span> },
      {
        id: 'amount',
        header: t('billing.col.amount'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <span className={row.original.kind === 'refund' ? 'text-crit tabular ltr-num' : 'font-medium tabular ltr-num'}>
            {row.original.kind === 'refund' ? '−' : ''}
            {f.money(row.original.amount)}
          </span>
        ),
      },
    ],
    [t, f, bi],
  );

  if (!invoice) return <EmptyState icon={Receipt} title={t('billing.noInvoice')} />;
  const open = invoice.status !== 'void' && !cancelled;
  const base = invoice.subtotal - invoice.discountTotal;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={t('billing.lines')} padded={false}>
          <DataTable columns={lineColumns} data={invoice.lines} dense className="rounded-none border-0" empty={{ title: t('billing.noLines') }} />
        </Card>
        <Card title={t('billing.payments')} padded={false}>
          <DataTable columns={paymentColumns} data={invoice.payments} dense className="rounded-none border-0" empty={{ icon: Wallet, title: t('billing.noPayments') }} />
        </Card>
        {invoice.approvals.length ? (
          <Card title={t('billing.approvals')}>
            <ul className="flex flex-col gap-2">
              {invoice.approvals.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-[13px]">
                  <StatusChip kind="approval" status={a.status} />
                  <span className="font-medium tabular ltr-num">{a.amount !== null ? f.money(a.amount) : '—'}</span>
                  {a.percent !== null ? <span className="text-muted tabular">({f.percent(a.percent, 1)})</span> : null}
                  <span className="min-w-0 flex-1 truncate text-ink-2">{a.reason}</span>
                  <span className="text-[12px] text-muted">
                    {a.requestedBy ? bi({ nameAr: a.requestedBy.fullNameAr, nameEn: a.requestedBy.fullNameEn }) : ''} · {f.dateTime(a.requestedAt)}
                  </span>
                  {a.decisionNote ? <span className="w-full text-[12px] text-muted">{a.decisionNote}</span> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            {t('billing.invoice')}
            <span className="font-mono text-[12.5px] font-normal text-muted ltr-num">{invoice.number}</span>
          </span>
        }
        actions={<StatusChip kind="invoice" status={invoice.status} />}
      >
        <SumRow label={t('billing.payer')}>
          <span className="text-[13px]">{bi(invoice.payer)}</span>
        </SumRow>
        <SumRow label={t('billing.subtotal')}>{f.money(invoice.subtotal)}</SumRow>
        {invoice.discountTotal ? <SumRow label={t('billing.discounts')}>−{f.money(invoice.discountTotal)}</SumRow> : null}
        {invoice.insurerTotal ? <SumRow label={invoice.payer.kind === 'client_lab' ? t('billing.clientShare') : t('billing.insurerShare')}>{f.money(invoice.insurerTotal)}</SumRow> : null}
        <SumRow label={t('billing.patientTotal')}>{f.money(invoice.patientTotal)}</SumRow>
        <SumRow label={t('billing.paid')}>{f.money(invoice.paidTotal)}</SumRow>
        <SumRow label={invoice.balance < 0 ? t('billing.refundDue') : t('billing.balance')} strong className="mt-1 border-t border-line pt-2">
          <span className={invoice.balance > 0 ? 'text-warn' : invoice.balance < 0 ? 'text-crit' : 'text-ok'}>{f.money(Math.abs(invoice.balance))}</span>
        </SumRow>
        {invoice.status === 'void' ? (
          <Notice tone="info" className="mt-3">
            {t('billing.voided', { reason: invoice.voidReason ?? '' })}
          </Notice>
        ) : null}
        <div className="mt-4 flex flex-col gap-2">
          {open && invoice.balance > 0 && can('finance.payment') ? (
            <Button variant="primary" onClick={() => setPaying(true)}>
              <Wallet />
              {t('actions.takePayment')}
            </Button>
          ) : null}
          {open && base > 0 && can('orders.create', 'orders.edit', 'finance.approve') ? (
            <Button variant="secondary" onClick={() => setDiscounting(true)}>
              <BadgePercent />
              {can('finance.approve') ? t('discount.title') : t('discount.request')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => openPrint(`/print/receipt/${orderId}`)}>
            <Receipt />
            {t('actions.printReceipt')}
          </Button>
        </div>
      </Card>
      <TakePaymentDialog open={paying} onOpenChange={setPaying} invoice={{ id: invoice.id, number: invoice.number, balance: invoice.balance }} />
      <DiscountDialog open={discounting} onOpenChange={setDiscounting} invoiceId={invoice.id} base={base} />
    </div>
  );
}
