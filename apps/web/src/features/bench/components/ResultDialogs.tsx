import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhoneCall, Siren } from 'lucide-react';
import type { BenchResult } from '@natija/contracts';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Drawer,
  ErrorState,
  ESignDialog,
  Field,
  FlagChip,
  Input,
  Select,
  Skeleton,
  StatusChip,
  Textarea,
  toast,
} from '@/components/ui';
import { benchApi, benchKeys } from '../api';
import { ResultValue, SourceIcon, useBenchError, useSignedAction } from './common';

function useInvalidateResults() {
  const qc = useQueryClient();
  return () => {
    for (const key of [['results'], ['worklists'], ['validation'], ['reports'], ['orders']]) void qc.invalidateQueries({ queryKey: key });
  };
}

function ResultSummary({ result }: { result: BenchResult }) {
  const bi = useBi();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-sunken px-3 py-2">
      <div className="min-w-0">
        <div className="font-medium text-ink">{bi(result.analyte, 'name')}</div>
        <div className="text-[12px] text-muted">{bi(result.test, 'name')}</div>
      </div>
      <div className="flex items-center gap-2">
        <ResultValue result={result} />
        {result.unit ? <span className="ltr-num text-[12px] text-muted">{result.unit}</span> : null}
      </div>
    </div>
  );
}

/** Record the phone call that reported a critical value (required before release). */
export function CriticalCallDialog({ result, defaultRecipient, onOpenChange }: { result: BenchResult | null; defaultRecipient?: string | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('bench');
  const errorMessage = useBenchError();
  const invalidate = useInvalidateResults();
  const [name, setName] = useState('');
  const [role, setRole] = useState('doctor');
  const [phone, setPhone] = useState('');
  const [readBack, setReadBack] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (result) {
      setName(defaultRecipient ?? '');
      setRole('doctor');
      setPhone('');
      setReadBack(false);
      setNote('');
    }
  }, [result, defaultRecipient]);
  const mutation = useMutation({
    mutationFn: () => benchApi.criticalCall(result!.id, { recipientName: name.trim(), recipientRole: role, phone: phone.trim() || null, readBack, note: note.trim() || null }),
    onSuccess: () => {
      toast.success(t('critical.recorded'));
      invalidate();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const valid = name.trim().length >= 2;
  return (
    <Dialog
      open={!!result}
      onOpenChange={onOpenChange}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <Siren className="size-5 text-crit" />
          {t('critical.callTitle')}
        </span>
      }
      description={t('critical.callHint')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!valid} onClick={() => mutation.mutate()}>
            <PhoneCall />
            {t('critical.save')}
          </Button>
        </>
      }
    >
      {result ? (
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) mutation.mutate();
          }}
        >
          <ResultSummary result={result} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('critical.recipient')} required>
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />}
            </Field>
            <Field label={t('critical.role')}>
              {(id) => (
                <Select
                  id={id}
                  value={role}
                  onValueChange={setRole}
                  options={['doctor', 'nurse', 'patient', 'other'].map((r) => ({ value: r, label: t(`critical.roles.${r}`) }))}
                />
              )}
            </Field>
          </div>
          <Field label={t('critical.phone')}>{(id) => <Input id={id} ltr value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" />}</Field>
          <Checkbox checked={readBack} onCheckedChange={setReadBack} label={t('critical.readBack')} />
          <Field label={t('critical.note')}>{(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
        </form>
      ) : null}
    </Dialog>
  );
}

export function CommentDialog({ result, onOpenChange }: { result: BenchResult | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('bench');
  const errorMessage = useBenchError();
  const invalidate = useInvalidateResults();
  const [text, setText] = useState('');
  useEffect(() => {
    if (result) setText(result.comment ?? '');
  }, [result]);
  const mutation = useMutation({
    mutationFn: () => benchApi.setComment(result!.id, text.trim() || null),
    onSuccess: () => {
      toast.success(t('entry.commentSaved'));
      invalidate();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open={!!result}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('entry.commentTitle')}
      description={t('entry.commentHint')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={mutation.isPending} onClick={() => mutation.mutate()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <ResultSummary result={result} />
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} autoFocus />
        </div>
      ) : null}
    </Dialog>
  );
}

/** Amend a released result: new value + reason, e-signed; the report is re-issued. */
export function AmendDialog({ result, onOpenChange }: { result: BenchResult | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('bench');
  const invalidate = useInvalidateResults();
  const signed = useSignedAction();
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (result) {
      setValue(result.value ?? '');
      setReason('');
    }
  }, [result]);
  return (
    <ESignDialog
      open={!!result}
      onOpenChange={onOpenChange}
      title={t('amend.title')}
      description={t('amend.description')}
      confirmLabel={t('amend.confirm')}
      onConfirm={signed(async (password) => {
        if (!value.trim() || reason.trim().length < 3) throw new ApiError(400, 'amend_missing', t('amend.missing'));
        const res = await benchApi.amend(result!.id, { value: value.trim(), reason: reason.trim(), password });
        toast.success(t('amend.done', { version: res.report.version }));
        invalidate();
      })}
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <ResultSummary result={result} />
          <Field label={t('amend.newValue')} required>
            {(id) =>
              result.analyte.resultType === 'option' && result.analyte.options.length ? (
                <Select id={id} value={value} onValueChange={setValue} options={result.analyte.options.map((o) => ({ value: o, label: o }))} />
              ) : (
                <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} ltr={result.analyte.resultType === 'numeric'} inputMode={result.analyte.resultType === 'numeric' ? 'decimal' : undefined} />
              )
            }
          </Field>
          <Field label={t('amend.reason')} hint={t('amend.reasonHint')} required>
            {(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </Field>
        </div>
      ) : null}
    </ESignDialog>
  );
}

