import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { QcMaterialItem, QcRunItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Combobox, Dialog, Field, Input, Select, StatusChip, Switch, toast } from '@/components/ui';
import { ins, useFormData, type MaterialBody } from '../api';
import { Callout, Code, useInsError } from './common';

const ANY = '__any__';
const toNum = (s: string) => Number(s.replace(',', '.'));

/** Add or edit a QC material: analyte, lot, level and its target mean ± SD. */
export function MaterialDialog({ value, onClose }: { value: QcMaterialItem | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation('instruments');
  const bi = useBi();
  const qc = useQueryClient();
  const insError = useInsError();
  const form = useFormData();
  const existing = value && value !== 'new' ? value : null;
  const [instrumentId, setInstrumentId] = useState(ANY);
  const [analyteId, setAnalyteId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [lot, setLot] = useState('');
  const [level, setLevel] = useState('L1');
  const [mean, setMean] = useState('');
  const [sd, setSd] = useState('');
  const [unit, setUnit] = useState('');
  const [expires, setExpires] = useState('');
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!value) return;
    setInstrumentId(existing?.instrument?.id ?? ANY);
    setAnalyteId(existing?.analyte.id ?? null);
    setName(existing?.name ?? '');
    setLot(existing?.lot ?? '');
    setLevel(existing?.level ?? 'L1');
    setMean(existing ? String(existing.targetMean) : '');
    setSd(existing ? String(existing.targetSd) : '');
    setUnit(existing?.unit ?? '');
    setExpires(existing?.expiresOn ?? '');
    setActive(existing?.isActive ?? true);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = analyteId && name.trim() && lot.trim() && level.trim() && Number.isFinite(toNum(mean)) && mean.trim() && toNum(sd) > 0;
  const save = useMutation({
    mutationFn: () => {
      const body: MaterialBody = {
        instrumentId: instrumentId === ANY ? null : instrumentId,
        analyteId: analyteId!,
        name: name.trim(),
        lot: lot.trim(),
        level: level.trim(),
        targetMean: toNum(mean),
        targetSd: toNum(sd),
        unit: unit.trim() || null,
        expiresOn: expires || null,
        isActive: active,
      };
      return existing ? ins.updateMaterial(existing.id, body) : ins.createMaterial(body);
    },
    onSuccess: () => {
      toast.success(t('qc.materialSaved'));
      void qc.invalidateQueries({ queryKey: ['qc'] });
      onClose();
    },
    onError: (err) => toast.error(insError(err)),
  });
  const analytes = (form.data?.analytes ?? []).map((a) => ({ value: a.id, label: `${a.code} · ${bi(a, 'name')}`, hint: a.unit ?? undefined }));
  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={existing ? t('qc.editMaterial') : t('qc.addMaterial')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('qc.col.analyte')} required>
          {(id) => (
            <Combobox
              id={id}
              value={analyteId}
              onChange={(v) => {
                setAnalyteId(v);
                const a = form.data?.analytes.find((x) => x.id === v);
                if (a && !unit) setUnit(a.unit ?? '');
              }}
              options={analytes}
              loading={form.isLoading}
            />
          )}
        </Field>
        <Field label={t('qc.col.instrument')} hint={t('qc.instrumentHint')}>
          {(id) => (
            <Select
              id={id}
              value={instrumentId}
              onValueChange={setInstrumentId}
              options={[{ value: ANY, label: t('qc.anyInstrument') }, ...(form.data?.instruments ?? []).map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))]}
            />
          )}
        </Field>
        <Field label={t('qc.col.name')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="PreciControl ClinChem" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('qc.col.level')} required>
            {(id) => <Input id={id} ltr value={level} onChange={(e) => setLevel(e.target.value)} />}
          </Field>
          <Field label={t('qc.col.lot')} required>
            {(id) => <Input id={id} ltr value={lot} onChange={(e) => setLot(e.target.value)} />}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:col-span-2">
          <Field label={t('qc.targetMean')} required>
            {(id) => <Input id={id} ltr inputMode="decimal" value={mean} onChange={(e) => setMean(e.target.value)} />}
          </Field>
          <Field label={t('qc.targetSd')} required hint={t('qc.sdHint')}>
            {(id) => <Input id={id} ltr inputMode="decimal" value={sd} onChange={(e) => setSd(e.target.value)} invalid={!!sd && !(toNum(sd) > 0)} />}
          </Field>
          <Field label={t('qc.col.unit')}>
            {(id) => <Input id={id} ltr value={unit} onChange={(e) => setUnit(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('qc.col.expires')}>
          {(id) => <Input id={id} type="date" ltr value={expires} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        <div className="flex items-end pb-1">
          <Switch checked={active} onCheckedChange={setActive} label={t('qc.active')} />
        </div>
      </div>
    </Dialog>
  );
}

/** Enter a QC result; the dialog then shows the Westgard verdict. */
export function RunDialog({ material, onClose }: { material: QcMaterialItem | null; onClose: () => void }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const qc = useQueryClient();
  const insError = useInsError();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [verdict, setVerdict] = useState<QcRunItem | null>(null);
  useEffect(() => {
    setValue('');
    setNote('');
    setVerdict(null);
  }, [material]);
  const num = toNum(value);
  const save = useMutation({
    mutationFn: () => ins.addRun({ materialId: material!.id, value: num, note: note.trim() || undefined }),
    onSuccess: (run) => {
      setVerdict(run);
      void qc.invalidateQueries({ queryKey: ['qc'] });
    },
    onError: (err) => toast.error(insError(err)),
  });
  return (
    <Dialog
      open={!!material}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t('qc.enterRun')}
      description={
        material ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
            <Code>{material.analyte.code}</Code>
            <span className="text-faint">·</span>
            <bdi>{`${material.name} ${material.level}`}</bdi>
            <span className="text-faint">·</span>
            <span>
              {t('qc.col.lot')} <Code>{material.lot}</Code>
            </span>
          </span>
        ) : undefined
      }
      footer={
        verdict ? (
          <Button variant="primary" onClick={onClose}>
            {t('common:actions.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" disabled={!value.trim() || !Number.isFinite(num)} loading={save.isPending} onClick={() => save.mutate()}>
              {t('qc.evaluate')}
            </Button>
          </>
        )
      }
    >
      {verdict ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip kind="qc" status={verdict.status} />
            <Code className="text-[15px] font-semibold">{f.number(verdict.value)}</Code>
            {verdict.z !== null ? <Code className="text-muted">z = {f.number(verdict.z, 2)}</Code> : null}
          </div>
          {verdict.violations.length ? (
            <Callout tone={verdict.status === 'rejected' ? 'crit' : 'warn'} title={verdict.status === 'rejected' ? t('qc.rejectedTitle') : t('qc.warningTitle')}>
              <ul className="list-inside list-disc">
                {verdict.violations.map((v) => (
                  <li key={v}>
                    <Badge tone={verdict.status === 'rejected' ? 'crit' : 'warn'} className="me-1 ltr-num">
                      {v}
                    </Badge>
                    {t(`qc.rules.${v}`, { defaultValue: v })}
                  </li>
                ))}
              </ul>
              {verdict.status === 'rejected' ? <p className="mt-2">{t('qc.rejectedAction')}</p> : null}
            </Callout>
          ) : (
            <Callout tone="info" title={t('qc.acceptedTitle')}>
              {t('qc.acceptedBody')}
            </Callout>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim() && Number.isFinite(num)) save.mutate();
          }}
        >
          <Field label={t('qc.value')} hint={
              material ? (
                <>
                  {t('qc.col.target')} <Code>{`${f.number(material.targetMean)} ± ${f.number(material.targetSd)} ${material.unit ?? ''}`.trim()}</Code>
                </>
              ) : undefined
            } required>
            {(id) => <Input id={id} ltr autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <Field label={t('qc.note')}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </form>
      )}
    </Dialog>
  );
}
