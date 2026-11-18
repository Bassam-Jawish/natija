import { useMemo, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import type { SettingsLabProfile } from '@natija/contracts';
import { api } from '@/lib/api';
import { Button, Card, Field, RadioGroup, Segmented, Switch, Textarea, toast } from '@/components/ui';
import { NumberField, numText, toNumber, useAdminError, useFieldErrors } from '../common';
import { useLabSaved } from './use-lab';

type Settings = SettingsLabProfile['settings'];
type Draft = {
  segregationOfDuties: boolean;
  requireCollectionStep: boolean;
  digits: 'latin' | 'arabic';
  defaultLanguage: 'ar' | 'en';
  reportLanguage: 'ar' | 'en' | 'bilingual';
  reportFooterAr: string;
  reportFooterEn: string;
  deltaCheckDays: string;
  showUsd: boolean;
  usdRate: string;
};

const toDraft = (s: Settings): Draft => ({
  segregationOfDuties: s.segregationOfDuties,
  requireCollectionStep: s.requireCollectionStep,
  digits: s.digits,
  defaultLanguage: s.defaultLanguage,
  reportLanguage: s.reportLanguage,
  reportFooterAr: s.reportFooterAr ?? '',
  reportFooterEn: s.reportFooterEn ?? '',
  deltaCheckDays: numText(s.deltaCheckDays),
  showUsd: s.showUsd,
  usdRate: numText(s.usdRate),
});

/** Shared by the report and workflow tabs: each edits its own fields and saves the full settings object. */
function useSettingsDraft(profile: SettingsLabProfile) {
  const { t } = useTranslation('admin');
  const errorMessage = useAdminError();
  const saved = useLabSaved();
  const initial = useMemo(() => toDraft(profile.settings), [profile.settings]);
  const [draft, setDraft] = useState<Draft>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const save = useMutation({
    mutationFn: () =>
      api.put<SettingsLabProfile>('/settings/lab/settings', {
        ...draft,
        reportFooterAr: draft.reportFooterAr.trim() || null,
        reportFooterEn: draft.reportFooterEn.trim() || null,
        deltaCheckDays: toNumber(draft.deltaCheckDays) ?? 0,
        usdRate: toNumber(draft.usdRate),
      }),
    onSuccess: async (p) => {
      toast.success(t('common.saved'));
      await saved(p);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  return { draft, update, dirty, save, reset: () => setDraft(initial), errors: useFieldErrors(save.error) };
}

function SaveRow({ dirty, busy, onReset, disabled }: { dirty: boolean; busy: boolean; onReset: () => void; disabled?: boolean }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
      <span className="me-auto text-[12.5px] text-muted">{dirty ? t('common.unsaved') : t('settings.profile.upToDate')}</span>
      <Button variant="ghost" disabled={!dirty || busy} onClick={onReset}>
        {t('common:actions.reset')}
      </Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!dirty || disabled}>
        <Save />
        {t('common:actions.saveChanges')}
      </Button>
    </div>
  );
}

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-line py-3.5 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6">
      <div>
        <p className="text-[13.5px] font-medium text-ink">{title}</p>
        {hint ? <p className="mt-0.5 text-[12.5px] text-muted">{hint}</p> : null}
      </div>
      <div className="flex min-w-0 items-start">{children}</div>
    </div>
  );
}

export function ReportSettingsForm({ profile }: { profile: SettingsLabProfile }) {
  const { t } = useTranslation('admin');
  const { draft, update, dirty, save, reset } = useSettingsDraft(profile);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate();
      }}
    >
      <Card title={t('settings.reports.title')} description={t('settings.reports.description')}>
        <Row title={t('settings.reports.language')} hint={t('settings.reports.languageHint')}>
          <RadioGroup
            value={draft.reportLanguage}
            onValueChange={(v) => update('reportLanguage', v)}
            options={[
              { value: 'bilingual', label: t('settings.reports.bilingual'), hint: t('settings.reports.bilingualHint') },
              { value: 'ar', label: t('settings.reports.arabic') },
              { value: 'en', label: t('settings.reports.english') },
            ]}
          />
        </Row>
        <Row title={t('settings.reports.footer')} hint={t('settings.reports.footerHint')}>
          <div className="grid w-full gap-3">
            <Field label={t('settings.reports.footerAr')}>
              {(id) => <Textarea id={id} dir="rtl" rows={3} maxLength={1000} value={draft.reportFooterAr} onChange={(e) => update('reportFooterAr', e.target.value)} />}
            </Field>
            <Field label={t('settings.reports.footerEn')}>
              {(id) => <Textarea id={id} dir="ltr" rows={3} maxLength={1000} value={draft.reportFooterEn} onChange={(e) => update('reportFooterEn', e.target.value)} />}
            </Field>
          </div>
        </Row>
        <SaveRow dirty={dirty} busy={save.isPending} onReset={reset} />
      </Card>
    </form>
  );
}

