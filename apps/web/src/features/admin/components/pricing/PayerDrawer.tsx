import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { PRICING_PAYER_KINDS, type PricingPayerGroup } from '@natija/contracts';
import { priceTest, splitLine } from '@natija/domain';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Button, ConfirmDialog, Drawer, Field, Input, Select, Switch, toast } from '@/components/ui';
import { BilingualFields, Metric, NumberField, numText, SectionTitle, toNumber, useAdminError, useFieldErrors } from '../common';
import { settle } from '../common';

type Kind = (typeof PRICING_PAYER_KINDS)[number];

/** Create or edit a payer group (price tier): unit price, patient share, contractual discount, on-account billing. */
export function PayerDrawer({ payer, onClose }: { payer: PricingPayerGroup | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [code, setCode] = useState(payer?.code ?? '');
  const [nameAr, setNameAr] = useState(payer?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(payer?.nameEn ?? '');
  const [kind, setKind] = useState<Kind>(payer?.kind ?? 'public');
  const [unitPrice, setUnitPrice] = useState(numText(payer?.unitPrice));
  const [patientSharePct, setPatientSharePct] = useState(numText(payer?.patientSharePct ?? 100));
  const [discountPct, setDiscountPct] = useState(numText(payer?.discountPct ?? 0));
  const [onAccount, setOnAccount] = useState(payer?.onAccount ?? false);
  const [organization, setOrganization] = useState(payer?.organization ?? '');
  const [contactName, setContactName] = useState(payer?.contactName ?? '');
  const [phone, setPhone] = useState(payer?.phone ?? '');
  const [isActive, setIsActive] = useState(payer?.isActive ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'pricing'] });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: code.trim().toUpperCase(),
        nameAr,
        nameEn,
        kind,
        unitPrice: toNumber(unitPrice) ?? 0,
        patientSharePct: toNumber(patientSharePct) ?? 100,
        discountPct: toNumber(discountPct) ?? 0,
        onAccount,
        organization,
        contactName,
        phone,
        isActive,
      };
      return payer ? api.put(`/pricing/payer-groups/${payer.id}`, body) : api.post('/pricing/payer-groups', body);
    },
    onSuccess: async () => {
      toast.success(payer ? t('common.saved') : t('common.created'));
      await invalidate();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/pricing/payer-groups/${payer!.id}`),
    onSuccess: async () => {
      toast.success(t('common.deleted'));
      await invalidate();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = useFieldErrors(save.error);

  const unit = toNumber(unitPrice);
  const share = toNumber(patientSharePct);
  const disc = toNumber(discountPct);
  const pctError = (v: number | null) => (v === null || v < 0 || v > 100 ? t('pricing.payers.pctRange') : undefined);
  const valid = code.trim() && nameAr.trim() && nameEn.trim() && unit !== null && unit >= 0 && !pctError(share) && !pctError(disc);

  const example = (() => {
    if (unit === null || share === null || disc === null) return null;
    const terms = { unitPrice: unit, patientSharePct: share, discountPct: disc };
    const { price } = priceTest({ units: 10 }, terms, f.currency);
    return splitLine(price, terms, 0, f.currency);
  })();

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="md"
      title={payer ? t('pricing.payers.edit') : t('pricing.payers.new')}
      description={payer ? <span className="font-mono ltr-num">{payer.code}</span> : t('pricing.payers.newHint')}
      footer={
        <>
          {payer ? (
            <Button variant="ghost" className="me-auto text-crit" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              {t('common:actions.delete')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <section className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
            <Field label={t('fields.code')} required error={errors.code}>
              {(id) => <Input id={id} ltr className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} autoFocus={!payer} invalid={!!errors.code} />}
            </Field>
            <Field label={t('pricing.payers.kind')} required>
              {(id) => <Select id={id} value={kind} onValueChange={(v) => setKind(v as Kind)} options={PRICING_PAYER_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))} />}
            </Field>
          </div>
          <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} errorAr={errors.nameAr} errorEn={errors.nameEn} />
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>{t('pricing.payers.terms')}</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField
              label={t('fields.unitPrice')}
              required
              value={unitPrice}
              onChange={setUnitPrice}
              suffix={f.currencyLabel()}
              error={unit === null || unit < 0 ? t('fieldErrors.must_be_positive') : errors.unitPrice}
            />
            <NumberField label={t('fields.patientSharePct')} value={patientSharePct} onChange={setPatientSharePct} suffix="%" error={pctError(share) ?? errors.patientSharePct} />
            <NumberField label={t('fields.discountPct')} value={discountPct} onChange={setDiscountPct} suffix="%" error={pctError(disc) ?? errors.discountPct} />
          </div>
          <p className="text-[12.5px] text-muted">{t('pricing.payers.termsHint')}</p>
          <Switch checked={onAccount} onCheckedChange={setOnAccount} label={t('pricing.payers.onAccount')} />
          <p className="-mt-1 text-[12.5px] text-muted">{t('pricing.payers.onAccountHint')}</p>
          {example ? (
            <div className="rounded-lg border border-line bg-sunken/50 px-3 py-2">
              <p className="mb-1 text-[12px] font-medium text-ink-2">{t('pricing.payers.example')}</p>
              <Metric label={t('pricing.payers.examplePrice')} value={f.money(example.price)} />
              {example.discount ? <Metric label={t('fields.discountPct')} value={`− ${f.money(example.discount)}`} /> : null}
              <Metric label={t('pricing.payers.examplePatient')} value={f.money(example.patientShare)} strong />
              {example.insurerShare ? <Metric label={t('pricing.payers.examplePayer')} value={f.money(example.insurerShare)} /> : null}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>{t('pricing.payers.organization')}</SectionTitle>
          <Field label={t('pricing.payers.organizationName')} hint={t('pricing.payers.organizationHint')}>
            {(id) => <Input id={id} value={organization} onChange={(e) => setOrganization(e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('pricing.payers.contact')}>{(id) => <Input id={id} value={contactName} onChange={(e) => setContactName(e.target.value)} />}</Field>
            <Field label={t('settings.profile.phone')}>{(id) => <Input id={id} ltr value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
          </div>
          <Switch checked={isActive} onCheckedChange={setIsActive} label={t('common.active')} />
          <p className="-mt-1 text-[12.5px] text-muted">{t('pricing.payers.activeHint')}</p>
        </section>
        <button type="submit" className="hidden" />
      </form>
      {payer ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          title={t('common.deleteTitle', { name: bi(payer, 'name') })}
          description={payer.orderCount > 0 ? t('pricing.payers.deleteUsed', { count: payer.orderCount }) : t('common.deleteBody')}
          confirmLabel={t('common:actions.delete')}
          onConfirm={() => settle(remove.mutateAsync())}
        />
      ) : null}
    </Drawer>
  );
}
