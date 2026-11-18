import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Wrench } from 'lucide-react';
import { MAINTENANCE_KINDS, MAINTENANCE_OUTCOMES, type MaintenanceItem } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, DataTable, Dialog, Field, Input, Select, Textarea, toast, type ColumnDef, type Tone } from '@/components/ui';
import { ins, keys, type MaintenanceBody } from '../api';
import { useInsError } from './common';

const LIMIT = 30;
const OUTCOME_TONE: Record<MaintenanceItem['outcome'], Tone> = { ok: 'ok', issue: 'warn', failed: 'crit' };

export function MaintenanceOutcome({ outcome }: { outcome: MaintenanceItem['outcome'] }) {
  const { t } = useTranslation('instruments');
  return (
    <Badge tone={OUTCOME_TONE[outcome]} dot>
      {t(`maintenance.outcomes.${outcome}`)}
    </Badge>
  );
}

/** Maintenance and calibration log of one analyzer, with "record maintenance" for qc.write. */
export function MaintenancePanel({ instrumentId }: { instrumentId: string }) {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const params = useMemo(() => ({ instrumentId, limit: LIMIT, offset }), [instrumentId, offset]);
  const q = useQuery({ queryKey: keys.maintenance(params), queryFn: () => ins.maintenance(params), placeholderData: keepPreviousData });
  const columns = useMemo<ColumnDef<MaintenanceItem>[]>(
    () => [
      { id: 'at', header: t('maintenance.col.performedAt'), cell: ({ row }) => <span className="whitespace-nowrap tabular">{f.dateTime(row.original.performedAt)}</span> },
      { id: 'kind', header: t('maintenance.col.kind'), cell: ({ row }) => t(`maintenance.kinds.${row.original.kind}`) },
      { id: 'outcome', header: t('maintenance.col.outcome'), cell: ({ row }) => <MaintenanceOutcome outcome={row.original.outcome} /> },
      { id: 'by', header: t('maintenance.col.by'), cell: ({ row }) => row.original.performedByName || bi(row.original.performedBy, 'fullName') || '—' },
      { id: 'description', header: t('maintenance.col.description'), cell: ({ row }) => <span className="text-[12.5px] text-ink-2">{row.original.description ?? ''}</span> },
      {
        id: 'next',
        header: t('maintenance.col.nextDue'),
        cell: ({ row }) =>
          row.original.nextDueAt ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="tabular">{f.date(row.original.nextDueAt)}</span>
              {row.original.overdue ? <Badge tone="crit">{t('maintenance.overdue')}</Badge> : null}
            </span>
          ) : (
            '—'
          ),
      },
    ],
    [t, f, bi],
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{t('maintenance.description')}</p>
        {can('qc.write') ? (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus />
            {t('maintenance.add')}
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={{ icon: Wrench, title: t('maintenance.empty') }}
        pagination={q.data ? { total: q.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
      <MaintenanceDialog open={adding} onClose={() => setAdding(false)} instrumentId={instrumentId} />
    </div>
  );
}

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in the browser's zone. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function MaintenanceDialog({ open, onClose, instrumentId, instruments }: { open: boolean; onClose: () => void; instrumentId?: string; instruments?: Array<{ id: string; code: string; name: string }> }) {
  const { t } = useTranslation('instruments');
  const qc = useQueryClient();
  const insError = useInsError();
  const [instrument, setInstrument] = useState(instrumentId ?? '');
  const [kind, setKind] = useState<MaintenanceBody['kind']>('daily');
  const [outcome, setOutcome] = useState<MaintenanceBody['outcome']>('ok');
  const [performedAt, setPerformedAt] = useState(() => localInput(new Date()));
  const [nextDue, setNextDue] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (!open) return;
    setInstrument(instrumentId ?? '');
    setKind('daily');
    setOutcome('ok');
    setPerformedAt(localInput(new Date()));
    setNextDue('');
    setDescription('');
  }, [open, instrumentId]);
  const save = useMutation({
    mutationFn: () =>
      ins.addMaintenance({
        instrumentId: instrument,
        kind,
        outcome,
        performedAt: new Date(performedAt).toISOString(),
        nextDueAt: nextDue ? new Date(`${nextDue}T08:00`).toISOString() : null,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(t('maintenance.saved'));
      void qc.invalidateQueries({ queryKey: ['qc'] });
      onClose();
    },
    onError: (err) => toast.error(insError(err)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('maintenance.addTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" disabled={!instrument || !performedAt} loading={save.isPending} onClick={() => save.mutate()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {instruments ? (
          <Field label={t('maintenance.instrument')} required className="sm:col-span-2">
            {(id) => (
              <Select
                id={id}
                value={instrument}
                onValueChange={setInstrument}
                placeholder={t('common:actions.choose')}
                options={instruments.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))}
              />
            )}
          </Field>
        ) : null}
        <Field label={t('maintenance.col.kind')} required>
          {(id) => <Select id={id} value={kind} onValueChange={(v) => setKind(v as MaintenanceBody['kind'])} options={MAINTENANCE_KINDS.map((k) => ({ value: k, label: t(`maintenance.kinds.${k}`) }))} />}
        </Field>
        <Field label={t('maintenance.col.outcome')} required>
          {(id) => (
            <Select id={id} value={outcome} onValueChange={(v) => setOutcome(v as MaintenanceBody['outcome'])} options={MAINTENANCE_OUTCOMES.map((o) => ({ value: o, label: t(`maintenance.outcomes.${o}`) }))} />
          )}
        </Field>
        <Field label={t('maintenance.col.performedAt')} required>
          {(id) => <Input id={id} type="datetime-local" ltr value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} />}
        </Field>
        <Field label={t('maintenance.col.nextDue')} hint={t('maintenance.nextDueHint')}>
          {(id) => <Input id={id} type="date" ltr value={nextDue} onChange={(e) => setNextDue(e.target.value)} />}
        </Field>
        <Field label={t('maintenance.col.description')} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('maintenance.descriptionPlaceholder')} />}
        </Field>
      </div>
    </Dialog>
  );
}