/** Attempts, versions, calls and the audit trail of one result. */
export function ResultHistoryDrawer({ resultId, onOpenChange }: { resultId: string | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  const bi = useBi();
  const query = useQuery({ queryKey: benchKeys.history(resultId ?? ''), queryFn: () => benchApi.history(resultId!), enabled: !!resultId });
  const h = query.data;
  const person = (u: { fullNameAr: string; fullNameEn: string } | null) => (u ? bi(u, 'fullName') : t('history.system'));
  return (
    <Drawer open={!!resultId} onOpenChange={onOpenChange} width="lg" title={h ? bi(h.result.analyte, 'name') : t('history.title')} description={h ? bi(h.result.test, 'name') : undefined}>
      {query.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : h ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5">
            <ResultValue result={h.result} className="text-base" />
            {h.result.unit ? <span className="ltr-num text-muted">{h.result.unit}</span> : null}
            <StatusChip kind="result" status={h.result.status} />
            {h.result.amended ? <Badge tone="warn">{t('amend.badge')}</Badge> : null}
            <span className="ms-auto text-[12.5px] text-muted">
              {t('history.reference')}: <span className="ltr-num">{h.result.refText ?? '—'}</span>
            </span>
          </div>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">{t('history.attempts')}</h3>
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-sunken text-[11.5px] text-muted">
                  <tr>
                    <th className="px-3 py-1.5 text-start font-semibold">{t('history.when')}</th>
                    <th className="px-3 py-1.5 text-start font-semibold">{t('history.value')}</th>
                    <th className="px-3 py-1.5 text-start font-semibold">{t('history.source')}</th>
                    <th className="px-3 py-1.5 text-start font-semibold">{t('history.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {h.attempts.map((a) => (
                    <tr key={a.id} className="border-t border-line align-top">
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted">{f.dateTime(a.measuredAt ?? a.createdAt)}</td>
                      <td className="px-3 py-1.5">
                        <span className="ltr-num tabular font-medium">{a.value ?? t('history.cleared')}</span>
                        {a.dilution ? <span className="ms-1 ltr-num text-[11px] text-muted">×{a.dilution}</span> : null}
                        {a.selected ? (
                          <Badge tone="ok" className="ms-2 h-[18px] text-[11px]">
                            {t('history.current')}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <SourceIcon result={{ source: a.source, instrument: a.instrument }} />
                          <span className="text-[12.5px] text-ink-2">{a.source === 'manual' ? person(a.enteredBy) : a.source === 'instrument' ? (a.instrument?.name ?? '') : t('source.calculated')}</span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-[12.5px] text-muted">{a.note ?? (a.rawFlag ? `${t('history.rawFlag')}: ${a.rawFlag}` : '')}</td>
                    </tr>
                  ))}
                  {!h.attempts.length ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-center text-muted">
                        {t('history.noAttempts')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {h.versions.length ? (
            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">{t('history.versions')}</h3>
              <ul className="flex flex-col gap-1.5">
                {h.versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                    <Badge tone="neutral" className="ltr-num">v{v.version}</Badge>
                    <span className="ltr-num tabular font-medium">{v.value ?? '—'}</span>
                    <FlagChip flag={v.flag} />
                    <StatusChip kind="result" status={v.status} />
                    <span className="text-[12.5px] text-muted">{v.reason}</span>
                    <span className="ms-auto text-[12px] text-muted">
                      {person(v.changedBy)} · {f.dateTime(v.changedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {h.criticalCalls.length ? (
            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">{t('critical.calls')}</h3>
              <ul className="flex flex-col gap-1.5">
                {h.criticalCalls.map((c) => (
                  <li key={c.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <PhoneCall className="size-4 text-crit" />
                      <span className="font-medium">{c.recipientName}</span>
                      <span className="text-muted">({t(`critical.roles.${c.recipientRole}`)})</span>
                      {c.phone ? <span className="ltr-num text-muted">{c.phone}</span> : null}
                      {c.readBack ? <Badge tone="ok">{t('critical.readBackShort')}</Badge> : null}
                      <span className="ms-auto text-[12px] text-muted">
                        {person(c.calledBy)} · {f.dateTime(c.calledAt)}
                      </span>
                    </div>
                    {c.note ? <p className="mt-1 text-[12.5px] text-muted">{c.note}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">{t('history.audit')}</h3>
            <ol className="flex flex-col gap-2 border-s border-line ps-4">
              {h.audit.map((a) => (
                <li key={a.id} className="relative text-sm">
                  <span className="absolute -start-[20.5px] top-[7px] size-2 rounded-full bg-line-strong" />
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium text-ink">{t(`audit.${a.action}`, { defaultValue: a.action })}</span>
                    <span className="text-[12px] text-muted">
                      {a.actorName ?? t('history.system')} · {f.dateTime(a.at)}
                    </span>
                  </div>
                  {a.summary ? <div className="ltr-num text-[12.5px] text-muted">{a.summary}</div> : null}
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
