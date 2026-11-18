import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import { CATALOG_ANALYTE_TYPES, type CatalogAnalyteDetail, type CatalogRange, type CatalogRangeCheck, type CatalogRangeIssue } from '@natija/contracts';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, ConfirmDialog, Drawer, ErrorState, Field, Input, Segmented, Skeleton, Switch, toast } from '@/components/ui';
import { adminKeys, useLookups } from '../../api';
import { BilingualFields, NumberField, numText, toNumber, useAdminError, useFieldErrors } from '../common';
import { FormulaEditor } from './FormulaEditor';
import { issuesFromErrors, RangeEditor, rowFromRange, rowToApi, type RangeRowState } from './RangeEditor';
import { FormSection, invalidateCatalog, useCatalogSave } from './shared';

type ResultType = (typeof CATALOG_ANALYTE_TYPES)[number];
type Def = {
  code: string;
  nameAr: string;
  nameEn: string;
  unit: string;
  resultType: ResultType;
  decimals: string;
  deltaPct: string;
  loinc: string;
  sortOrder: string;
  isActive: boolean;
  options: string[];
  formula: string;
};

const EMPTY: Def = { code: '', nameAr: '', nameEn: '', unit: '', resultType: 'numeric', decimals: '1', deltaPct: '', loinc: '', sortOrder: '0', isActive: true, options: [], formula: '' };

function defFrom(d: CatalogAnalyteDetail): Def {
  return {
    code: d.code,
    nameAr: d.nameAr,
    nameEn: d.nameEn,
    unit: d.unit ?? '',
    resultType: d.resultType,
    decimals: numText(d.decimals),
    deltaPct: numText(d.deltaPct),
    loinc: d.loinc ?? '',
    sortOrder: numText(d.sortOrder),
    isActive: d.isActive,
    options: d.options,
    formula: d.formula ?? '',
  };
}

const clampInt = (v: number | null, min: number, max: number, fallback: number) => (v === null ? fallback : Math.min(max, Math.max(min, Math.round(v))));

function bodyOf(d: Def) {
  return {
    code: d.code.trim(),
    nameAr: d.nameAr,
    nameEn: d.nameEn,
    unit: d.unit.trim() || null,
    resultType: d.resultType,
    decimals: clampInt(toNumber(d.decimals), 0, 6, 1),
    options: d.resultType === 'option' ? d.options : [],
    formula: d.resultType === 'calculated' ? d.formula.trim() || null : null,
    deltaPct: toNumber(d.deltaPct),
    loinc: d.loinc.trim() || null,
    sortOrder: clampInt(toNumber(d.sortOrder), 0, 99_999, 0),
    isActive: d.isActive,
  };
}

