import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, Wallet } from 'lucide-react';
import type { PaymentResult } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn, idempotencyKey } from '@/lib/utils';
import { Button, Dialog, Field, Input, Segmented, Textarea, toast } from '@/components/ui';
import { fd, useFormData, useMyCashSession, useRefresh } from '../api';
import { apiCode, Notice, SumRow, useFdError } from './shared';

/** "1,500" / "١٥٠٠" / "1 500" → 1500; empty or invalid → null. */
export function parseAmount(s: string): number | null {
  const clean = s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/[,\s٬]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Payment method buttons (cash, card, transfer, wallet). */
export function MethodPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const bi = useBi();
  const { data } = useFormData();
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {(data?.paymentMethods ?? []).map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          onClick={() => onChange(m.id)}
          className={cn(
            'inline-flex h-8 items-center rounded-lg border px-3 text-[13px] font-medium transition-colors',
            value === m.id ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-ink-2 hover:bg-sunken',
          )}
        >
          {bi(m)}
        </button>
      ))}
    </div>
  );
}

/** Warns when cash is picked but the user's cash box is closed, and offers to open it. */
export function CashSessionNotice({ methodId, forceShow, onOpened }: { methodId: string; forceShow?: boolean; onOpened?: () => void }) {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const { data } = useFormData();
  const [open, setOpen] = useState(false);
  const method = data?.paymentMethods.find((m) => m.id === methodId);
  const session = useMyCashSession(!!method?.isCash);
  if (!method?.isCash || session.isLoading || (session.data?.cashSession && !forceShow)) return null;
  return (
    <>
      <Notice
        tone="warn"
        icon={<Lock />}
        title={t('cash.closedTitle')}
        action={
          can('finance.cash') ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {t('cash.open')}
            </Button>
          ) : null
        }
      >
        {can('finance.cash') ? t('cash.closedHint') : t('cash.closedNoPermission')}
      </Notice>
      <CashSessionDialog open={open} onOpenChange={setOpen} onOpened={onOpened} />
    </>
  );
}

export function CashSessionDialog({ open, onOpenChange, onOpened }: { open: boolean; onOpenChange: (o: boolean) => void; onOpened?: () => void }) {
  const { t } = useTranslation('frontdesk');
  const errorText = useFdError();
  const refresh = useRefresh();
  const [float, setFloat] = useState('0');
  useEffect(() => {
    if (open) setFloat('0');
  }, [open]);
  const openSession = useMutation({
    mutationFn: () => fd.openCashSession(parseAmount(float) ?? 0),
    onSuccess: async () => {
      toast.success(t('cash.opened'));
      await refresh.formData();
      void refresh.finance();
      onOpenChange(false);
      onOpened?.();
    },
    onError: async (err) => {
      // Opened meanwhile (another tab): nothing to do but pick it up.
      if (apiCode(err) === 'session_already_open') {
        await Promise.all([refresh.formData(), refresh.finance()]);
        onOpenChange(false);
        onOpened?.();
        return;
      }
      toast.error(errorText(err));
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('cash.openTitle')}
      description={t('cash.openDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={openSession.isPending} onClick={() => openSession.mutate()}>
            {t('cash.open')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          openSession.mutate();
        }}
      >
        <Field label={t('cash.openingFloat')} hint={t('cash.openingFloatHint')}>
          {(id) => <Input id={id} ltr inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} autoFocus />}
        </Field>
      </form>
    </Dialog>
  );
}

/** Take a payment on an invoice; a retry never charges twice (same idempotency key while open). */
export function TakePaymentDialog({
  open,
  onOpenChange,
  invoice,
  onPaid,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice: { id: string; number: string; balance: number } | null;
  onPaid?: (r: PaymentResult) => void;
}) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const errorText = useFdError();
  const refresh = useRefresh();
  const { data: form } = useFormData();
  const [methodId, setMethodId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const key = useMemo(() => (open ? idempotencyKey() : ''), [open]);

  useEffect(() => {
    if (!open || !invoice) return;
    setAmount(String(Math.max(0, invoice.balance)));
    setReference('');
    setMethodId((m) => m || form?.paymentMethods[0]?.id || '');
  }, [open, invoice, form]);

  const value = parseAmount(amount);
  const tooMuch = value !== null && invoice !== null && value > invoice.balance;
  const pay = useMutation({
    mutationFn: () => fd.pay({ invoiceId: invoice!.id, amount: value!, methodId, reference: reference.trim() || null, idempotencyKey: key }),
    onSuccess: (r) => {
      toast.success(t('pay.done', { amount: f.money(r.payment.amount) }));
      void refresh.orders();
      void refresh.finance();
      onOpenChange(false);
      onPaid?.(r);
    },
  });
  const noSession = apiCode(pay.error) === 'no_cash_session';
  const method = form?.paymentMethods.find((m) => m.id === methodId);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <Wallet className="size-5 text-accent" />
          {t('pay.title')}
        </span>
      }
      description={invoice ? t('pay.description', { number: invoice.number }) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={pay.isPending} disabled={!methodId || !value || value <= 0 || tooMuch} onClick={() => pay.mutate()}>
            {t('pay.confirm', { amount: value ? f.money(value) : '' })}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (methodId && value && value > 0 && !tooMuch) pay.mutate();
        }}
      >
        {invoice ? (
          <div className="rounded-lg bg-sunken px-3 py-2">
            <SumRow label={t('billing.balance')} strong>
              <span className="ltr-num">{f.money(invoice.balance)}</span>
            </SumRow>
          </div>
        ) : null}
        <Field label={t('pay.method')}>
          <MethodPicker value={methodId} onChange={setMethodId} />
        </Field>
        <Field label={t('pay.amount')} error={tooMuch ? t('errors.amount_exceeds_balance') : null}>
          {(id) => (
            <div className="flex items-center gap-2">
              <Input id={id} ltr inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={tooMuch} autoFocus className="max-w-[200px]" />
              {invoice ? (
                <Button size="sm" variant="ghost" onClick={() => setAmount(String(invoice.balance))}>
                  {t('pay.full')}
                </Button>
              ) : null}
            </div>
          )}
        </Field>
        {method && !method.isCash ? (
          <Field label={t('pay.reference')} hint={t('common:common.optional')}>
            {(id) => <Input id={id} ltr value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
        ) : null}
        <CashSessionNotice methodId={methodId} forceShow={noSession} onOpened={() => pay.reset()} />
        {pay.error && !noSession ? <Notice tone="crit">{errorText(pay.error)}</Notice> : null}
      </form>
    </Dialog>
  );
}

