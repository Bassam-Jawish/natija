import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Printer } from 'lucide-react';
import { LabLogo } from '@/components/layout/LabLogo';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi, useLang } from '@/lib/i18n';
import { usePrintWhenReady } from '@/lib/print';
import { Button, QrCode, Spinner } from '@/components/ui';
import { fd, keys } from '../api';
import { FdErrorState, LinkButton } from '../components/shared';

const CSS = `
@page { size: 80mm auto; margin: 0; }
.receipt { width: 80mm; box-sizing: border-box; padding: 4mm 4mm 6mm; background: #fff; color: #000;
  font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif; font-size: 8.5pt; line-height: 1.35; }
.receipt hr { border: 0; border-top: 1px dashed #000; margin: 2.5mm 0; }
.receipt .row { display: flex; justify-content: space-between; gap: 2mm; }
.receipt .num { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; white-space: nowrap; }
.receipt .mono { font-family: 'IBM Plex Mono', monospace; }
.receipt table { width: 100%; border-collapse: collapse; }
.receipt td { padding: 0.6mm 0; vertical-align: top; }
@media screen { .receipt-wrap { display: flex; justify-content: center; padding: 6mm; } .receipt { box-shadow: 0 2px 12px rgb(0 0 0 / 0.12); } }
@media print { html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; } .receipt-wrap { padding: 0; } }
`;

/** 80 mm receipt: lab, invoice, lines, totals and payments, the order number and the patient's access code with a QR to the results page. */
export default function ReceiptPrint() {
  const { orderId = '' } = useParams<{ orderId: string }>();
  const { t } = useTranslation('frontdesk');
  const { me } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const lang = useLang();
  const q = useQuery({ queryKey: keys.receipt(orderId), queryFn: () => fd.receipt(orderId), enabled: !!orderId });
  usePrintWhenReady(!!q.data);

  if (q.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-paper">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (q.error || !q.data) return <FdErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { lab, order, patient, doctor, invoice } = q.data;
  const resultsUrl = `${window.location.origin}/r?lab=${encodeURIComponent(lab.code)}&order=${encodeURIComponent(order.accession)}`;
  const patientName = lang === 'en' && patient.fullNameEn ? patient.fullNameEn : patient.fullNameAr;
  const methods = new Map<string, number>();
  for (const p of invoice?.payments ?? []) {
    const label = bi({ nameAr: p.methodNameAr, nameEn: p.methodNameEn });
    methods.set(label, (methods.get(label) ?? 0) + (p.kind === 'refund' ? -p.amount : p.amount));
  }

  return (
    <div className="min-h-dvh bg-paper print:bg-white">
      <style>{CSS}</style>
      <div className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <LinkButton to={`/orders/${order.id}`} variant="ghost" size="sm">
          <ArrowLeft className="rtl:rotate-180" />
          {t('print.backToOrder')}
        </LinkButton>
        <span className="text-[13.5px] text-ink">{t('print.receiptTitle', { accession: order.accession })}</span>
        <Button variant="primary" size="sm" className="ms-auto" onClick={() => window.print()}>
          <Printer />
          {t('common:actions.print')}
        </Button>
      </div>
      <div className="receipt-wrap">
        <div className="receipt">
          <div style={{ textAlign: 'center' }}>
            <LabLogo svg={lab.logoSvg} name={bi(lab)} className="mx-auto mb-1 size-12" />
            <div style={{ fontSize: '11pt', fontWeight: 700 }}>{bi(lab)}</div>
            <div style={{ fontSize: '7.5pt' }}>{lang === 'ar' ? lab.nameEn : lab.nameAr}</div>
            {lab.phone ? <div className="num">{lab.phone}</div> : null}
            {lab.addressAr || lab.addressEn ? <div style={{ fontSize: '7.5pt' }}>{bi({ nameAr: lab.addressAr, nameEn: lab.addressEn })}</div> : null}
          </div>
          <hr />
          <div className="row" style={{ fontWeight: 700 }}>
            <span>{t('receipt.title')}</span>
            {invoice ? <span className="num mono">{invoice.number}</span> : null}
          </div>
          <div className="row">
            <span>{t('receipt.date')}</span>
            <span className="num">{f.dateTime(order.createdAt)}</span>
          </div>
          <div className="row">
            <span>{t('order.patient')}</span>
            <span style={{ fontWeight: 600, textAlign: 'end' }}>{patientName}</span>
          </div>
          <div className="row">
            <span>{t('patient.mrn')}</span>
            <span className="num mono">{patient.mrn}</span>
          </div>
          {doctor ? (
            <div className="row">
              <span>{t('order.doctor')}</span>
              <span style={{ textAlign: 'end' }}>{bi(doctor)}</span>
            </div>
          ) : null}
          {invoice ? (
            <>
              <hr />
              <table>
                <tbody>
                  {invoice.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <span className="mono num" style={{ fontWeight: 600 }}>
                          {l.code}
                        </span>{' '}
                        {l.nameAr ? bi(l) : l.description}
                      </td>
                      <td className="num" style={{ textAlign: 'end' }}>
                        {f.money(l.price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <hr />
              <div className="row">
                <span>{t('billing.subtotal')}</span>
                <span className="num">{f.money(invoice.subtotal)}</span>
              </div>
              {invoice.discountTotal ? (
                <div className="row">
                  <span>{t('billing.discounts')}</span>
                  <span className="num">−{f.money(invoice.discountTotal)}</span>
                </div>
              ) : null}
              {invoice.insurerTotal ? (
                <div className="row">
                  <span>{bi(invoice.payer)}</span>
                  <span className="num">−{f.money(invoice.insurerTotal)}</span>
                </div>
              ) : null}
              <div className="row" style={{ fontWeight: 700, fontSize: '10pt' }}>
                <span>{t('billing.patientTotal')}</span>
                <span className="num">{f.money(invoice.patientTotal)}</span>
              </div>
              {[...methods.entries()].map(([label, amount]) => (
                <div className="row" key={label}>
                  <span>
                    {t('billing.paid')} · {label}
                  </span>
                  <span className="num">{f.money(amount)}</span>
                </div>
              ))}
              <div className="row" style={{ fontWeight: 700 }}>
                <span>{invoice.balance < 0 ? t('billing.refundDue') : t('billing.balance')}</span>
                <span className="num">{f.money(Math.abs(invoice.balance))}</span>
              </div>
            </>
          ) : null}
          <hr />
          <div style={{ textAlign: 'center' }}>
            <div>{t('receipt.orderNo')}</div>
            <div className="num" style={{ fontSize: '22pt', fontWeight: 700, lineHeight: 1.1 }}>
              {order.dailyNo}
            </div>
            <div className="num mono">{order.accession}</div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '2.5mm 0 1.5mm' }}>
              <QrCode value={resultsUrl} size={96} />
            </div>
            <div>{t('receipt.accessCode')}</div>
            <div className="num mono" style={{ fontSize: '15pt', fontWeight: 700, letterSpacing: '0.25em' }}>
              {order.portalCode}
            </div>
            <div style={{ marginTop: '1.5mm' }}>{t('receipt.accessHint')}</div>
          </div>
          <hr />
          <div style={{ textAlign: 'center', fontSize: '7pt' }}>
            {t('receipt.printed', { at: f.dateTime(new Date()), by: me ? bi({ nameAr: me.user.fullNameAr, nameEn: me.user.fullNameEn }) : '' })}
          </div>
        </div>
      </div>
    </div>
  );
}