/** Drawer to create an analyte (analyteId null) or edit one with its reference ranges. */
export function AnalyteEditor({ analyteId, onClose }: { analyteId: string | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const [id, setId] = useState<string | null>(analyteId);
  const detail = useQuery({
    queryKey: adminKeys.analyte(id ?? 'new'),
    queryFn: () => api.get<CatalogAnalyteDetail>(`/catalog/analytes/${id}`),
    enabled: !!id,
  });
  if (id && !detail.data) {
    return (
      <Drawer open onOpenChange={(o) => !o && onClose()} title={t('catalog.analytes.editorEdit')} width="xl">
        {detail.error ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
      </Drawer>
    );
  }
  return <AnalyteForm key={id ?? 'new'} detail={detail.data ?? null} onCreated={setId} onClose={onClose} />;
}

function AnalyteForm({ detail, onCreated, onClose }: { detail: CatalogAnalyteDetail | null; onCreated: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const lookups = useLookups();
  const [def, setDef] = useState<Def>(() => (detail ? defFrom(detail) : EMPTY));
  const [defBase, setDefBase] = useState<Def>(def);
  const [rows, setRowsState] = useState<RangeRowState[]>(() => (detail?.ranges ?? []).map(rowFromRange));
  const [rowsBase, setRowsBase] = useState(() => JSON.stringify(rows.map(rowToApi)));
  const [serverIssues, setServerIssues] = useState<CatalogRangeIssue[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Def>(key: K, value: Def[K]) => setDef((prev) => ({ ...prev, [key]: value }));
  const setRows = (next: RangeRowState[]) => {
    setRowsState(next);
    setServerIssues([]);
  };

  const body = useMemo(() => bodyOf(def), [def]);
  const defDirty = !detail || JSON.stringify(body) !== JSON.stringify(bodyOf(defBase));
  const apiRows = useMemo(() => rows.map(rowToApi), [rows]);
  const rangesDirty = !!detail && JSON.stringify(apiRows) !== rowsBase;
  const dirty = detail ? defDirty || rangesDirty : JSON.stringify(def) !== JSON.stringify(EMPTY);

  const codeOk = /^[A-Za-z_][A-Za-z0-9_.%#]*$/.test(def.code.trim());
  const valid =
    codeOk &&
    def.nameAr.trim() &&
    def.nameEn.trim() &&
    (def.resultType !== 'option' || def.options.length > 0) &&
    (def.resultType !== 'calculated' || def.formula.trim().length > 0);

  const save = useMutation({
    mutationFn: async () => {
      let saved: CatalogAnalyteDetail | null = null;
      if (defDirty) saved = detail ? await api.put<CatalogAnalyteDetail>(`/catalog/analytes/${detail.id}`, body) : await api.post<CatalogAnalyteDetail>('/catalog/analytes', body);
      let ranges: { ranges: CatalogRange[]; check: CatalogRangeCheck } | null = null;
      if (detail && rangesDirty) ranges = await api.put(`/catalog/analytes/${detail.id}/ranges`, { rows: apiRows });
      return { saved, ranges };
    },
    onSuccess: async ({ saved, ranges }) => {
      await invalidateCatalog(qc);
      if (!detail && saved) {
        toast.success(t('catalog.analytes.createdNext'));
        onCreated(saved.id);
        return;
      }
      if (saved) setDefBase(def);
      if (ranges) {
        const next = ranges.ranges.map(rowFromRange);
        setRowsState(next);
        setRowsBase(JSON.stringify(next.map(rowToApi)));
        setServerIssues([]);
      }
      toast.success(ranges?.check.gaps.length ? t('catalog.ranges.savedWithGaps', { count: ranges.check.gaps.length }) : t('common.saved'));
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      if (err instanceof ApiError && (err.code === 'range_overlap' || err.code === 'range_invalid')) setServerIssues(issuesFromErrors(err.errors));
    },
  });
  const fe = useFieldErrors(save.error instanceof ApiError && save.error.code === 'validation' ? save.error : null);
  const remove = useCatalogSave(() => api.del(`/catalog/analytes/${detail!.id}`), { success: t('common.deleted'), onSuccess: onClose });

  const requestClose = () => (dirty && manage ? setConfirmClose(true) : onClose());
  const typeOptions = CATALOG_ANALYTE_TYPES.map((x) => ({ value: x, label: t(`catalog.analytes.types.${x}`) }));
  const numeric = def.resultType === 'numeric' || def.resultType === 'calculated';
  const formulaError = save.error instanceof ApiError && save.error.code.startsWith('formula_') ? errorMessage(save.error) : fe.formula;

  return (
    <>
      <Drawer
        open
        onOpenChange={(o) => !o && requestClose()}
        title={detail ? t('catalog.analytes.editorEdit') : t('catalog.analytes.editorNew')}
        description={detail ? `${detail.code} · ${bi(detail, 'name')}` : t('catalog.analytes.editorHint')}
        width="xl"
        footer={
          <>
            {detail && manage ? (
              <Button variant="ghost" className="me-auto text-crit" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t('catalog.actions.delete')}
              </Button>
            ) : null}
            {dirty && detail ? <Badge tone="warn">{t('common.unsaved')}</Badge> : null}
            <Button variant="ghost" onClick={requestClose}>
              {t('catalog.actions.cancel')}
            </Button>
            {manage ? (
              <Button variant="primary" loading={save.isPending} disabled={!valid || (!!detail && !dirty)} onClick={() => save.mutate()}>
                {detail ? t('catalog.actions.save') : t('catalog.analytes.createAndContinue')}
              </Button>
            ) : null}
          </>
        }
      >
        <fieldset disabled={!manage} className="contents">
          <FormSection title={t('catalog.analytes.sections.definition')}>
            <div className="grid gap-3">
              <div className="flex flex-wrap items-end gap-4">
                <Field label={t('fields.code')} required error={fe.code ?? (def.code && !codeOk ? t('fieldErrors.invalid_analyte_code') : undefined)} className="w-44">
                  {(id) => <Input id={id} ltr className="font-mono" value={def.code} onChange={(e) => set('code', e.target.value)} autoFocus={!detail} invalid={!!fe.code || (!!def.code && !codeOk)} />}
                </Field>
                <Field label={t('catalog.analytes.fields.resultType')}>
                  {() => (
                    <Segmented<ResultType>
                      value={def.resultType}
                      onChange={(v) => manage && set('resultType', v)}
                      options={typeOptions.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  )}
                </Field>
                <div className="pb-2">
                  <Switch checked={def.isActive} onCheckedChange={(v) => set('isActive', v)} label={t('common.active')} disabled={!manage} />
                </div>
              </div>
              {detail && detail.results > 0 && def.resultType !== detail.resultType ? <p className="text-[12.5px] text-warn">{t('catalog.analytes.typeLocked')}</p> : null}
              <BilingualFields ar={def.nameAr} en={def.nameEn} onAr={(v) => set('nameAr', v)} onEn={(v) => set('nameEn', v)} errorAr={fe.nameAr} errorEn={fe.nameEn} />
              <div className="grid gap-3 sm:grid-cols-5">
                <Field label={t('catalog.analytes.fields.unit')} error={fe.unit}>
                  {(id) => <Input id={id} ltr value={def.unit} onChange={(e) => set('unit', e.target.value)} placeholder="mg/dL" />}
                </Field>
                {numeric ? (
                  <>
                    <NumberField label={t('catalog.analytes.fields.decimals')} value={def.decimals} onChange={(v) => set('decimals', v)} step="1" error={fe.decimals} />
                    <NumberField label={t('catalog.analytes.fields.deltaPct')} value={def.deltaPct} onChange={(v) => set('deltaPct', v)} suffix="%" hint={t('catalog.analytes.fields.deltaHint')} error={fe.deltaPct} />
                  </>
                ) : null}
                <Field label={t('catalog.analytes.fields.loinc')} error={fe.loinc}>
                  {(id) => <Input id={id} ltr className="font-mono" value={def.loinc} onChange={(e) => set('loinc', e.target.value)} placeholder="2345-7" />}
                </Field>
                <NumberField label={t('catalog.analytes.fields.sortOrder')} value={def.sortOrder} onChange={(v) => set('sortOrder', v)} step="1" />
              </div>
            </div>
          </FormSection>

          {def.resultType === 'option' ? (
            <FormSection title={t('catalog.analytes.sections.options')} description={t('catalog.analytes.optionsHint')}>
              <OptionsEditor value={def.options} onChange={(v) => set('options', v)} disabled={!manage} error={fe.options} />
            </FormSection>
          ) : null}

          {def.resultType === 'calculated' ? (
            <FormSection title={t('catalog.analytes.sections.formula')} description={t('catalog.analytes.formulaHint')}>
              <FormulaEditor value={def.formula} onChange={(v) => set('formula', v)} code={def.code} analyteId={detail?.id ?? null} readOnly={!manage} error={formulaError} />
            </FormSection>
          ) : null}

          <FormSection
            title={t('catalog.analytes.sections.ranges')}
            description={detail ? t('catalog.ranges.hint') : undefined}
            actions={detail ? <Badge tone="neutral">{f.number(rows.length)}</Badge> : undefined}
          >
            {detail ? (
              <RangeEditor
                analyteId={detail.id}
                resultType={def.resultType}
                unit={def.unit}
                rows={rows}
                onChange={setRows}
                lookups={lookups.data}
                readOnly={!manage}
                serverIssues={serverIssues}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">{t('catalog.analytes.saveFirst')}</p>
            )}
          </FormSection>

          {detail ? (
            <FormSection title={t('catalog.analytes.sections.usage')}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12.5px] text-muted">{t('catalog.analytes.usedIn')}</span>
                {detail.tests.length ? (
                  detail.tests.map((x) => (
                    <Badge key={x.id} tone="accent">
                      <span className="font-mono ltr-num">{x.code}</span>
                      <span className="text-ink-2">{bi(x, 'name')}</span>
                    </Badge>
                  ))
                ) : (
                  <span className="text-[12.5px] text-faint">{t('catalog.analytes.notUsed')}</span>
                )}
              </div>
              <p className="mt-2 text-[12.5px] text-muted">{t('catalog.analytes.results', { count: detail.results, n: f.number(detail.results) })}</p>
            </FormSection>
          ) : null}
        </fieldset>
      </Drawer>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t('catalog.analytes.unsavedTitle')}
        description={t('catalog.analytes.unsavedBody')}
        confirmLabel={t('catalog.actions.discard')}
        tone="danger"
        onConfirm={() => onClose()}
      />
      {detail ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          title={t('common.deleteTitle', { name: detail.code })}
          description={detail.results ? t('catalog.analytes.deleteHasResults') : t('catalog.analytes.deleteBody')}
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

/** Answers offered for an option-type analyte (e.g. Negative / Positive), in display order. */
function OptionsEditor({ value, onChange, disabled, error }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; error?: string }) {
  const { t } = useTranslation('admin');
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setText('');
  };
  return (
    <div>
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((o) => (
            <span key={o} className="inline-flex items-center gap-1 rounded-md border border-line bg-sunken py-0.5 ps-2 pe-1 text-[12.5px] text-ink" dir="auto">
              {o}
              {!disabled ? (
                <button type="button" className="rounded p-0.5 text-faint hover:text-crit" onClick={() => onChange(value.filter((x) => x !== o))} aria-label={t('catalog.actions.remove')}>
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-muted">{t('catalog.analytes.optionsEmpty')}</p>
      )}
      {!disabled ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={t('catalog.analytes.optionPlaceholder')}
            className="h-8 max-w-64"
            dir="auto"
            invalid={!!error}
          />
          <Button size="sm" onClick={add} disabled={!text.trim()}>
            {t('catalog.actions.addOption')}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-[12.5px] text-crit">{error}</p> : null}
    </div>
  );
}
