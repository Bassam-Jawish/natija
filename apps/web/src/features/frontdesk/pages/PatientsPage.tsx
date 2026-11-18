import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardPlus, UserPlus, Users } from 'lucide-react';
import type { PatientListItem } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Button, DataTable, Drawer, PageHeader, SearchInput, Select, type ColumnDef } from '@/components/ui';
import { fd, keys } from '../api';
import { PatientForm } from '../components/PatientForm';
import { AgeText, LinkButton, SexText, usePatientName } from '../components/shared';

const LIMIT = 50;

function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every patient of the lab: search by name, phone or MRN; register a new one. */
export default function PatientsPage() {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const name = usePatientName();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [qInput, setQInput] = useState(sp.get('q') ?? '');
  const q = useDebounced(qInput.trim(), 300);
  const [creating, setCreating] = useState(false);
  const sex = sp.get('sex') ?? 'all';
  const created = sp.get('created') ?? 'any';
  const offset = Number(sp.get('offset') ?? 0) || 0;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === 'all' || v === 'any') next.delete(k);
      else next.set(k, v);
    }
    if (!('offset' in patch)) next.delete('offset');
    setSp(next, { replace: true });
  };
  useEffect(() => {
    if (q !== (sp.get('q') ?? '')) update({ q }); // eslint-disable-line react-hooks/exhaustive-deps
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = f.today();
  const range: Record<string, { from: string; to: string } | undefined> = {
    today: { from: today, to: today },
    last7: { from: shift(today, -6), to: today },
    last30: { from: shift(today, -29), to: today },
    month: { from: `${today.slice(0, 8)}01`, to: today },
  };
  const params = { q: q || undefined, sex: sex === 'all' ? undefined : sex, ...(range[created] ?? {}), limit: LIMIT, offset };
  const list = useQuery({ queryKey: keys.patients(params), queryFn: () => fd.patients(params), placeholderData: keepPreviousData });

  const columns = useMemo<ColumnDef<PatientListItem>[]>(
    () => [
      { id: 'mrn', header: t('patient.mrn'), accessorKey: 'mrn', cell: ({ row }) => <span className="font-mono text-[12.5px] ltr-num">{row.original.mrn}</span> },
      {
        id: 'name',
        header: t('patients.col.name'),
        accessorFn: (p) => name(p),
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">{row.original.fullNameAr}</span>
            {row.original.fullNameEn ? <span className="truncate text-[12px] text-muted">{row.original.fullNameEn}</span> : null}
          </div>
        ),
      },
      {
        id: 'sexAge',
        header: t('patients.col.sexAge'),
        accessorKey: 'birthDate',
        cell: ({ row }) => (
          <span className="text-ink-2">
            <SexText sex={row.original.sex} /> · <AgeText birthDate={row.original.birthDate} estimated={row.original.birthDateEstimated} />
          </span>
        ),
      },
      { id: 'phone', header: t('common:common.phone'), cell: ({ row }) => <span className="text-ink-2 ltr-num">{row.original.phone ?? '—'}</span> },
      {
        id: 'lastVisit',
        header: t('finder.lastVisit'),
        accessorKey: 'lastVisitAt',
        cell: ({ row }) => (row.original.lastVisitAt ? <span className="tabular" title={f.dateTime(row.original.lastVisitAt)}>{f.date(row.original.lastVisitAt)}</span> : <span className="text-faint">—</span>),
      },
      { id: 'orders', header: t('patient.orders'), accessorKey: 'orderCount', meta: { align: 'end' }, cell: ({ row }) => <span className="tabular">{row.original.orderCount}</span> },
      { id: 'created', header: t('patient.registered'), accessorKey: 'createdAt', cell: ({ row }) => <span className="text-[12.5px] text-muted tabular">{f.date(row.original.createdAt)}</span> },
      {
        id: 'actions',
        header: '',
        size: 44,
        cell: ({ row }) =>
          can('orders.create') ? (
            <LinkButton
              to={`/reception?patient=${row.original.id}`}
              size="icon-sm"
              variant="ghost"
              aria-label={t('patients.newOrderFor', { name: name(row.original) })}
              onClick={(e) => e.stopPropagation()}
            >
              <ClipboardPlus />
            </LinkButton>
          ) : null,
      },
    ],
    [t, f, name, can],
  );

  return (
    <>
      <PageHeader
        title={t('patients.title')}
        description={t('patients.description')}
        actions={
          can('patients.write') ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <UserPlus />
              {t('patients.new')}
            </Button>
          ) : null
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={qInput} onChange={setQInput} placeholder={t('finder.placeholder')} className="w-80" autoFocus />
        <Select
          size="sm"
          className="w-32"
          value={sex}
          onValueChange={(v) => update({ sex: v })}
          options={[
            { value: 'all', label: t('patients.allSexes') },
            { value: 'female', label: t('common:common.female') },
            { value: 'male', label: t('common:common.male') },
          ]}
        />
        <Select
          size="sm"
          className="w-44"
          value={created}
          onValueChange={(v) => update({ created: v })}
          options={[
            { value: 'any', label: t('patients.registeredAny') },
            { value: 'today', label: t('common:dateRange.today') },
            { value: 'last7', label: t('common:dateRange.last7') },
            { value: 'last30', label: t('common:dateRange.last30') },
            { value: 'month', label: t('common:dateRange.month') },
          ]}
        />
      </div>
      <DataTable
        columns={columns}
        data={list.data?.items}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        getRowId={(p) => p.id}
        onRowClick={(p) => navigate(`/patients/${p.id}`)}
        empty={{
          icon: Users,
          title: q ? t('finder.none') : t('patients.empty'),
          action: can('patients.write') ? (
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <UserPlus />
              {t('patients.new')}
            </Button>
          ) : undefined,
        }}
        pagination={{ total: list.data?.total ?? 0, limit: LIMIT, offset, onChange: (o) => update({ offset: String(o) }) }}
        maxHeight="calc(100dvh - 250px)"
      />
      <Drawer open={creating} onOpenChange={setCreating} width="lg" title={t('patients.new')} description={t('patients.newHint')}>
        {creating ? (
          <PatientForm
            compact
            onSaved={(p) => {
              setCreating(false);
              navigate(`/patients/${p.id}`);
            }}
            onUseExisting={(c) => {
              setCreating(false);
              navigate(`/patients/${c.id}`);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : null}
      </Drawer>
    </>
  );
}
