import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeftRight, GitMerge, X } from 'lucide-react';
import type { PatientDetail, PatientListItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button, Card, ConfirmDialog, Field, RadioGroup, Skeleton, Textarea, toast } from '@/components/ui';
import { fd, usePatient, useRefresh } from '../api';
import { PatientFinder } from './PatientFinder';
import { apiCode, Notice, useFdError, usePatientName } from './shared';

type Row = { label: string; a: ReactNode; b: ReactNode; differs: boolean };

/**
 * Merge two records of the same person. Pick the other record, compare them side by side,
 * choose which record stays, give a reason. Orders and attachments move to the record that stays.
 */
export function PatientMerge({ patient }: { patient: PatientDetail }) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const navigate = useNavigate();
  const name = usePatientName();
  const errorText = useFdError();
  const refresh = useRefresh();
  const [picked, setPicked] = useState<PatientListItem | null>(null);
  const other = usePatient(picked?.id);
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState<false | 'normal' | 'force'>(false);

  const merge = useMutation({
    mutationFn: (force: boolean) => {
      const o = other.data!;
      const [sourceId, targetId] = keep === 'this' ? [o.id, patient.id] : [patient.id, o.id];
      return fd.merge({ sourceId, targetId, reason: reason.trim(), force });
    },
    onSuccess: (r) => {
      toast.success(t('merge.done', { count: r.movedOrders }));
      void refresh.patients();
      void refresh.orders();
      setPicked(null);
      setReason('');
      if (r.targetId !== patient.id) navigate(`/patients/${r.targetId}`);
    },
  });
  const mismatch = apiCode(merge.error) === 'merge_mismatch';

  const o = other.data;
  const v = (x: string | null | undefined) => x || '—';
  const rows: Row[] = o
    ? [
        { label: t('patient.mrn'), a: <span className="font-mono ltr-num">{patient.mrn}</span>, b: <span className="font-mono ltr-num">{o.mrn}</span>, differs: false },
        { label: t('patient.fullNameAr'), a: patient.fullNameAr, b: o.fullNameAr, differs: patient.fullNameAr !== o.fullNameAr },
        { label: t('patient.motherNameAr'), a: v(patient.motherNameAr), b: v(o.motherNameAr), differs: (patient.motherNameAr ?? '') !== (o.motherNameAr ?? '') },
        { label: t('patient.fullNameEn'), a: v(patient.fullNameEn), b: v(o.fullNameEn), differs: (patient.fullNameEn ?? '') !== (o.fullNameEn ?? '') },
        { label: t('common:common.sex'), a: t(`common:common.${patient.sex}`), b: t(`common:common.${o.sex}`), differs: patient.sex !== o.sex },
        {
          label: t('patient.birthDate'),
          a: `${f.date(patient.birthDate)}${patient.birthDateEstimated ? ` (${t('patient.estimated')})` : ''}`,
          b: `${f.date(o.birthDate)}${o.birthDateEstimated ? ` (${t('patient.estimated')})` : ''}`,
          differs: patient.birthDate !== o.birthDate,
        },
        { label: t('common:common.phone'), a: <span className="ltr-num">{v(patient.phone)}</span>, b: <span className="ltr-num">{v(o.phone)}</span>, differs: (patient.phone ?? '') !== (o.phone ?? '') },
        { label: t('patient.nationalId'), a: <span className="ltr-num">{v(patient.nationalId)}</span>, b: <span className="ltr-num">{v(o.nationalId)}</span>, differs: (patient.nationalId ?? '') !== (o.nationalId ?? '') },
        { label: t('patient.orders'), a: <span className="tabular">{patient.orderCount}</span>, b: <span className="tabular">{o.orderCount}</span>, differs: false },
        { label: t('finder.lastVisit'), a: f.date(patient.lastVisitAt), b: f.date(o.lastVisitAt), differs: false },
        { label: t('patient.registered'), a: f.date(patient.createdAt), b: f.date(o.createdAt), differs: false },
      ]
    : [];
  const target = keep === 'this' ? patient : o;
  const source = keep === 'this' ? o : patient;

  return (
    <Card title={t('merge.title')} description={t('merge.description')}>
      {!picked ? (
        <PatientFinder excludeId={patient.id} onSelect={setPicked} autoFocus />
      ) : !o ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-sunken text-[12px] text-muted">
                <tr>
                  <th className="px-3 py-2 text-start font-medium" />
                  <th className="px-3 py-2 text-start font-medium">{t('merge.thisRecord')}</th>
                  <th className="px-3 py-2 text-start font-medium">
                    <span className="inline-flex items-center gap-2">
                      {t('merge.otherRecord')}
                      <Button size="icon-sm" variant="ghost" className="size-6" onClick={() => setPicked(null)} aria-label={t('merge.pickAnother')}>
                        <X />
                      </Button>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className={cn('border-t border-line', r.differs && 'bg-warn-soft/60')}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted">
                      <span className="inline-flex items-center gap-1">
                        {r.differs ? <AlertTriangle className="size-3.5 text-warn" aria-label={t('merge.differs')} /> : null}
                        {r.label}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-ink">{r.a}</td>
                    <td className="px-3 py-1.5 text-ink">{r.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Field label={t('merge.keep')}>
            <RadioGroup<'this' | 'other'>
              value={keep}
              onValueChange={setKeep}
              options={[
                { value: 'this', label: t('merge.keepThis', { mrn: patient.mrn }), hint: t('merge.keepThisHint', { mrn: o.mrn }) },
                { value: 'other', label: t('merge.keepOther', { mrn: o.mrn }), hint: t('merge.keepOtherHint', { mrn: patient.mrn }) },
              ]}
            />
          </Field>
          <Field label={t('merge.reason')} required>
            {(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('merge.reasonPlaceholder')} />}
          </Field>
          {mismatch ? (
            <Notice
              tone="crit"
              title={t('merge.mismatchTitle')}
              action={
                <Button size="sm" variant="danger" onClick={() => setConfirm('force')}>
                  {t('merge.force')}
                </Button>
              }
            >
              {t('merge.mismatchHint')}
            </Notice>
          ) : merge.error ? (
            <Notice tone="crit">{errorText(merge.error)}</Notice>
          ) : null}
          <div className="flex justify-end">
            <Button variant="danger" disabled={reason.trim().length < 3} loading={merge.isPending} onClick={() => setConfirm('normal')}>
              <GitMerge />
              {t('merge.confirm')}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(false)}
        tone="danger"
        title={t('merge.confirmTitle')}
        description={
          target && source ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span className="font-mono ltr-num">{source.mrn}</span> {name(source)}
              <ArrowLeftRight className="size-3.5" />
              <span className="font-mono ltr-num">{target.mrn}</span> {name(target)}
              <span className="block w-full">{t('merge.confirmHint')}</span>
            </span>
          ) : undefined
        }
        confirmLabel={confirm === 'force' ? t('merge.force') : t('merge.confirm')}
        onConfirm={async () => {
          await merge.mutateAsync(confirm === 'force').catch(() => undefined);
        }}
      />
    </Card>
  );
}
