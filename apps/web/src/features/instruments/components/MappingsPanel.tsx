import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { InstrumentMappingItem } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Combobox, ConfirmDialog, DataTable, Dialog, Field, Input, Switch, toast, type ColumnDef } from '@/components/ui';
import { ins, keys, useFormData } from '../api';
import { Code, useInsError } from './common';

/** Instrument code → lab analyte, with the unit factor that converts the analyzer's unit to the lab's. */
export function MappingsPanel({ instrumentId, query }: { instrumentId: string; query: UseQueryResult<InstrumentMappingItem[]> }) {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const bi = useBi();
  const qc = useQueryClient();
  const insError = useInsError();
  const manage = can('instruments.manage');
  const [editing, setEditing] = useState<InstrumentMappingItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<InstrumentMappingItem | null>(null);
  const [restoring, setRestoring] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['instruments'] });

  const remove = useMutation({
    mutationFn: (m: InstrumentMappingItem) => ins.deleteMapping(instrumentId, m.id),
    onSuccess: () => {
      toast.success(t('mappings.deleted'));
      void refresh();
    },
    onError: (err) => toast.error(insError(err)),
  });
  const defaults = useMutation({
    mutationFn: () => ins.restoreDefaults(instrumentId),
    onSuccess: (res) => {
      toast.success(t('mappings.restored', { count: res.created }));
      void refresh();
    },
    onError: (err) => toast.error(insError(err)),
  });

  const columns = useMemo<ColumnDef<InstrumentMappingItem>[]>(
    () => [
      { id: 'code', header: t('mappings.col.code'), accessorKey: 'instrumentCode', cell: ({ row }) => <Code className="font-semibold">{row.original.instrumentCode}</Code> },
      {
        id: 'analyte',
        header: t('mappings.col.analyte'),
        accessorFn: (m) => m.analyte.code,
        cell: ({ row }) => (
          <span className="inline-flex items-baseline gap-2">
            <Code className="font-semibold">{row.original.analyte.code}</Code>
            <span className="text-[12.5px] text-muted">{bi(row.original.analyte, 'name')}</span>
          </span>
        ),
      },
      { id: 'unit', header: t('mappings.col.instrumentUnit'), cell: ({ row }) => <Code>{row.original.instrumentUnit || '—'}</Code> },
      { id: 'labUnit', header: t('mappings.col.labUnit'), cell: ({ row }) => <Code>{row.original.analyte.unit || '—'}</Code> },
      { id: 'factor', header: t('mappings.col.factor'), meta: { align: 'end' }, cell: ({ row }) => <Code>×{row.original.unitFactor}</Code> },
      {
        id: 'active',
        header: t('mappings.col.active'),
        cell: ({ row }) => (row.original.isActive ? <Badge tone="ok">{t('mappings.active')}</Badge> : <Badge tone="muted">{t('mappings.inactive')}</Badge>),
      },
      ...(manage
        ? [
            {
              id: 'actions',
              header: '',
              meta: { align: 'end' as const },
              cell: ({ row }: { row: { original: InstrumentMappingItem } }) => (
                <span className="inline-flex gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.edit')} onClick={() => setEditing(row.original)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} onClick={() => setDeleting(row.original)}>
                    <Trash2 />
                  </Button>
                </span>
              ),
            } satisfies ColumnDef<InstrumentMappingItem>,
          ]
        : []),
    ],
    [t, bi, manage],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted">{t('mappings.description')}</p>
        {manage ? (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setRestoring(true)} loading={defaults.isPending}>
              <RotateCcw />
              {t('mappings.restore')}
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus />
              {t('mappings.add')}
            </Button>
          </div>
        ) : null}
      </div>
      <DataTable
        dense
        columns={columns}
        data={query.data}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ title: t('mappings.empty'), description: manage ? t('mappings.emptyHint') : undefined }}
        maxHeight="60vh"
      />
      <MappingDialog instrumentId={instrumentId} value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('mappings.deleteTitle', { code: deleting?.instrumentCode ?? '' })}
        description={t('mappings.deleteHint')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => (deleting ? remove.mutateAsync(deleting) : undefined)}
      />
      <ConfirmDialog
        open={restoring}
        onOpenChange={setRestoring}
        title={t('mappings.restoreTitle')}
        description={t('mappings.restoreHint')}
        onConfirm={() => defaults.mutateAsync()}
      />
    </div>
  );
}

function MappingDialog({ instrumentId, value, onClose }: { instrumentId: string; value: InstrumentMappingItem | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation('instruments');
  const bi = useBi();
  const qc = useQueryClient();
  const insError = useInsError();
  const form = useFormData();
  const existing = value && value !== 'new' ? value : null;
  const [code, setCode] = useState('');
  const [analyteId, setAnalyteId] = useState<string | null>(null);
  const [unit, setUnit] = useState('');
  const [factor, setFactor] = useState('1');
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!value) return;
    setCode(existing?.instrumentCode ?? '');
    setAnalyteId(existing?.analyte.id ?? null);
    setUnit(existing?.instrumentUnit ?? '');
    setFactor(String(existing?.unitFactor ?? 1));
    setActive(existing?.isActive ?? true);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const factorNum = Number(factor.replace(',', '.'));
  const valid = code.trim() && analyteId && Number.isFinite(factorNum) && factorNum > 0;
  const save = useMutation({
    mutationFn: () => {
      const body = { instrumentCode: code.trim(), analyteId: analyteId!, instrumentUnit: unit.trim() || null, unitFactor: factorNum, isActive: active };
      return existing ? ins.updateMapping(instrumentId, existing.id, body) : ins.addMapping(instrumentId, body);
    },
    onSuccess: () => {
      toast.success(t('mappings.saved'));
      void qc.invalidateQueries({ queryKey: ['instruments'] });
      onClose();
    },
    onError: (err) => toast.error(insError(err)),
  });
  const options = (form.data?.analytes ?? []).map((a) => ({ value: a.id, label: `${a.code} · ${bi(a, 'name')}`, hint: a.unit ?? undefined }));
  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? t('mappings.editTitle') : t('mappings.addTitle')}
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
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Field label={t('mappings.col.code')} hint={t('mappings.codeHint')} required>
          {(id) => <Input id={id} ltr autoFocus value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label={t('mappings.col.analyte')} required>
          {(id) => <Combobox id={id} value={analyteId} onChange={setAnalyteId} options={options} loading={form.isLoading} />}
        </Field>
        <Field label={t('mappings.col.instrumentUnit')} hint={t('mappings.unitHint')}>
          {(id) => <Input id={id} ltr value={unit} onChange={(e) => setUnit(e.target.value)} />}
        </Field>
        <Field label={t('mappings.col.factor')} hint={t('mappings.factorHint')} required>
          {(id) => <Input id={id} ltr inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} invalid={!(factorNum > 0)} />}
        </Field>
        <div className="sm:col-span-2">
          <Switch checked={active} onCheckedChange={setActive} label={t('mappings.activeLabel')} />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
