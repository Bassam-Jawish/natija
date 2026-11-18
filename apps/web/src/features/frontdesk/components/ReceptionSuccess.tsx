import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Printer, Receipt, UserPlus, Wallet } from 'lucide-react';
import type { OrderCreated, PatientSummary } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { openPrint } from '@/lib/print';
import { Button, Card, Kbd } from '@/components/ui';
import { TakePaymentDialog } from './PaymentDialogs';
import { Accession, DailyNo, LinkButton, Notice, PatientMeta, SumRow, usePatientName } from './shared';

/** After "Create order": the number to call the patient by, and the next steps at the desk. */
export function ReceptionSuccess({
  order,
  patient,
  onPaid,
  onNext,
}: {
  order: OrderCreated;
  patient: PatientSummary | null;
  onPaid: (invoice: OrderCreated['invoice']) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const name = usePatientName();
  const [paying, setPaying] = useState(false);
  const inv = order.invoice;
  return (
    <Card className="mx-auto max-w-3xl" padded={false}>
      <div className="flex flex-col items-center gap-1 border-b border-line px-6 pt-8 pb-6 text-center">
        <span className="mb-2 inline-flex items-center gap-2 rounded-full bg-ok-soft px-3 py-1 text-[13px] font-medium text-ok">
          <CheckCircle2 className="size-4" />
          {t('success.title')}
        </span>
        <span className="text-[13px] text-muted">{t('success.dailyNo')}</span>
        <DailyNo value={order.dailyNo} size="xl" />
        <Accession value={order.accession} className="mt-1 text-[14px]" />
        {patient ? (
          <div className="mt-3">
            <p className="text-[17px] font-semibold text-ink">{name(patient)}</p>
            <PatientMeta p={patient} className="justify-center" />
          </div>
        ) : null}
      </div>
      <div className="grid gap-6 px-6 py-5 sm:grid-cols-2">
        <div>
          <SumRow label={t('success.tubes')}>
            <span className="tabular">{t('success.tubesCount', { count: order.tubes })}</span>
          </SumRow>
          <SumRow label={t('success.accessCode')}>
            <span className="font-mono tracking-[0.2em] ltr-num">{order.portalCode}</span>
          </SumRow>
          <SumRow label={t('billing.invoiceNo')}>
            <span className="font-mono text-[12.5px] ltr-num">{inv.number}</span>
          </SumRow>
        </div>
        <div>
          <SumRow label={t('billing.patientTotal')}>
            <span className="ltr-num">{f.money(inv.patientTotal)}</span>
          </SumRow>
          <SumRow label={t('billing.paid')}>
            <span className="ltr-num">{f.money(inv.paidTotal)}</span>
          </SumRow>
          <SumRow label={t('billing.balance')} strong>
            <span className={inv.balance > 0 ? 'text-warn ltr-num' : 'text-ok ltr-num'}>{f.money(inv.balance)}</span>
          </SumRow>
        </div>
      </div>
      {order.approvalId ? (
        <div className="px-6 pb-4">
          <Notice tone="info">{t('success.discountPending')}</Notice>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line px-6 py-4">
        <Button onClick={() => openPrint(`/print/labels/${order.id}`)}>
          <Printer />
          {t('actions.printLabels')}
        </Button>
        <Button onClick={() => openPrint(`/print/receipt/${order.id}`)}>
          <Receipt />
          {t('actions.printReceipt')}
        </Button>
        {inv.balance > 0 && can('finance.payment') ? (
          <Button variant="subtle" onClick={() => setPaying(true)}>
            <Wallet />
            {t('actions.takePayment')}
          </Button>
        ) : null}
        <LinkButton to={`/orders/${order.id}`} variant="ghost">
          <ExternalLink />
          {t('actions.openOrder')}
        </LinkButton>
        <Button variant="primary" onClick={onNext} autoFocus>
          <UserPlus />
          {t('actions.nextPatient')}
          <Kbd>F2</Kbd>
        </Button>
      </div>
      <TakePaymentDialog
        open={paying}
        onOpenChange={setPaying}
        invoice={{ id: inv.id, number: inv.number, balance: inv.balance }}
        onPaid={(r) => onPaid({ ...inv, paidTotal: r.invoice.paidTotal, balance: r.invoice.balance, status: r.invoice.status })}
      />
    </Card>
  );
}
