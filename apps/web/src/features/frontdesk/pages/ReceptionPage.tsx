import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileWarning, Search, UserPlus, X } from 'lucide-react';
import type { OrderCreated, OrderCreateInput, OrderItemInput, PatientSummary } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { idempotencyKey } from '@/lib/utils';
import { Avatar, Button, Card, Field, Input, Kbd, PageHeader, Segmented, Select, Skeleton, toast } from '@/components/ui';
import { usePatient, useFormData, useQuote, useRefresh, fd } from '../api';
import { emptyDetails, OrderDetailsFields, type OrderDetailsValue } from '../components/OrderDetailsFields';
import { PatientFinder, type NewPatientPrefill } from '../components/PatientFinder';
import { PatientForm } from '../components/PatientForm';
import { CashSessionNotice, DiscountFields, MethodPicker, parseAmount } from '../components/PaymentDialogs';
import { QuoteLines } from '../components/QuoteLines';
import { ReceptionSuccess } from '../components/ReceptionSuccess';
import { itemKey, TestPicker } from '../components/TestPicker';
import { apiCode, FdErrorState, LinkButton, Notice, PatientMeta, SumRow, useFdError, usePatientName } from '../components/shared';

type DiscountState = { open: boolean; mode: 'amount' | 'percent'; value: string; reason: string };
const NO_DISCOUNT: DiscountState = { open: false, mode: 'amount', value: '', reason: '' };

/**
 * Reception: one screen from "who is the patient" to "here is your number". Find or register
 * the patient, pick tests and packages (priced live by the server), set the order details,
 * optionally take payment, and create the order. F2 new patient · F4 tests · Ctrl+Enter create.
 */
