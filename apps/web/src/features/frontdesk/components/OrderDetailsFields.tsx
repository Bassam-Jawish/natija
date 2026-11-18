import { useTranslation } from 'react-i18next';
import type { DeliveryChannel, OrderFormData, OrderSource, Priority } from '@natija/contracts';
import { useBi } from '@/lib/i18n';
import { Combobox, Field, Input, Segmented, Select, Switch, Textarea } from '@/components/ui';

export type OrderDetailsValue = {
  doctorId: string | null;
  referralClinic: string;
  priority: Priority;
  source: OrderSource;
  externalRef: string;
  deliveryChannel: DeliveryChannel;
  fasting: boolean;
  pregnant: boolean;
  branchId: string | null;
  clinicalInfo: string;
  notes: string;
};

export const emptyDetails = (form?: OrderFormData): OrderDetailsValue => ({
  doctorId: null,
  referralClinic: '',
  priority: 'routine',
  source: 'walk_in',
  externalRef: '',
  deliveryChannel: 'print',
  fasting: false,
  pregnant: false,
  branchId: form?.branches.find((b) => b.isMain)?.id ?? form?.branches[0]?.id ?? null,
  clinicalInfo: '',
  notes: '',
});

export function useDoctorOptions(form: OrderFormData | undefined) {
  const bi = useBi();
  return (form?.doctors ?? []).map((d) => ({
    value: d.id,
    label: bi(d),
    hint: [bi({ nameAr: d.specialtyAr, nameEn: d.specialtyEn }), d.clinic].filter(Boolean).join(' · ') || undefined,
  }));
}

/** Doctor, priority, source, delivery, fasting/pregnancy, branch and clinical notes of an order. */
export function OrderDetailsFields({
  form,
  value,
  onChange,
  female,
  showBranch = true,
  lockSource,
}: {
  form: OrderFormData;
  value: OrderDetailsValue;
  onChange: (v: OrderDetailsValue) => void;
  female: boolean;
  showBranch?: boolean;
  /** Source can't change after the order is created. */
  lockSource?: boolean;
}) {
  const { t } = useTranslation('frontdesk');
  const bi = useBi();
  const doctors = useDoctorOptions(form);
  const set = <K extends keyof OrderDetailsValue>(k: K, v: OrderDetailsValue[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('order.doctor')}>
        {(id) => (
          <Combobox
            id={id}
            clearable
            value={value.doctorId}
            onChange={(v) => set('doctorId', v)}
            options={doctors}
            placeholder={t('order.noDoctor')}
            searchPlaceholder={t('order.searchDoctor')}
          />
        )}
      </Field>
      <Field label={t('order.priority')}>
        <Segmented<Priority>
          value={value.priority}
          onChange={(p) => set('priority', p)}
          options={(['routine', 'urgent', 'stat'] as const).map((p) => ({ value: p, label: t(`common:status.priority.${p}`) }))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('order.source')}>
          {(id) => (
            <Select
              id={id}
              value={value.source}
              disabled={lockSource}
              onValueChange={(s) => set('source', s as OrderSource)}
              options={(['walk_in', 'referral', 'client_lab', 'home'] as const).map((s) => ({ value: s, label: t(`order.sources.${s}`) }))}
            />
          )}
        </Field>
        <Field label={t('order.delivery')}>
          {(id) => (
            <Select
              id={id}
              value={value.deliveryChannel}
              onValueChange={(c) => set('deliveryChannel', c as DeliveryChannel)}
              options={(['print', 'whatsapp', 'sms', 'email'] as const).map((c) => ({ value: c, label: t(`order.channels.${c}`) }))}
            />
          )}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('order.referralClinic')}>
          {(id) => <Input id={id} dir="auto" value={value.referralClinic} onChange={(e) => set('referralClinic', e.target.value)} />}
        </Field>
        <Field label={t('order.externalRef')} hint={value.source === 'walk_in' ? undefined : t('order.externalRefHint')}>
          {(id) => <Input id={id} ltr value={value.externalRef} onChange={(e) => set('externalRef', e.target.value)} disabled={value.source === 'walk_in'} />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Switch checked={value.fasting} onCheckedChange={(v) => set('fasting', v)} label={t('order.fasting')} />
        {female ? <Switch checked={value.pregnant} onCheckedChange={(v) => set('pregnant', v)} label={t('order.pregnant')} /> : null}
      </div>
      {showBranch && form.branches.length > 1 ? (
        <Field label={t('order.branch')}>
          {(id) => <Select id={id} value={value.branchId ?? ''} onValueChange={(b) => set('branchId', b)} options={form.branches.map((b) => ({ value: b.id, label: bi(b) }))} />}
        </Field>
      ) : null}
      <Field label={t('order.clinicalInfo')}>
        {(id) => <Textarea id={id} rows={2} value={value.clinicalInfo} onChange={(e) => set('clinicalInfo', e.target.value)} placeholder={t('order.clinicalInfoPlaceholder')} />}
      </Field>
      <Field label={t('order.notes')}>
        {(id) => <Textarea id={id} rows={1} value={value.notes} onChange={(e) => set('notes', e.target.value)} />}
      </Field>
    </div>
  );
}
