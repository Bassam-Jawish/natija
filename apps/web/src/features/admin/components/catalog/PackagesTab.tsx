import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Package as PackageIcon, Plus, Trash2 } from 'lucide-react';
import { CATALOG_PRICE_MODES, type CatalogPackage, type CatalogPackageInput } from '@natija/contracts';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, ConfirmDialog, DataTable, Drawer, Field, Input, Money, SearchInput, Segmented, Switch, type ColumnDef } from '@/components/ui';
import { useCatalogTests, usePackages } from '../../api';
import { ActiveBadge, BilingualFields, Code, FilterBar, NumberField, numText, toNumber, useFieldErrors } from '../common';
import { OrderedPicker } from './OrderedPicker';
import { FormSection, useCatalogSave } from './shared';

type Mode = (typeof CATALOG_PRICE_MODES)[number];

/** Test packages (profiles) and how they are priced. */
export function PackagesTab() {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const packages = usePackages();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<CatalogPackage | 'new' | null>(null);

  const rows = useMemo(() => {
    const raw = q.trim().toLowerCase();
    return (packages.data ?? []).filter((p) => !raw || p.code.toLowerCase().startsWith(raw) || p.nameEn.toLowerCase().includes(raw) || p.nameAr.includes(q.trim()));
  }, [packages.data, q]);

  const columns = useMemo<ColumnDef<CatalogPackage>[]>(
    () => [
      { accessorKey: 'code', header: t('catalog.packages.cols.code'), cell: ({ row }) => <Code className="font-medium text-ink">{row.original.code}</Code>, size: 120 },
      { id: 'name', accessorFn: (r) => bi(r, 'name'), header: t('catalog.packages.cols.name') },
      { accessorKey: 'priceMode', header: t('catalog.packages.cols.mode'), cell: ({ row }) => <Badge tone="neutral">{t(`catalog.packages.modes.${row.original.priceMode}`)}</Badge>, size: 130 },
      {
        id: 'price',
        accessorFn: (r) => r.fixedPrice ?? r.units ?? r.testUnits,
        header: t('catalog.packages.cols.price'),
        cell: ({ row }) => {
          const p = row.original;
          if (p.priceMode === 'fixed') return <Money value={p.fixedPrice} />;
          if (p.priceMode === 'units') return <span className="tabular ltr-num">{t('catalog.packages.unitsValue', { n: f.number(p.units ?? 0) })}</span>;
          return <span className="text-muted">{t('catalog.packages.sumOfTests')}</span>;
        },
        meta: { align: 'end' },
        size: 150,
      },
      { id: 'tests', accessorFn: (r) => r.testIds.length, header: t('catalog.packages.cols.tests'), cell: ({ getValue }) => <span className="tabular ltr-num">{f.number(getValue<number>())}</span>, meta: { align: 'end' }, size: 90 },
      { accessorKey: 'testUnits', header: t('catalog.packages.cols.testUnits'), cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{f.number(row.original.testUnits)}</span>, meta: { align: 'end' }, size: 110 },
      { id: 'status', accessorFn: (r) => (r.isActive ? 1 : 0), header: t('catalog.packages.cols.status'), cell: ({ row }) => <ActiveBadge active={row.original.isActive} />, size: 90 },
    ],
    [t, bi, f],
  );

  return (
    <div>
      <FilterBar
        end={
          manage ? (
            <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus />
              {t('catalog.actions.newPackage')}
            </Button>
          ) : null
        }
      >
        <SearchInput value={q} onChange={setQ} placeholder={t('catalog.packages.search')} className="h-8 w-72" />
      </FilterBar>
      <DataTable
        columns={columns}
        data={rows}
        loading={packages.isLoading}
        error={packages.error}
        onRetry={() => void packages.refetch()}
        onRowClick={(p) => setEditing(p)}
        rowClassName={(r) => (!r.isActive ? 'opacity-60' : undefined)}
        dense
        empty={{ icon: PackageIcon, title: q ? t('catalog.packages.noMatches') : t('catalog.packages.empty'), description: q ? undefined : t('catalog.packages.emptyHint') }}
      />
      {editing ? <PackageEditor pkg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function PackageEditor({ pkg, onClose }: { pkg: CatalogPackage | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const tests = useCatalogTests({ active: 'all' });
  const [code, setCode] = useState(pkg?.code ?? '');
  const [nameAr, setNameAr] = useState(pkg?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(pkg?.nameEn ?? '');
  const [mode, setMode] = useState<Mode>(pkg?.priceMode ?? 'sum');
  const [units, setUnits] = useState(numText(pkg?.units));
  const [price, setPrice] = useState(numText(pkg?.fixedPrice));
  const [isActive, setIsActive] = useState(pkg?.isActive ?? true);
  const [testIds, setTestIds] = useState<string[]>(pkg?.testIds ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useCatalogSave(
    (body: z.input<typeof CatalogPackageInput>) => (pkg ? api.put(`/catalog/packages/${pkg.id}`, body) : api.post('/catalog/packages', body)),
    { success: pkg ? t('common.saved') : t('common.created'), onSuccess: onClose },
  );
  const remove = useCatalogSave(() => api.del(`/catalog/packages/${pkg!.id}`), { success: t('common.deleted'), onSuccess: onClose });
  const fe = useFieldErrors(save.error);

  const byId = useMemo(() => new Map((tests.data ?? []).map((x) => [x.id, x])), [tests.data]);
  const items = useMemo(
    () =>
      (tests.data ?? [])
        .filter((x) => x.isActive || testIds.includes(x.id))
        .map((x) => ({ id: x.id, code: x.code, label: bi(x, 'name'), extra: <span className="text-[12px] text-muted tabular ltr-num">{t('catalog.packages.unitsValue', { n: f.number(x.units) })}</span> })),
    [tests.data, testIds, bi, f, t],
  );
  const sumUnits = testIds.reduce((a, id) => a + (byId.get(id)?.units ?? 0), 0);
  const unitsN = toNumber(units);
  const priceN = toNumber(price);
  const valid =
    code.trim() &&
    nameAr.trim() &&
    nameEn.trim() &&
    testIds.length > 0 &&
    (mode !== 'units' || (unitsN !== null && unitsN >= 0)) &&
    (mode !== 'fixed' || (priceN !== null && priceN >= 0));

  const submit = () => {
    if (!valid || !manage) return;
    save.mutate({
      code: code.trim(),
      nameAr,
      nameEn,
      priceMode: mode,
      units: mode === 'units' ? unitsN : null,
      fixedPrice: mode === 'fixed' ? priceN : null,
      isActive,
      testIds,
    });
  };

  return (
    <>
      <Drawer
        open
        onOpenChange={(o) => !o && onClose()}
        title={pkg ? t('catalog.packages.editorEdit') : t('catalog.packages.editorNew')}
        description={pkg ? `${pkg.code} · ${bi(pkg, 'name')}` : undefined}
        width="md"
        footer={
          <>
            {pkg && manage ? (
              <Button variant="ghost" className="me-auto text-crit" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t('catalog.actions.delete')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              {t('catalog.actions.cancel')}
            </Button>
            {manage ? (
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
                {t('catalog.actions.save')}
              </Button>
            ) : null}
          </>
        }
      >
        <fieldset disabled={!manage} className="contents">
          <FormSection title={t('catalog.packages.sections.identity')}>
            <div className="grid gap-3">
              <div className="flex flex-wrap items-end gap-4">
                <Field label={t('fields.code')} required error={fe.code} className="w-44">
                  {(id) => <Input id={id} ltr className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus={!pkg} invalid={!!fe.code} />}
                </Field>
                <div className="pb-2">
                  <Switch checked={isActive} onCheckedChange={setIsActive} label={t('common.active')} disabled={!manage} />
                </div>
              </div>
              <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} errorAr={fe.nameAr} errorEn={fe.nameEn} />
            </div>
          </FormSection>
          <FormSection title={t('catalog.packages.sections.price')} description={t(`catalog.packages.modeHints.${mode}`)}>
            <Segmented<Mode> value={mode} onChange={(v) => manage && setMode(v)} options={CATALOG_PRICE_MODES.map((m) => ({ value: m, label: t(`catalog.packages.modes.${m}`) }))} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {mode === 'units' ? (
                <NumberField label={t('fields.units')} required value={units} onChange={setUnits} error={fe.units} hint={t('catalog.packages.sumUnits', { n: f.number(sumUnits) })} />
              ) : null}
              {mode === 'fixed' ? <NumberField label={t('fields.fixedPrice')} required value={price} onChange={setPrice} error={fe.fixedPrice} suffix={f.currencyLabel()} /> : null}
              {mode === 'sum' ? <p className="text-[12.5px] text-muted sm:col-span-2">{t('catalog.packages.sumUnits', { n: f.number(sumUnits) })}</p> : null}
            </div>
          </FormSection>
          <FormSection title={t('catalog.packages.sections.tests')} actions={<Badge tone="neutral">{f.number(testIds.length)}</Badge>}>
            <OrderedPicker
              value={testIds}
              onChange={setTestIds}
              items={items}
              ordered={false}
              placeholder={t('catalog.packages.pickTest')}
              emptyText={t('catalog.packages.testsEmpty')}
              disabled={!manage}
              invalid={!!fe.testIds}
            />
          </FormSection>
        </fieldset>
      </Drawer>
      {pkg ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          title={t('common.deleteTitle', { name: pkg.code })}
          description={t('catalog.packages.deleteBody')}
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
