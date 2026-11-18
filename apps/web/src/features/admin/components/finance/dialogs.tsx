import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Printer } from 'lucide-react';
import type { FinanceCashSession, PaymentResult } from '@natija/contracts';
import { api } from '@/lib/api';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { cn, idempotencyKey } from '@/lib/utils';
import { Button, Dialog, Field, Input, Money, Select, Textarea, toast } from '@/components/ui';
import { financeKeys, usePaymentMethods } from '../../api';
import { Metric, NumberField, toNumber, useAdminError } from '../common';

function useMethodOptions() {
  const methods = usePaymentMethods();
  const bi = useBi();
  const active = useMemo(() => (methods.data ?? []).filter((m) => m.isActive), [methods.data]);
  return { methods: active, options: active.map((m) => ({ value: m.id, label: bi(m, 'name') })) };
}

/* ------------------------------------------------------------------ take payment */

export type PayTarget = { invoiceId: string; orderId: string; number: string; accession: string; patient: string; balance: number };

/** Take a payment with the front desk's endpoint; the key makes a double click charge once. */
export function TakePaymentDialog({ target, onClose }: { target: PayTarget | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const { methods, options } = useMethodOptions();
  const [amount, setAmount] = useState('');
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [key, setKey] = useState('');
  const [done, setDone] = useState<PaymentResult | null>(null);
  useEffect(() => {
    if (!target) return;
    setAmount(String(target.balance));
    setMethodId(methods.find((m) => m.isCash)?.id ?? methods[0]?.id ?? '');
    setReference('');
    setKey(idempotencyKey());
    setDone(null);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = toNumber(amount);
  const method = methods.find((m) => m.id === methodId);
  const pay = useMutation({
    mutationFn: () => api.post<PaymentResult>('/billing/payments', { invoiceId: target!.invoiceId, amount: value, methodId, reference: reference || null, idempotencyKey: key }),
    onSuccess: (res) => {
      setDone(res);
      toast.success(t('finance.pay.done'));
      void qc.invalidateQueries({ queryKey: financeKeys.all });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const invalid = value === null || value <= 0 || (target ? value > target.balance : false);
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t('finance.pay.title')}
      description={target ? `${target.number} · ${target.accession} · ${target.patient}` : undefined}
      footer={
        done ? (
          <>
            <Button variant="ghost" onClick={() => openPrint(`/print/receipt/${target!.orderId}`)}>
              <Printer />
              {t('finance.pay.printReceipt')}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t('common:actions.done')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" loading={pay.isPending} disabled={invalid || !methodId} onClick={() => pay.mutate()}>
              {t('finance.pay.confirm')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 className="size-10 text-ok" />
          <div className="text-[15px] font-medium text-ink">{t('finance.pay.received')}</div>
          <Money value={done.payment.amount} className="text-[22px] font-semibold" />
          <div className="text-[13px] text-muted">
            {t('finance.pay.balanceNow')} <Money value={done.invoice.balance} />
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid && methodId) pay.mutate();
          }}
        >
          <div className="rounded-lg bg-sunken px-3 py-2">
            <Metric label={t('finance.pay.balance')} value={<Money value={target?.balance ?? 0} />} strong />
          </div>
          <NumberField
            label={t('fields.amount')}
            value={amount}
            onChange={setAmount}
            required
            error={value !== null && target && value > target.balance ? t('finance.pay.tooMuch') : undefined}
          />
          <Field label={t('fields.methodId')} required>
            {(id) => <Select id={id} value={methodId} onValueChange={setMethodId} options={options} />}
          </Field>
          {method && !method.isCash ? (
            <Field label={t('finance.pay.reference')} hint={t('finance.pay.referenceHint')}>
              {(id) => <Input id={id} ltr value={reference} onChange={(e) => setReference(e.target.value)} />}
            </Field>
          ) : null}
          {method?.isCash ? <p className="text-[12.5px] text-muted">{t('finance.pay.cashHint')}</p> : null}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ refund */

export type RefundTarget = { invoiceId: string; number: string; patient: string; paid: number };

export function RefundDialog({ target, onClose }: { target: RefundTarget | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const { methods, options } = useMethodOptions();
  const [amount, setAmount] = useState('');
  const [methodId, setMethodId] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => {
    if (!target) return;
    setAmount('');
    setMethodId(methods.find((m) => m.isCash)?.id ?? methods[0]?.id ?? '');
    setReason('');
    setKey(idempotencyKey());
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = toNumber(amount);
  const refund = useMutation({
    mutationFn: () => api.post('/finance/refunds', { invoiceId: target!.invoiceId, amount: value, methodId, reason: reason.trim(), idempotencyKey: key }),
    onSuccess: () => {
      toast.success(t('finance.refund.done'));
      void qc.invalidateQueries({ queryKey: financeKeys.all });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const tooMuch = value !== null && target !== null && value > target.paid;
  const invalid = value === null || value <= 0 || tooMuch || reason.trim().length < 3 || !methodId;
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t('finance.refund.title')}
      description={target ? `${target.number} · ${target.patient}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="danger" loading={refund.isPending} disabled={invalid} onClick={() => refund.mutate()}>
            {t('finance.refund.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-lg bg-sunken px-3 py-2">
          <Metric label={t('finance.refund.paid')} value={<Money value={target?.paid ?? 0} />} strong />
        </div>
        <NumberField label={t('fields.amount')} value={amount} onChange={setAmount} required error={tooMuch ? t('finance.refund.tooMuch') : undefined} />
        <Field label={t('finance.refund.method')} required hint={t('finance.refund.methodHint')}>
          {(id) => <Select id={id} value={methodId} onValueChange={setMethodId} options={options} />}
        </Field>
        <Field label={t('fields.reason')} required>
          {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />}
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ close a cash session */

export function CloseSessionDialog({ session, onClose }: { session: FinanceCashSession | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<FinanceCashSession | null>(null);
  useEffect(() => {
    if (session) {
      setCounted('');
      setNote('');
      setResult(null);
    }
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = toNumber(counted);
  const expected = session?.totals.expectedCash ?? 0;
  const diff = value === null ? null : value - expected;
  const close = useMutation({
    mutationFn: () => api.post<FinanceCashSession>(`/finance/cash-sessions/${session!.id}/close`, { countedCash: value, note: note.trim() || null }),
    onSuccess: (res) => {
      setResult(res);
      toast.success(t('finance.session.closed'));
      void qc.invalidateQueries({ queryKey: financeKeys.all });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const needsNote = diff !== null && diff !== 0 && note.trim().length < 3;
  const shown = result ?? null;
  return (
    <Dialog
      open={!!session}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t('finance.session.closeTitle')}
      description={t('finance.session.closeHint')}
      footer={
        shown ? (
          <Button variant="primary" onClick={onClose}>
            {t('common:actions.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" loading={close.isPending} disabled={value === null || needsNote} onClick={() => close.mutate()}>
              {t('finance.session.closeConfirm')}
            </Button>
          </>
        )
      }
    >
      {session ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-line px-3 py-1">
            <Metric label={t('finance.session.float')} value={<Money value={session.openingFloat} />} />
            <Metric label={t('finance.session.cashIn')} value={<Money value={session.totals.cashPayments} />} />
            <Metric label={t('finance.session.cashRefunds')} value={<Money value={-session.totals.cashRefunds} />} />
            <Metric label={t('finance.session.cashExpenses')} value={<Money value={-session.totals.cashExpenses} />} />
            <div className="border-t border-line">
              <Metric label={t('finance.session.expected')} value={<Money value={shown?.expectedCash ?? expected} />} strong />
            </div>
          </div>
          {shown ? (
            <DifferenceBox difference={shown.difference ?? 0} />
          ) : (
            <>
              <NumberField label={t('fields.countedCash')} value={counted} onChange={setCounted} required hint={t('finance.session.countHint')} />
              {diff !== null ? <DifferenceBox difference={diff} preview /> : null}
              <Field label={t('common.notes')} required={diff !== null && diff !== 0} hint={diff ? t('finance.session.noteHint') : undefined}>
                {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
            </>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

function DifferenceBox({ difference, preview }: { difference: number; preview?: boolean }) {
  const { t } = useTranslation('admin');
  const balanced = difference === 0;
  return (
    <div className={cn('flex items-center gap-3 rounded-lg px-3 py-2.5', balanced ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
      {balanced ? <CheckCircle2 className="size-5 shrink-0" /> : <AlertTriangle className="size-5 shrink-0" />}
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-medium">{balanced ? t('finance.session.balanced') : difference > 0 ? t('finance.session.over') : t('finance.session.short')}</div>
        {preview ? <div className="text-[12px] opacity-80">{t('finance.session.previewHint')}</div> : null}
      </div>
      {!balanced ? <Money value={difference} className="text-[16px] font-semibold" /> : null}
    </div>
  );
}
