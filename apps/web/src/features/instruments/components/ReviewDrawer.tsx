import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import type { ReviewCandidate } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Button, Checkbox, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, InfoList, Input, Skeleton, StatusChip, toast } from '@/components/ui';
import { ins, keys } from '../api';
import { Callout, Code, RawMessage, useInsError } from './common';

/** One review item: why it was held, the raw message, and the results it could belong to. */
export function ReviewDrawer({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const insError = useInsError();
  const q = useQuery({ queryKey: keys.reviewItem(itemId ?? ''), queryFn: () => ins.reviewItem(itemId!), enabled: !!itemId });
  const item = q.data;
  const message = useQuery({
    queryKey: keys.message(item?.messageId ?? ''),
    queryFn: () => ins.message(item!.messageId!),
    enabled: !!item?.messageId && can('instruments.read'),
  });
  const [resultId, setResultId] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [remember, setRemember] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  useEffect(() => {
    setResultId(null);
    setValue('');
    setNote('');
    setRemember(false);
  }, [itemId]);
  useEffect(() => {
    if (item && !resultId) {
      const mapped = item.candidates.find((c) => c.isMappedAnalyte && c.status !== 'validated' && c.status !== 'released');
      if (mapped) setResultId(mapped.resultId);
    }
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['integration'] });
    void qc.invalidateQueries({ queryKey: ['instruments'] });
    onClose();
  };
  const assign = useMutation({
    mutationFn: () => ins.assign(itemId!, { resultId: resultId!, value: value.trim() || undefined, note: note.trim() || undefined, rememberMapping: remember || undefined }),
    onSuccess: (res) => {
      toast.success(t('review.assigned', { value: res.value }));
      done();
    },
    onError: (err) => toast.error(insError(err)),
  });
  const dismiss = useMutation({
    mutationFn: (reason: string) => ins.dismiss(itemId!, reason),
    onSuccess: () => {
      toast.success(t('review.dismissed'));
      done();
    },
    onError: (err) => toast.error(insError(err)),
  });
  const open = item?.status === 'open';
  const locked = (c: ReviewCandidate) => c.status === 'validated' || c.status === 'released';

  return (
    <Drawer
      open={!!itemId}
      onOpenChange={(o) => !o && onClose()}
      width="lg"
      title={t('review.detailTitle')}
      description={item ? t(`reasons.${item.reason}`) : undefined}
      footer={
        open ? (
          <>
            <Button variant="ghost" onClick={() => setDismissing(true)}>
              {t('common:actions.dismiss')}
            </Button>
            <Button variant="primary" disabled={!resultId} loading={assign.isPending} onClick={() => assign.mutate()}>
              <CheckCircle2 />
              {t('review.assign')}
            </Button>
          </>
        ) : null
      }
    >
      {q.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-48" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : item ? (
        <div className="flex flex-col gap-5">
          <Callout tone="warn" title={t(`reasons.${item.reason}`)}>
            {t(`reasonHints.${item.reason}`)}
            {item.note && item.status !== 'open' ? (
              <span dir="auto" className="mt-1 block text-[12px] text-muted">
                {item.note}
              </span>
            ) : null}
          </Callout>
          <InfoList
            columns={3}
            items={[
              { label: t('review.col.instrument'), value: <Link className="text-accent hover:underline" to={`/instruments/${item.instrument.id}`}>{item.instrument.name}</Link> },
              { label: t('review.col.barcode'), value: <Code>{item.sampleBarcode ?? '—'}</Code> },
              { label: t('review.col.code'), value: <Code className="font-semibold">{item.instrumentCode ?? '—'}</Code> },
              {
                label: t('review.col.value'),
                value: (
                  <Code>
                    {item.valueText ?? '—'} <span className="text-muted">{item.unit ?? ''}</span>
                  </Code>
                ),
              },
              { label: t('review.col.flags'), value: <Code>{item.flags ?? '—'}</Code> },
              { label: t('review.col.status'), value: <StatusChip kind="review" status={item.status} /> },
              { label: t('review.col.received'), value: <span className="tabular">{f.dateTime(item.messageReceivedAt ?? item.createdAt)}</span> },
              { label: t('review.mapping'), value: item.mapping ? <Code>{`${item.instrumentCode} → ${item.mapping.analyteCode} ×${item.mapping.unitFactor}`}</Code> : t('review.noMapping') },
              { label: t('review.source'), value: item.isSimulated ? <Badge tone="violet">{t('message.simulated')}</Badge> : <Badge tone="info">{t('message.fromAgent')}</Badge> },
            ]}
          />
          {item.status !== 'open' ? (
            <Callout tone="info" title={t('review.closed')}>
              {item.resolvedBy ? t('review.closedBy', { name: bi(item.resolvedBy, 'fullName'), when: f.dateTime(item.resolvedAt) }) : null}
            </Callout>
          ) : (
            <section className="flex flex-col gap-3">
              <h3 className="text-[13.5px] font-semibold text-ink">{t('review.candidates')}</h3>
              {item.candidates.length ? (
                <div className="overflow-hidden rounded-lg border border-line">
                  <ul className="max-h-72 divide-y divide-line overflow-auto">
                    {item.candidates.map((c) => (
                      <li key={c.resultId}>
                        <label className={cn('flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-sunken/60', resultId === c.resultId && 'bg-accent-soft', locked(c) && 'cursor-not-allowed opacity-60')}>
                          <input
                            type="radio"
                            name="candidate"
                            className="accent-[var(--c-accent)]"
                            checked={resultId === c.resultId}
                            disabled={locked(c)}
                            onChange={() => setResultId(c.resultId)}
                          />
                          <Code className="font-semibold">{c.analyte.code}</Code>
                          <span className="min-w-0 flex-1 truncate text-ink-2">{bi(c.analyte, 'name')}</span>
                          {c.isMappedAnalyte ? <Badge tone="accent">{t('review.mappedAnalyte')}</Badge> : null}
                          <Code className="text-muted">{c.accession}</Code>
                          {c.sampleBarcode ? <Code className="text-[11.5px] text-muted">{c.sampleBarcode}</Code> : null}
                          <StatusChip kind="result" status={c.status} />
                          <Code className="w-16 text-end">{c.valueText ?? (c.valueNum === null ? '—' : f.number(c.valueNum))}</Code>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <EmptyState title={t('review.noCandidates')} description={t('review.noCandidatesHint')} className="py-6" />
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('review.valueOverride')} hint={t('review.valueOverrideHint', { value: item.valueText ?? '' })}>
                  {(id) => <Input id={id} ltr value={value} onChange={(e) => setValue(e.target.value)} placeholder={item.valueText ?? ''} />}
                </Field>
                <Field label={t('review.note')}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              </div>
              {item.reason === 'unknown_code' && can('instruments.manage') ? (
                <Checkbox checked={remember} onCheckedChange={setRemember} label={t('review.remember', { code: item.instrumentCode ?? '' })} />
              ) : null}
            </section>
          )}
          {message.data ? (
            <section>
              <h3 className="mb-2 flex items-center justify-between text-[13.5px] font-semibold text-ink">
                {t('review.context')}
                <Code className="text-[12px] font-normal text-muted">{message.data.messageType ?? ''}</Code>
              </h3>
              <RawMessage raw={message.data.raw} />
            </section>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={dismissing}
        onOpenChange={setDismissing}
        title={t('review.dismissTitle')}
        description={t('review.dismissHint')}
        confirmLabel={t('common:actions.dismiss')}
        reason="required"
        reasonLabel={t('review.dismissReason')}
        onConfirm={(reason) => dismiss.mutateAsync(reason ?? '')}
      />
    </Drawer>
  );
}