export default function ReceptionPage() {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const name = usePatientName();
  const errorText = useFdError();
  const refresh = useRefresh();
  const [params, setParams] = useSearchParams();
  const formQ = useFormData();
  const form = formQ.data;

  const [patientId, setPatientId] = useState<string | null>(params.get('patient'));
  const [picked, setPicked] = useState<PatientSummary | null>(null);
  const [mode, setMode] = useState<'find' | 'new'>('find');
  const [prefill, setPrefill] = useState<NewPatientPrefill>({});
  const [formKey, setFormKey] = useState(0);
  const [items, setItems] = useState<OrderItemInput[]>([]);
  const [payerGroupId, setPayerGroupId] = useState<string | null>(null);
  const [details, setDetails] = useState<OrderDetailsValue>(() => emptyDetails());
  const [discount, setDiscount] = useState<DiscountState>(NO_DISCOUNT);
  const [methodId, setMethodId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payEdited, setPayEdited] = useState(false);
  const [created, setCreated] = useState<{ order: OrderCreated; patient: PatientSummary | null } | null>(null);
  const [triedCreate, setTriedCreate] = useState(false);
  const payKey = useRef(idempotencyKey());
  const firstNameRef = useRef<HTMLInputElement>(null);
  const finderRef = useRef<HTMLInputElement>(null);
  const testSearchRef = useRef<HTMLInputElement>(null);

  // Defaults once the form data is in.
  useEffect(() => {
    if (!form) return;
    setPayerGroupId((p) => p ?? form.defaultPayerGroupId);
    setDetails((d) => (d.branchId ? d : { ...d, branchId: emptyDetails(form).branchId }));
    setMethodId((m) => m || form.paymentMethods[0]?.id || '');
  }, [form]);

  // Opening /reception?patient=<id> (e.g. "New order" on a patient's file) starts with that patient.
  const paramPatient = params.get('patient');
  useEffect(() => {
    if (paramPatient) {
      setPatientId(paramPatient);
      setCreated(null);
    }
  }, [paramPatient]);

  const patientQ = usePatient(patientId ?? undefined);
  const patient: PatientSummary | null = patientQ.data ?? (picked?.id === patientId ? picked : null);
  const female = patient?.sex === 'female';

  const n = parseAmount(discount.value);
  const discountWanted = discount.open && n !== null && n > 0;
  const quoteBody = useMemo(
    () =>
      payerGroupId && items.length
        ? {
            payerGroupId,
            items,
            discount: discountWanted ? (discount.mode === 'amount' ? { amount: n! } : { percent: Math.min(n!, 100) }) : null,
          }
        : null,
    [payerGroupId, items, discountWanted, discount.mode, n],
  );
  const quote = useQuote(quoteBody);
  const q = items.length ? quote.data : undefined;
  const totals = q?.totals;

  // The amount to pay follows the total until the receptionist types their own.
  useEffect(() => {
    if (!payEdited) setPayAmount(totals ? String(totals.patientTotal) : '');
  }, [totals, payEdited]);

  const payer = form?.payerGroups.find((p) => p.id === payerGroupId);
  const pay = parseAmount(payAmount);
  const paying = !!totals && totals.patientTotal > 0 && pay !== null && pay > 0;
  const payTooMuch = paying && pay! > totals!.patientTotal;
  const discountReasonMissing = discountWanted && discount.reason.trim().length < 3;

  const blockers = [
    !patient ? t('reception.needPatient') : null,
    !items.length ? t('reception.needTests') : null,
    discountReasonMissing ? t('reception.needDiscountReason') : null,
    payTooMuch ? t('errors.amount_exceeds_balance') : null,
  ].filter(Boolean) as string[];

  const create = useMutation({
    mutationFn: () => {
      const text = (s: string) => s.trim() || null;
      const body: OrderCreateInput = {
        patientId: patient!.id,
        payerGroupId: payerGroupId!,
        doctorId: details.doctorId,
        referralClinic: text(details.referralClinic),
        source: details.source,
        externalRef: details.source === 'walk_in' ? null : text(details.externalRef),
        priority: details.priority,
        clinicalInfo: text(details.clinicalInfo),
        notes: text(details.notes),
        fasting: details.fasting,
        pregnant: female && details.pregnant,
        deliveryChannel: details.deliveryChannel,
        branchId: details.branchId,
        items,
        discount: discountWanted ? { ...(discount.mode === 'amount' ? { amount: n! } : { percent: Math.min(n!, 100) }), reason: discount.reason.trim() } : null,
        payment: paying ? { amount: pay!, methodId, idempotencyKey: payKey.current } : null,
      };
      return fd.createOrder(body);
    },
    onSuccess: (order) => {
      setCreated({ order, patient });
      void refresh.orders();
      void refresh.patients();
      if (order.payment) void refresh.finance();
      toast.success(t('success.toast', { no: order.dailyNo }));
    },
  });
  const noCashSession = apiCode(create.error) === 'no_cash_session';

  const submit = () => {
    setTriedCreate(true);
    if (blockers.length || create.isPending || !payerGroupId) return;
    create.mutate();
  };

  const focusSoon = (ref: RefObject<HTMLInputElement | null>) => setTimeout(() => ref.current?.focus(), 30);

  const reset = (next: 'find' | 'new' = 'find') => {
    setCreated(null);
    setPatientId(null);
    setPicked(null);
    setItems([]);
    setDetails(emptyDetails(form));
    setPayerGroupId(form?.defaultPayerGroupId ?? null);
    setDiscount(NO_DISCOUNT);
    setPayEdited(false);
    setTriedCreate(false);
    setPrefill({});
    setMode(next);
    setFormKey((k) => k + 1);
    create.reset();
    payKey.current = idempotencyKey();
    if (params.has('patient')) setParams({}, { replace: true });
    focusSoon(next === 'new' ? firstNameRef : finderRef);
  };

  const choosePatient = (p: PatientSummary) => {
    setPicked(p);
    setPatientId(p.id);
    setMode('find');
    focusSoon(testSearchRef);
  };

  const toggle = (item: OrderItemInput) => {
    setItems((list) => {
      const k = itemKey(item);
      if (list.some((x) => itemKey(x) === k)) return list.filter((x) => itemKey(x) !== k);
      if ('packageId' in item && form) {
        // A package replaces tests already picked on their own.
        const inside = new Set(form.packages.find((p) => p.id === item.packageId)?.testIds ?? []);
        const dropped = list.filter((x) => 'testId' in x && inside.has(x.testId));
        if (dropped.length) toast.info(t('reception.replacedByPackage', { count: dropped.length }));
        return [...list.filter((x) => !('testId' in x && inside.has(x.testId))), item];
      }
      return [...list, item];
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        reset('new');
      } else if (e.key === 'F4') {
        e.preventDefault();
        if (!created) testSearchRef.current?.focus();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!created) submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (formQ.error) return <FdErrorState error={formQ.error} onRetry={() => formQ.refetch()} />;

  const header = (
    <PageHeader
      title={t('reception.title')}
      description={t('reception.description')}
      actions={
        <div className="hidden items-center gap-3 text-[12px] text-muted md:flex">
          <span>
            <Kbd>F2</Kbd> {t('reception.keys.newPatient')}
          </span>
          <span>
            <Kbd>F4</Kbd> {t('reception.keys.tests')}
          </span>
          <span>
            <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> {t('reception.keys.create')}
          </span>
        </div>
      }
    />
  );

  if (created) {
    return (
      <>
        {header}
        <ReceptionSuccess
          order={created.order}
          patient={created.patient}
          onPaid={(invoice) => setCreated((c) => (c ? { ...c, order: { ...c.order, invoice } } : c))}
          onNext={() => reset('find')}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title={t('reception.patient')}
            actions={
              patient ? (
                <>
                  <LinkButton to={`/patients/${patient.id}`} target="_blank" size="sm" variant="ghost">
                    <ExternalLink />
                    {t('reception.patientFile')}
                  </LinkButton>
                  <Button size="sm" variant="ghost" onClick={() => reset('find')}>
                    <X />
                    {t('reception.changePatient')}
                  </Button>
                </>
              ) : (
                <Segmented<'find' | 'new'>
                  size="sm"
                  value={mode}
                  onChange={(m) => {
                    setMode(m);
                    focusSoon(m === 'new' ? firstNameRef : finderRef);
                  }}
                  options={[
                    { value: 'find', label: <><Search className="size-3.5" />{t('reception.find')}</> },
                    { value: 'new', label: <><UserPlus className="size-3.5" />{t('reception.newPatient')}</> },
                  ]}
                />
              )
            }
          >
            {patientId && !patient ? (
              patientQ.error ? (
                <FdErrorState error={patientQ.error} onRetry={() => patientQ.refetch()} />
              ) : (
                <Skeleton className="h-14" />
              )
            ) : patient ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <Avatar name={name(patient)} className="size-10 text-[13px]" />
                  <div className="min-w-0">
                    <p className="text-[17px] font-semibold text-ink">{name(patient)}</p>
                    <PatientMeta p={patient} />
                  </div>
                  {patientQ.data?.lastVisitAt ? (
                    <span className="ms-auto text-end text-[12px] text-muted">
                      {t('finder.lastVisit')}
                      <span className="block text-ink-2 tabular">{f.date(patientQ.data.lastVisitAt)}</span>
                    </span>
                  ) : null}
                </div>
                {patientQ.data?.mergedInto ? <Notice tone="crit">{t('patient.mergedNotice')}</Notice> : null}
                {patientQ.data?.notes ? (
                  <Notice tone="info" icon={<FileWarning />} title={t('patient.notes')}>
                    <span className="whitespace-pre-line">{patientQ.data.notes}</span>
                  </Notice>
                ) : null}
              </div>
            ) : mode === 'new' ? (
              <PatientForm
                key={formKey}
                prefill={prefill}
                firstFieldRef={firstNameRef}
                onSaved={(p) => choosePatient(p)}
                onUseExisting={(c) => choosePatient(c)}
                onCancel={() => {
                  setMode('find');
                  focusSoon(finderRef);
                }}
              />
            ) : (
              <PatientFinder
                inputRef={finderRef}
                autoFocus
                onSelect={choosePatient}
                onCreate={(pf) => {
                  setPrefill(pf);
                  setFormKey((k) => k + 1);
                  setMode('new');
                  focusSoon(firstNameRef);
                }}
              />
            )}
            {triedCreate && !patient ? <p className="mt-2 text-[12.5px] text-crit">{t('reception.needPatient')}</p> : null}
          </Card>

          <Card title={t('reception.tests')} description={items.length ? t('reception.selectedCount', { count: q?.lines.length ?? items.length }) : undefined}>
            {form ? (
              <div className="flex flex-col gap-4">
                <TestPicker form={form} payerGroupId={payerGroupId} selected={items} onToggle={toggle} searchRef={testSearchRef} />
                <QuoteLines quote={q} loading={quote.isFetching} stale={quote.isPlaceholderData || (quote.isFetching && !!q)} onRemove={toggle} />
                {quote.error ? <Notice tone="crit">{errorText(quote.error)}</Notice> : null}
              </div>
            ) : (
              <Skeleton className="h-[340px]" />
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-0">
          <Card title={t('reception.totals')}>
            <div className="flex flex-col gap-3">
              <Field label={t('order.payer')}>
                {(id) => (
                  <Select
                    id={id}
                    value={payerGroupId ?? ''}
                    onValueChange={setPayerGroupId}
                    options={(form?.payerGroups ?? []).map((p) => ({
                      value: p.id,
                      label: bi(p),
                      hint: p.kind === 'insurer' || p.patientSharePct < 100 ? t('order.patientShare', { pct: p.patientSharePct }) : p.discountPct > 0 ? `−${p.discountPct}%` : undefined,
                    }))}
                  />
                )}
              </Field>
              <div className="rounded-lg bg-sunken px-3 py-2">
                <SumRow label={t('billing.subtotal')}>{f.money(totals?.subtotal ?? 0)}</SumRow>
                {totals && totals.discountTotal > 0 ? <SumRow label={t('billing.discounts')}>−{f.money(totals.discountTotal)}</SumRow> : null}
                {totals && totals.insurerTotal > 0 ? (
                  <SumRow label={payer?.kind === 'client_lab' ? t('billing.clientShare') : t('billing.insurerShare')}>{f.money(totals.insurerTotal)}</SumRow>
                ) : null}
                <SumRow label={t('billing.patientPays')} strong className="mt-1 border-t border-line pt-2">
                  {f.money(totals?.patientTotal ?? 0)}
                </SumRow>
              </div>

              {discount.open ? (
                <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-ink">{t('discount.title')}</span>
                    <Button size="icon-sm" variant="ghost" className="size-7" onClick={() => setDiscount(NO_DISCOUNT)} aria-label={t('discount.remove')}>
                      <X />
                    </Button>
                  </div>
                  <DiscountFields
                    mode={discount.mode}
                    onMode={(m) => setDiscount((d) => ({ ...d, mode: m }))}
                    value={discount.value}
                    onValue={(v) => setDiscount((d) => ({ ...d, value: v }))}
                    reason={discount.reason}
                    onReason={(v) => setDiscount((d) => ({ ...d, reason: v }))}
                    preview={q?.discount?.requested}
                  />
                  {q?.discount?.needsApproval ? <Notice tone="info">{t('discount.willRequest')}</Notice> : null}
                </div>
              ) : (
                <Button variant="link" size="sm" className="self-start" onClick={() => setDiscount({ ...NO_DISCOUNT, open: true })} disabled={!items.length}>
                  {t('discount.add')}
                </Button>
              )}

              {totals && totals.patientTotal > 0 && can('finance.payment') ? (
                <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
                  <span className="text-[13px] font-medium text-ink">{t('reception.payNow')}</span>
                  <MethodPicker value={methodId} onChange={setMethodId} />
                  <div className="flex items-center gap-2">
                    <Field className="flex-1" error={payTooMuch ? t('errors.amount_exceeds_balance') : null}>
                      {(id) => (
                        <Input
                          id={id}
                          ltr
                          inputMode="decimal"
                          value={payAmount}
                          onChange={(e) => {
                            setPayEdited(true);
                            setPayAmount(e.target.value);
                          }}
                          invalid={payTooMuch}
                          aria-label={t('pay.amount')}
                          className="tabular"
                        />
                      )}
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPayEdited(true);
                        setPayAmount('');
                      }}
                    >
                      {t('reception.payLater')}
                    </Button>
                  </div>
                  {paying && pay! < totals.patientTotal ? <p className="text-[12.5px] text-muted">{t('reception.partial', { rest: f.money(totals.patientTotal - pay!) })}</p> : null}
                  {paying ? <CashSessionNotice methodId={methodId} forceShow={noCashSession} onOpened={() => create.reset()} /> : null}
                </div>
              ) : null}

              {create.error && !noCashSession ? <Notice tone="crit">{errorText(create.error)}</Notice> : null}
              {triedCreate && blockers.length ? (
                <Notice tone="warn">
                  <ul className="list-disc ps-4">
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              <Button variant="primary" size="lg" className="w-full" loading={create.isPending} onClick={submit}>
                {paying ? t('reception.createAndPay', { amount: f.money(pay!) }) : t('reception.create')}
                <Kbd>Ctrl ↵</Kbd>
              </Button>
            </div>
          </Card>

          <Card title={t('reception.details')}>
            {form ? <OrderDetailsFields form={form} value={details} onChange={setDetails} female={female} /> : <Skeleton className="h-64" />}
          </Card>
        </div>
      </div>
    </>
  );
}
