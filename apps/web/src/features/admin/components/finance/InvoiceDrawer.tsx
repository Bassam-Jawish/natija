import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Banknote, Printer, RotateCcw } from 'lucide-react';
import type { InvoiceDetail } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { Badge, Button, Drawer, ErrorState, InfoList, Money, Skeleton, StatusChip } from '@/components/ui';
import { financeKeys } from '../../api';
import { Code, Metric, SectionTitle } from '../common';
import { RefundDialog, TakePaymentDialog, type PayTarget, type RefundTarget } from './dialogs';

/** Invoice detail (lines, payments, discount requests) with payment and refund actions. */
export function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const { can } = useAuth();
  const [pay, setPay] = useState<PayTarget | null>(null);
  const [refund, setRefund] = useState<RefundTarget | null>(null);
  const q = useQuery({
    queryKey: financeKeys.invoice(invoiceId ?? 'none'),
    queryFn: () => api.get<InvoiceDetail>(`/billing/invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });
  const inv = q.data;
  const patient = inv ? bi(inv.patient, 'fullName') : '';
  return (
    <>
      <Drawer
        open={!!invoiceId}
        onOpenChange={(o) => !o && onClose()}
        width="lg"
        title={
          inv ? (
            <span className="inline-flex items-center gap-2">
              <Code className="text-[15px] text-ink">{inv.number}</Code>
              <StatusChip kind="invoice" status={inv.status} />
            </span>
          ) : (
            t('finance.invoice.title')
          )
        }
        description={inv ? `${patient} · ${f.dateTime(inv.createdAt)}` : undefined}
        footer={
          inv ? (
            <>
              <Button variant="ghost" onClick={() => openPrint(`/print/receipt/${inv.orderId}`)}>
                <Printer />
                {t('finance.pay.printReceipt')}
              </Button>
              {can('finance.refund') && inv.paidTotal > 0 ? (
                <Button variant="secondary" onClick={() => setRefund({ invoiceId: inv.id, number: inv.number, patient, paid: inv.paidTotal })}>
                  <RotateCcw />
                  {t('finance.refund.action')}
                </Button>
              ) : null}
              {can('finance.payment') && inv.status !== 'void' && inv.balance > 0 ? (
                <Button
                  variant="primary"
                  onClick={() => setPay({ invoiceId: inv.id, orderId: inv.orderId, number: inv.number, accession: inv.accession, patient, balance: inv.balance })}
                >
                  <Banknote />
                  {t('finance.pay.action')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {!inv && !q.error ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-40" />
          </div>
        ) : null}
        {inv ? (
          <div className="flex flex-col gap-5">
            <InfoList
              columns={3}
              items={[
                {
                  label: t('finance.invoice.order'),
                  value: (
                    <Link to={`/orders/${inv.orderId}`} className="font-mono text-accent ltr-num hover:underline">
                      {inv.accession}
                    </Link>
                  ),
                },
                { label: t('finance.invoice.patient'), value: patient },
                {
                  label: t('finance.invoice.payer'),
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {bi(inv.payer, 'name')}
                      {inv.payer.onAccount ? <Badge tone="info">{t('finance.invoice.onAccount')}</Badge> : null}
                    </span>
                  ),
                },
              ]}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-line px-3 py-1">
                <Metric label={t('finance.invoice.subtotal')} value={<Money value={inv.subtotal} />} />
                <Metric label={t('finance.invoice.discount')} value={inv.discountTotal ? <Money value={-inv.discountTotal} /> : '—'} />
                {inv.insurerTotal ? <Metric label={t('finance.invoice.payerShare')} value={<Money value={inv.insurerTotal} />} /> : null}
                <div className="border-t border-line">
                  <Metric label={t('finance.invoice.patientShare')} value={<Money value={inv.patientTotal} />} strong />
                </div>
              </div>
              <div className="rounded-lg border border-line px-3 py-1">
                <Metric label={t('finance.invoice.paid')} value={<Money value={inv.paidTotal} />} />
                <div className="border-t border-line">
                  <Metric
                    label={inv.balance < 0 ? t('finance.invoice.refundDue') : t('finance.invoice.balance')}
                    value={<Money value={Math.abs(inv.balance)} />}
                    strong
                    tone={inv.balance > 0 ? 'warn' : inv.balance < 0 ? 'crit' : 'ok'}
                  />
                </div>
                {inv.voidReason ? <p className="py-1.5 text-[12.5px] text-muted">{t('finance.invoice.voided', { reason: inv.voidReason })}</p> : null}
              </div>
            </div>

            <section>
              <SectionTitle>{t('finance.invoice.lines')}</SectionTitle>
              <div className="overflow-hidden rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-sunken text-[11.5px] text-muted">
                    <tr>
                      <th className="px-3 py-1.5 text-start font-medium">{t('finance.invoice.test')}</th>
                      <th className="px-3 py-1.5 text-end font-medium">{t('finance.invoice.price')}</th>
                      <th className="px-3 py-1.5 text-end font-medium">{t('finance.invoice.discount')}</th>
                      <th className="px-3 py-1.5 text-end font-medium">{t('finance.invoice.patientShare')}</th>
                      {inv.insurerTotal ? <th className="px-3 py-1.5 text-end font-medium">{t('finance.invoice.payerShare')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lines.map((l) => (
                      <tr key={l.id} className="border-t border-line">
                        <td className="px-3 py-1.5">
                          <span className="inline-flex flex-wrap items-center gap-x-1.5">
                            {l.code ? <Code>{l.code}</Code> : null}
                            <span>{l.nameAr || l.nameEn ? bi(l, 'name') : l.description}</span>
                            {l.packageCode ? <span className="text-[11.5px] text-muted">({l.packageCode})</span> : null}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-end">
                          <Money value={l.price} />
                        </td>
                        <td className="px-3 py-1.5 text-end text-muted">{l.discount ? <Money value={-l.discount} /> : '—'}</td>
                        <td className="px-3 py-1.5 text-end">
                          <Money value={l.patientShare} />
                        </td>
                        {inv.insurerTotal ? (
                          <td className="px-3 py-1.5 text-end">
                            <Money value={l.insurerShare} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <SectionTitle>{t('finance.invoice.payments')}</SectionTitle>
              {inv.payments.length === 0 ? (
                <p className="text-[13px] text-muted">{t('finance.invoice.noPayments')}</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {p.kind === 'refund' ? <Badge tone="crit">{t('finance.refund.badge')}</Badge> : null}
                          <span className="text-ink">{bi(p, 'methodName')}</span>
                          {p.reference ? <Code className="text-[11.5px]">{p.reference}</Code> : null}
                        </div>
                        <div className="text-[12px] text-muted">
                          {f.dateTime(p.receivedAt)}
                          {p.receivedBy ? ` · ${bi(p.receivedBy, 'fullName')}` : ''}
                        </div>
                      </div>
                      <Money value={p.kind === 'refund' ? -p.amount : p.amount} className={p.kind === 'refund' ? 'text-crit' : 'font-medium'} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {inv.approvals.length ? (
              <section>
                <SectionTitle>{t('finance.invoice.approvals')}</SectionTitle>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {inv.approvals.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 px-3 py-2 text-[13px]">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge tone="neutral">{t(`approvals.kinds.${a.kind}`, { defaultValue: a.kind })}</Badge>
                          <span className="truncate text-ink-2">{a.reason}</span>
                        </div>
                        <div className="text-[12px] text-muted">
                          {f.dateTime(a.requestedAt)}
                          {a.requestedBy ? ` · ${bi(a.requestedBy, 'fullName')}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {a.amount !== null ? <Money value={a.amount} /> : a.percent !== null ? <span className="ltr-num">{f.percent(a.percent, 1)}</span> : null}
                        <StatusChip kind="approval" status={a.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </Drawer>
      <TakePaymentDialog target={pay} onClose={() => setPay(null)} />
      <RefundDialog target={refund} onClose={() => setRefund(null)} />
    </>
  );
}
