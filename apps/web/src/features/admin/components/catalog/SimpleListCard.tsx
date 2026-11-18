import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { CatalogContainer, CatalogDepartment, CatalogRejectionReason, CatalogSampleType } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Button, Card, ConfirmDialog, DataTable, Dialog, Field, Input, TubeIcon, type ColumnDef } from '@/components/ui';
import { BilingualFields, Code, NumberField, numText, toNumber, useFieldErrors } from '../common';
import { CapColorPicker, useCatalogSave } from './shared';

export type SimpleKind = 'department' | 'sample_type' | 'container' | 'rejection_reason';
type Row = CatalogDepartment | CatalogSampleType | CatalogContainer | CatalogRejectionReason;

const PATHS: Record<SimpleKind, string> = {
  department: 'departments',
  sample_type: 'sample-types',
  container: 'containers',
  rejection_reason: 'rejection-reasons',
};

const uses = (r: Row) => ('testCount' in r ? r.testCount : 'useCount' in r ? r.useCount : 0);

/** A small reference list (departments, specimens, tubes, rejection reasons) with a dialog editor. */
export function SimpleListCard({ kind, rows, loading, error, onRetry }: { kind: SimpleKind; rows: Row[] | undefined; loading: boolean; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const [editing, setEditing] = useState<Row | 'new' | null>(null);

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    const cols: ColumnDef<Row>[] = [
      { accessorKey: 'code', header: t('catalog.simple.cols.code'), cell: ({ row }) => <Code className="font-medium text-ink">{row.original.code}</Code>, size: 120 },
      { id: 'name', accessorFn: (r) => bi(r, 'name'), header: t('catalog.simple.cols.name') },
    ];
    if (kind === 'container') {
      cols.push({
        id: 'cap',
        accessorFn: (r) => (r as CatalogContainer).capColor,
        header: t('catalog.simple.cols.cap'),
        cell: ({ row }) => {
          const c = row.original as CatalogContainer;
          return (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <TubeIcon cap={c.capColor} className="h-5 w-3" />
              {t(`catalog.caps.${c.capColor}`, { defaultValue: c.capColor })}
            </span>
          );
        },
      });
      cols.push({
        id: 'volume',
        accessorFn: (r) => (r as CatalogContainer).volumeMl ?? 0,
        header: t('catalog.simple.cols.volume'),
        cell: ({ row }) => {
          const v = (row.original as CatalogContainer).volumeMl;
          return <span className="tabular ltr-num text-ink-2">{v === null ? '—' : `${f.number(v)} mL`}</span>;
        },
        meta: { align: 'end' },
        size: 90,
      });
    }
    if (kind === 'department') {
      cols.push({
        id: 'sort',
        accessorFn: (r) => (r as CatalogDepartment).sortOrder,
        header: t('catalog.simple.cols.sortOrder'),
        cell: ({ getValue }) => <span className="tabular ltr-num text-ink-2">{f.number(getValue<number>())}</span>,
        meta: { align: 'end' },
        size: 80,
      });
    }
    cols.push({
      id: 'uses',
      accessorFn: uses,
      header: kind === 'rejection_reason' ? t('catalog.simple.cols.uses') : t('catalog.simple.cols.tests'),
      cell: ({ getValue }) => <span className="tabular ltr-num text-ink-2">{f.number(getValue<number>())}</span>,
      meta: { align: 'end' },
      size: 90,
    });
    return cols;
  }, [kind, t, bi, f]);

  const sorted = useMemo(
    () => [...(rows ?? [])].sort((a, b) => (kind === 'department' ? (a as CatalogDepartment).sortOrder - (b as CatalogDepartment).sortOrder : 0) || a.code.localeCompare(b.code)),
    [rows, kind],
  );

  return (
    <Card
      title={t(`catalog.simple.${kind}.title`)}
      description={t(`catalog.simple.${kind}.description`)}
      padded={false}
      actions={
        manage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            {t(`catalog.simple.${kind}.new`)}
          </Button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        data={sorted}
        loading={loading}
        error={error}
        onRetry={onRetry}
        onRowClick={manage ? (r) => setEditing(r) : undefined}
        dense
        className="rounded-none border-0"
        empty={{ title: t(`catalog.simple.${kind}.empty`) }}
      />
      {editing ? <SimpleEditor kind={kind} row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function SimpleEditor({ kind, row, onClose }: { kind: SimpleKind; row: Row | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const [code, setCode] = useState(row?.code ?? '');
  const [nameAr, setNameAr] = useState(row?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(row?.nameEn ?? '');
  const [sortOrder, setSortOrder] = useState(numText(row && 'sortOrder' in row ? row.sortOrder : 0));
  const [capColor, setCapColor] = useState(row && 'capColor' in row ? row.capColor : 'white');
  const [volume, setVolume] = useState(numText(row && 'volumeMl' in row ? row.volumeMl : null));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const path = `/catalog/${PATHS[kind]}`;

  const save = useCatalogSave((body: Record<string, unknown>) => (row ? api.put(`${path}/${row.id}`, body) : api.post(path, body)), {
    success: row ? t('common.saved') : t('common.created'),
    onSuccess: onClose,
  });
  const remove = useCatalogSave(() => api.del(`${path}/${row!.id}`), { success: t('common.deleted'), onSuccess: onClose });
  const fe = useFieldErrors(save.error);
  const valid = code.trim() && nameAr.trim() && nameEn.trim();

  const submit = () => {
    if (!valid) return;
    const body: Record<string, unknown> = { code: code.trim(), nameAr, nameEn };
    if (kind === 'department') body.sortOrder = Math.max(0, Math.round(toNumber(sortOrder) ?? 0));
    if (kind === 'container') {
      body.capColor = capColor;
      body.volumeMl = toNumber(volume);
    }
    save.mutate(body);
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={row ? t(`catalog.simple.${kind}.edit`) : t(`catalog.simple.${kind}.new`)}
        description={row ? `${row.code} · ${bi(row, 'name')}` : undefined}
        size={kind === 'container' ? 'lg' : 'md'}
        footer={
          <>
            {row ? (
              <Button variant="ghost" className="me-auto text-crit" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t('catalog.actions.delete')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              {t('catalog.actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
              {t('catalog.actions.save')}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('fields.code')} required error={fe.code} className="w-44">
              {(id) => <Input id={id} ltr className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus invalid={!!fe.code} />}
            </Field>
            {kind === 'department' ? <NumberField label={t('catalog.simple.fields.sortOrder')} value={sortOrder} onChange={setSortOrder} step="1" className="w-32" /> : null}
            {kind === 'container' ? <NumberField label={t('catalog.simple.fields.volumeMl')} value={volume} onChange={setVolume} suffix="mL" className="w-36" error={fe.volumeMl} /> : null}
          </div>
          <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} errorAr={fe.nameAr} errorEn={fe.nameEn} />
          {kind === 'container' ? (
            <Field label={t('catalog.simple.fields.capColor')} hint={t('catalog.simple.fields.capHint')}>
              {() => <CapColorPicker value={capColor} onChange={setCapColor} />}
            </Field>
          ) : null}
          {row && uses(row) > 0 ? <p className="text-[12.5px] text-muted">{t(`catalog.simple.inUse`, { n: uses(row) })}</p> : null}
          <button type="submit" hidden />
        </form>
      </Dialog>
      {row ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          title={t('common.deleteTitle', { name: row.code })}
          description={uses(row) > 0 ? t('catalog.simple.deleteInUse', { n: uses(row) }) : t('catalog.simple.deleteBody')}
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
