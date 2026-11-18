import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban } from 'lucide-react';
import type { BenchSample } from '@natija/contracts';
import { useBi } from '@/lib/i18n';
import { Button, Dialog, Field, Input, Select, Switch, Textarea, toast } from '@/components/ui';
import { benchApi, useBenchMeta } from '../api';
import { ltr, TubeCell, useBenchError } from './common';

type TubeLike = Pick<BenchSample, 'id' | 'barcode' | 'container'>;

function useInvalidateTubes() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['samples'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['worklists'] });
    void qc.invalidateQueries({ queryKey: ['results'] });
  };
}

/** Reject a tube with a reason; with "recollect" a new tube takes over its tests. */
export function RejectDialog({ tube, onOpenChange, onDone }: { tube: TubeLike | null; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const meta = useBenchMeta();
  const errorMessage = useBenchError();
  const invalidate = useInvalidateTubes();
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [recollect, setRecollect] = useState(true);
  useEffect(() => {
    if (tube) {
      setReasonId('');
      setNote('');
      setRecollect(true);
    }
  }, [tube]);
  const mutation = useMutation({
    mutationFn: () => benchApi.reject(tube!.id, { reasonId, note: note.trim() || null, recollect }),
    onSuccess: (res) => {
      toast.success(res.recollect ? t('reject.doneRecollect', { barcode: ltr(res.recollect.barcode) }) : t('reject.done', { barcode: ltr(res.sample.barcode) }));
      invalidate();
      onOpenChange(false);
      onDone?.();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open={!!tube}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('reject.title')}
      description={t('reject.description')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="danger" loading={mutation.isPending} disabled={!reasonId} onClick={() => mutation.mutate()}>
            <Ban />
            {t('reject.confirm')}
          </Button>
        </>
      }
    >
      {tube ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonId) mutation.mutate();
          }}
        >
          <div className="rounded-lg border border-line bg-sunken px-3 py-2">
            <TubeCell container={tube.container} barcode={tube.barcode} />
          </div>
          <Field label={t('reject.reason')} required>
            {(id) => (
              <Select
                id={id}
                value={reasonId}
                onValueChange={setReasonId}
                placeholder={t('reject.choose')}
                options={(meta.data?.rejectionReasons ?? []).map((r) => ({ value: r.id, label: bi(r, 'name') }))}
              />
            )}
          </Field>
          <Field label={t('reject.note')}>{(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
          <div className="rounded-lg border border-line px-3 py-2.5">
            <Switch checked={recollect} onCheckedChange={setRecollect} label={t('reject.recollect')} />
            <p className="mt-1 text-[12.5px] text-muted">{t('reject.recollectHint')}</p>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** Put a tube on a rack / in a fridge, or move it (mode "transfer" sends it elsewhere). */
export function LocationDialog({
  tube,
  mode,
  onOpenChange,
}: {
  tube: (TubeLike & { storageLocation?: string | null }) | null;
  mode: 'store' | 'transfer';
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('bench');
  const errorMessage = useBenchError();
  const invalidate = useInvalidateTubes();
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (tube) {
      setLocation(mode === 'store' ? (tube.storageLocation ?? '') : '');
      setNote('');
    }
  }, [tube, mode]);
  const mutation = useMutation({
    mutationFn: () =>
      mode === 'store'
        ? benchApi.store(tube!.id, { location: location.trim(), note: note.trim() || null })
        : benchApi.transfer(tube!.id, { toLocation: location.trim(), note: note.trim() || null }),
    onSuccess: (s) => {
      toast.success(mode === 'store' ? t('storage.stored', { barcode: ltr(s.barcode), location: location.trim() }) : t('storage.transferred', { barcode: ltr(s.barcode) }));
      invalidate();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const valid = location.trim().length > 0;
  return (
    <Dialog
      open={!!tube}
      onOpenChange={onOpenChange}
      size="sm"
      title={mode === 'store' ? t('storage.storeTitle') : t('storage.transferTitle')}
      description={mode === 'store' ? t('storage.storeHint') : t('storage.transferHint')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!valid} onClick={() => mutation.mutate()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      {tube ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) mutation.mutate();
          }}
        >
          <div className="rounded-lg border border-line bg-sunken px-3 py-2">
            <TubeCell container={tube.container} barcode={tube.barcode} />
          </div>
          <Field label={mode === 'store' ? t('storage.location') : t('storage.destination')} hint={mode === 'store' ? t('storage.locationExample') : t('storage.destinationExample')} required>
            {(id) => <Input id={id} value={location} onChange={(e) => setLocation(e.target.value)} autoFocus maxLength={120} />}
          </Field>
          <Field label={t('reject.note')}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
        </form>
      ) : null}
    </Dialog>
  );
}
