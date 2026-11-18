import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { CatalogTestDetail, CatalogTestInput } from '@natija/contracts';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, ConfirmDialog, Drawer, ErrorState, Field, Input, Select, Skeleton, Switch, Textarea, TubeIcon } from '@/components/ui';
import { adminKeys, useLookups } from '../../api';
import { BilingualFields, NumberField, numText, toNumber, useFieldErrors } from '../common';
import { OrderedPicker } from './OrderedPicker';
import { AnalyteTypeBadge, FormSection, useAnalytes, useCatalogSave } from './shared';

type Form = {
  code: string;
  nameAr: string;
  nameEn: string;
  reportNameAr: string;
  reportNameEn: string;
  departmentId: string;
  sampleTypeId: string;
  containerId: string;
  units: string;
  fixedPrice: string;
  tatHours: string;
  method: string;
  isExternal: boolean;
  separateTube: boolean;
  isFavorite: boolean;
  isActive: boolean;
  sortOrder: string;
  notes: string;
  analyteIds: string[];
};

const EMPTY: Form = {
  code: '',
  nameAr: '',
  nameEn: '',
  reportNameAr: '',
  reportNameEn: '',
  departmentId: '',
  sampleTypeId: '',
  containerId: '',
  units: '',
  fixedPrice: '',
  tatHours: '24',
  method: '',
  isExternal: false,
  separateTube: false,
  isFavorite: false,
  isActive: true,
  sortOrder: '0',
  notes: '',
  analyteIds: [],
};

function fromDetail(d: CatalogTestDetail): Form {
  return {
    code: d.code,
    nameAr: d.nameAr,
    nameEn: d.nameEn,
    reportNameAr: d.reportNameAr ?? '',
    reportNameEn: d.reportNameEn ?? '',
    departmentId: d.departmentId,
    sampleTypeId: d.sampleTypeId,
    containerId: d.containerId,
    units: numText(d.units),
    fixedPrice: numText(d.fixedPrice),
    tatHours: numText(d.tatHours),
    method: d.method ?? '',
    isExternal: d.isExternal,
    separateTube: d.separateTube,
    isFavorite: d.isFavorite,
    isActive: d.isActive,
    sortOrder: numText(d.sortOrder),
    notes: d.notes ?? '',
    analyteIds: d.analytes.map((a) => a.id),
  };
}