/** Ask for a discount on an invoice: applied at once for approvers, otherwise sent for approval. */
export function DiscountDialog({
  open,
  onOpenChange,
  invoiceId,
  base,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoiceId: string;
  /** What is left to discount (subtotal minus discounts so far). */
  base: number;
  onDone?: () => void;
}) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const { can } = useAuth();
  const errorText = useFdError();
  const refresh = useRefresh();
  const [mode, setMode] = useState<'amount' | 'percent'>('amount');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setValue('');
      setReason('');
    }
  }, [open]);
  const n = parseAmount(value);
  const amount = n === null ? 0 : mode === 'amount' ? Math.min(n, base) : Math.round((base * Math.min(n, 100)) / 100);
  const valid = n !== null && n > 0 && (mode === 'percent' ? n <= 100 : true) && reason.trim().length >= 3;
  const approver = can('finance.approve');
  const send = useMutation({
    mutationFn: () => fd.discount(invoiceId, { ...(mode === 'amount' ? { amount: n! } : { percent: n! }), reason: reason.trim() }),
    onSuccess: (r) => {
      toast.success(r.applied ? t('discount.applied', { amount: f.money(r.amount) }) : t('discount.requested', { amount: f.money(r.amount) }));
      void refresh.orders();
      void refresh.finance();
      onOpenChange(false);
      onDone?.();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('discount.title')}
      description={approver ? t('discount.directHint') : t('discount.approvalHint')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={send.isPending} disabled={!valid} onClick={() => send.mutate()}>
            {approver ? t('discount.apply') : t('discount.request')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send.mutate();
        }}
      >
        <DiscountFields mode={mode} onMode={setMode} value={value} onValue={setValue} reason={reason} onReason={setReason} preview={amount} autoFocus />
        {send.error ? <Notice tone="crit">{errorText(send.error)}</Notice> : null}
      </form>
    </Dialog>
  );
}

/** Amount-or-percent + reason, shared by the reception totals and the discount dialog. */
export function DiscountFields({
  mode,
  onMode,
  value,
  onValue,
  reason,
  onReason,
  preview,
  autoFocus,
}: {
  mode: 'amount' | 'percent';
  onMode: (m: 'amount' | 'percent') => void;
  value: string;
  onValue: (v: string) => void;
  reason: string;
  onReason: (v: string) => void;
  preview?: number;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Segmented<'amount' | 'percent'>
          size="sm"
          value={mode}
          onChange={onMode}
          options={[
            { value: 'amount', label: f.currencyLabel() },
            { value: 'percent', label: '%' },
          ]}
        />
        <Input ltr inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} className="h-8 w-28" aria-label={t('discount.value')} autoFocus={autoFocus} />
        {preview && preview > 0 ? <span className="pb-1.5 text-[12.5px] text-muted tabular">= {f.money(preview)}</span> : null}
      </div>
      <Field label={t('discount.reason')} required>
        {(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => onReason(e.target.value)} placeholder={t('discount.reasonPlaceholder')} />}
      </Field>
    </div>
  );
}