export function WorkflowSettingsForm({ profile }: { profile: SettingsLabProfile }) {
  const { t } = useTranslation('admin');
  const { draft, update, dirty, save, reset, errors } = useSettingsDraft(profile);
  const days = toNumber(draft.deltaCheckDays);
  const daysError = days === null || !Number.isInteger(days) || days < 1 || days > 3650 ? t('settings.workflow.deltaDaysRange') : undefined;
  const rate = toNumber(draft.usdRate);
  const rateError = draft.showUsd && (rate === null || rate <= 0) ? t('fieldErrors.required') : errors.usdRate;
  const sample = useMemo(() => {
    const locale = draft.digits === 'arabic' ? 'ar-SY' : 'ar-SY-u-nu-latn';
    const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(12345.6);
    const d = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: profile.timezone }).format(new Date());
    return `${n} · ${d}`;
  }, [draft.digits, profile.timezone]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !daysError && !rateError) save.mutate();
      }}
    >
      <Card title={t('settings.workflow.title')} description={t('settings.workflow.description')}>
        <Row title={t('settings.workflow.segregation')} hint={t('settings.workflow.segregationHint')}>
          <Switch checked={draft.segregationOfDuties} onCheckedChange={(v) => update('segregationOfDuties', v)} label={draft.segregationOfDuties ? t('common.active') : t('common.inactive')} />
        </Row>
        <Row title={t('settings.workflow.collection')} hint={t('settings.workflow.collectionHint')}>
          <Switch checked={draft.requireCollectionStep} onCheckedChange={(v) => update('requireCollectionStep', v)} label={draft.requireCollectionStep ? t('common.active') : t('common.inactive')} />
        </Row>
        <Row title={t('settings.workflow.deltaDays')} hint={t('settings.workflow.deltaDaysHint')}>
          <NumberField
            className="w-48"
            label={t('settings.workflow.deltaDaysLabel')}
            value={draft.deltaCheckDays}
            onChange={(v) => update('deltaCheckDays', v)}
            error={daysError ?? errors.deltaCheckDays}
            suffix={t('settings.workflow.days')}
            step="1"
          />
        </Row>
        <Row title={t('settings.workflow.digits')} hint={t('settings.workflow.digitsHint')}>
          <div className="flex flex-col gap-2">
            <Segmented
              value={draft.digits}
              onChange={(v) => update('digits', v)}
              options={[
                { value: 'latin', label: t('settings.workflow.latin') },
                { value: 'arabic', label: t('settings.workflow.arabic') },
              ]}
            />
            <span className="text-[12.5px] text-muted">
              {t('settings.workflow.sample')} <span className="font-medium text-ink-2">{sample}</span>
            </span>
          </div>
        </Row>
        <Row title={t('settings.workflow.defaultLanguage')} hint={t('settings.workflow.defaultLanguageHint')}>
          <Segmented
            value={draft.defaultLanguage}
            onChange={(v) => update('defaultLanguage', v)}
            options={[
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Row>
        <Row title={t('settings.workflow.usd')} hint={t('settings.workflow.usdHint')}>
          <div className="flex flex-col gap-3">
            <Switch checked={draft.showUsd} onCheckedChange={(v) => update('showUsd', v)} label={draft.showUsd ? t('common.active') : t('common.inactive')} />
            {draft.showUsd ? (
              <NumberField
                className="w-56"
                label={t('fields.usdRate')}
                hint={t('settings.workflow.usdRateHint', { currency: profile.currency })}
                value={draft.usdRate}
                onChange={(v) => update('usdRate', v)}
                error={rateError}
                suffix={profile.currency}
                required
              />
            ) : null}
          </div>
        </Row>
        <SaveRow dirty={dirty} busy={save.isPending} onReset={reset} disabled={!!daysError || !!rateError} />
      </Card>
    </form>
  );
}