/** Drawer to create a test (testId null) or edit one. */
export function TestEditor({ testId, onClose }: { testId: string | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const detail = useQuery({
    queryKey: adminKeys.test(testId ?? 'new'),
    queryFn: () => api.get<CatalogTestDetail>(`/catalog/tests/${testId}`),
    enabled: !!testId,
  });
  const title = testId ? t('catalog.tests.editorEdit') : t('catalog.tests.editorNew');
  if (testId && !detail.data) {
    return (
      <Drawer open onOpenChange={(o) => !o && onClose()} title={title} width="lg">
        {detail.error ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </Drawer>
    );
  }
  return <TestForm key={testId ?? 'new'} detail={detail.data ?? null} onClose={onClose} title={title} />;
}

function TestForm({ detail, onClose, title }: { detail: CatalogTestDetail | null; onClose: () => void; title: string }) {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const lookups = useLookups();
  const analytes = useAnalytes();
  const [form, setForm] = useState<Form>(() => (detail ? fromDetail(detail) : EMPTY));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = useCatalogSave(
    (body: z.input<typeof CatalogTestInput>) => (detail ? api.put(`/catalog/tests/${detail.id}`, body) : api.post('/catalog/tests', body)),
    { success: detail ? t('common.saved') : t('common.created'), onSuccess: onClose },
  );
  const remove = useCatalogSave(() => api.del(`/catalog/tests/${detail!.id}`), { success: t('common.deleted'), onSuccess: onClose });
  const fe = useFieldErrors(save.error);

  const pickerItems = useMemo(
    () =>
      (analytes.data ?? []).map((a) => ({
        id: a.id,
        code: a.code,
        label: bi(a, 'name'),
        hint: a.unit,
        extra: (
          <span className="flex shrink-0 items-center gap-1.5">
            {a.unit ? <span className="text-[12px] text-muted ltr-num">{a.unit}</span> : null}
            <AnalyteTypeBadge type={a.resultType} />
          </span>
        ),
      })),
    [analytes.data, bi],
  );

  const container = lookups.data?.containers.find((c) => c.id === form.containerId);
  const units = toNumber(form.units);
  const tat = toNumber(form.tatHours);
  const valid =
    form.code.trim() &&
    form.nameAr.trim() &&
    form.nameEn.trim() &&
    form.departmentId &&
    form.sampleTypeId &&
    form.containerId &&
    units !== null &&
    units >= 0 &&
    tat !== null &&
    tat >= 1;

  const submit = () => {
    if (!valid || !manage) return;
    save.mutate({
      code: form.code.trim(),
      nameAr: form.nameAr,
      nameEn: form.nameEn,
      reportNameAr: form.reportNameAr || null,
      reportNameEn: form.reportNameEn || null,
      departmentId: form.departmentId,
      sampleTypeId: form.sampleTypeId,
      containerId: form.containerId,
      units: units ?? 0,
      fixedPrice: toNumber(form.fixedPrice),
      tatHours: Math.round(tat ?? 24),
      method: form.method || null,
      isExternal: form.isExternal,
      separateTube: form.separateTube,
      isFavorite: form.isFavorite,
      isActive: form.isActive,
      sortOrder: Math.max(0, Math.round(toNumber(form.sortOrder) ?? 0)),
      notes: form.notes || null,
      analyteIds: form.analyteIds,
    });
  };

  const options = (rows: Array<{ id: string; code: string; nameAr: string; nameEn: string }> | undefined) =>
    (rows ?? []).map((r) => ({ value: r.id, label: `${bi(r, 'name')}`, hint: r.code }));

  return (
    <>
      <Drawer
        open
        onOpenChange={(o) => !o && onClose()}
        title={title}
        description={detail ? `${detail.code} · ${bi(detail, 'name')}` : t('catalog.tests.editorHint')}
        width="lg"
        footer={
          <>
            {detail && manage ? (
              <Button variant="ghost" className="me-auto text-crit" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t('catalog.actions.delete')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              {t('catalog.actions.cancel')}
            </Button>
            {manage ? (
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
                {t('catalog.actions.save')}
              </Button>
            ) : null}
          </>
        }
      >
        <form
          className="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={!manage} className="contents">
            <FormSection title={t('catalog.tests.sections.identity')}>
              <div className="grid gap-3">
                <div className="flex flex-wrap items-end gap-4">
                  <Field label={t('fields.code')} required error={fe.code} className="w-44">
                    {(id) => <Input id={id} ltr className="font-mono uppercase" value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} autoFocus={!detail} invalid={!!fe.code} />}
                  </Field>
                  <div className="pb-2">
                    <Switch checked={form.isActive} onCheckedChange={(v) => set('isActive', v)} label={t('common.active')} disabled={!manage} />
                  </div>
                </div>
                <BilingualFields ar={form.nameAr} en={form.nameEn} onAr={(v) => set('nameAr', v)} onEn={(v) => set('nameEn', v)} errorAr={fe.nameAr} errorEn={fe.nameEn} />
                <BilingualFields
                  ar={form.reportNameAr}
                  en={form.reportNameEn}
                  onAr={(v) => set('reportNameAr', v)}
                  onEn={(v) => set('reportNameEn', v)}
                  labelAr={t('catalog.tests.fields.reportNameAr')}
                  labelEn={t('catalog.tests.fields.reportNameEn')}
                  required={false}
                />
              </div>
            </FormSection>

            <FormSection title={t('catalog.tests.sections.sample')} description={t('catalog.tests.sections.sampleHint')}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('fields.departmentId')} required error={fe.departmentId}>
                  {(id) => (
                    <Select id={id} value={form.departmentId} onValueChange={(v) => set('departmentId', v)} options={options(lookups.data?.departments)} placeholder={t('catalog.actions.choose')} disabled={!manage} invalid={!!fe.departmentId} />
                  )}
                </Field>
                <Field label={t('fields.sampleTypeId')} required error={fe.sampleTypeId}>
                  {(id) => (
                    <Select id={id} value={form.sampleTypeId} onValueChange={(v) => set('sampleTypeId', v)} options={options(lookups.data?.sampleTypes)} placeholder={t('catalog.actions.choose')} disabled={!manage} invalid={!!fe.sampleTypeId} />
                  )}
                </Field>
                <Field label={t('fields.containerId')} required error={fe.containerId}>
                  {(id) => (
                    <div className="flex items-center gap-2">
                      <Select
                        id={id}
                        className="min-w-0 flex-1"
                        value={form.containerId}
                        onValueChange={(v) => set('containerId', v)}
                        options={options(lookups.data?.containers)}
                        placeholder={t('catalog.actions.choose')}
                        disabled={!manage}
                        invalid={!!fe.containerId}
                      />
                      {container ? <TubeIcon cap={container.capColor} title={bi(container, 'name')} /> : null}
                    </div>
                  )}
                </Field>
              </div>
              <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Switch checked={form.separateTube} onCheckedChange={(v) => set('separateTube', v)} label={t('catalog.tests.fields.separateTube')} disabled={!manage} />
                <Switch checked={form.isExternal} onCheckedChange={(v) => set('isExternal', v)} label={t('catalog.tests.fields.isExternal')} disabled={!manage} />
                <Switch checked={form.isFavorite} onCheckedChange={(v) => set('isFavorite', v)} label={t('catalog.tests.fields.isFavorite')} disabled={!manage} />
              </div>
              <p className="mt-2 text-[12px] text-muted">{t('catalog.tests.switchesHint')}</p>
            </FormSection>

            <FormSection title={t('catalog.tests.sections.pricing')}>
              <div className="grid gap-3 sm:grid-cols-4">
                <NumberField label={t('fields.units')} required value={form.units} onChange={(v) => set('units', v)} error={fe.units} hint={t('catalog.tests.fields.unitsHint')} />
                <NumberField label={t('fields.fixedPrice')} value={form.fixedPrice} onChange={(v) => set('fixedPrice', v)} error={fe.fixedPrice} hint={t('catalog.tests.fields.fixedPriceHint')} suffix={f.currencyLabel()} />
                <NumberField label={t('fields.tatHours')} required value={form.tatHours} onChange={(v) => set('tatHours', v)} error={fe.tatHours} suffix={t('common.hoursShort')} step="1" />
                <NumberField label={t('catalog.tests.fields.sortOrder')} value={form.sortOrder} onChange={(v) => set('sortOrder', v)} step="1" />
              </div>
              <Field label={t('catalog.tests.fields.method')} className="mt-3">
                {(id) => <Input id={id} value={form.method} onChange={(e) => set('method', e.target.value)} placeholder={t('catalog.tests.fields.methodHint')} />}
              </Field>
            </FormSection>

            <FormSection title={t('catalog.tests.sections.analytes')} description={t('catalog.tests.analytesHint')} actions={<Badge tone="neutral">{f.number(form.analyteIds.length)}</Badge>}>
              <OrderedPicker
                value={form.analyteIds}
                onChange={(ids) => set('analyteIds', ids)}
                items={pickerItems}
                placeholder={t('catalog.tests.pickAnalyte')}
                emptyText={t('catalog.tests.analytesEmpty')}
                disabled={!manage}
                invalid={!!fe.analyteIds}
              />
            </FormSection>

            <FormSection title={t('catalog.tests.sections.notes')}>
              <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} placeholder={t('catalog.tests.fields.notesHint')} />
            </FormSection>

            {detail ? (
              <FormSection title={t('catalog.tests.sections.usage')}>
                <p className="text-[13px] text-ink-2">{detail.ordered ? t('catalog.tests.ordered', { count: detail.ordered, n: f.number(detail.ordered) }) : t('catalog.tests.neverOrdered')}</p>
                {detail.packages.length ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[12.5px] text-muted">{t('catalog.tests.inPackages')}</span>
                    {detail.packages.map((p) => (
                      <Badge key={p.id} tone="accent">
                        {bi(p, 'name')}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </FormSection>
            ) : null}
            <button type="submit" hidden />
          </fieldset>
        </form>
      </Drawer>
      {detail ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          title={t('common.deleteTitle', { name: detail.code })}
          description={detail.ordered ? t('catalog.tests.deleteOrdered') : t('catalog.tests.deleteBody')}
          confirmLabel={t('catalog.actions.delete')}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(undefined);
            } catch {
              /* the error toast is already shown */
            }
          }}
        />
      ) : null}
    </>
  );
}
