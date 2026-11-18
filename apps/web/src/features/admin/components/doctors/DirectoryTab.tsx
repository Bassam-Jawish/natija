import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Stethoscope } from 'lucide-react';
import type { DoctorRow } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi, useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button, DataTable, SearchInput, Segmented, type ColumnDef } from '@/components/ui';
import { adminKeys } from '../../api';
import { ActiveBadge } from '../common';
import { DoctorDrawer } from './DoctorDrawer';

export function DirectoryTab() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const lang = useLang();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'true' | 'false' | 'all'>('true');
  const [editing, setEditing] = useState<DoctorRow | 'new' | null>(null);
  const dq = useDebounced(q.trim(), 300);
  const query = { q: dq || undefined, active };
  const doctors = useQuery({
    queryKey: adminKeys.doctors(query),
    queryFn: () => api.get<DoctorRow[]>('/doctors', query),
    placeholderData: keepPreviousData,
  });

  const columns: ColumnDef<DoctorRow>[] = [
    {
      id: 'name',
      accessorFn: (d) => bi(d, 'name'),
      header: t('doctors.doctor'),
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium">{bi(row.original, 'name')}</div>
          {row.original.nameEn ? <div className="truncate text-[12px] text-muted">{lang === 'ar' ? row.original.nameEn : row.original.nameAr}</div> : null}
        </div>
      ),
    },
    { id: 'specialty', accessorFn: (d) => bi(d, 'specialty'), header: t('doctors.specialty'), cell: ({ row }) => <span className="text-ink-2">{bi(row.original, 'specialty') || '—'}</span> },
    { accessorKey: 'clinic', header: t('doctors.clinic'), cell: ({ row }) => <span className="text-ink-2">{row.original.clinic ?? '—'}</span> },
    { accessorKey: 'phone', header: t('settings.profile.phone'), cell: ({ row }) => <span className="ltr-num text-ink-2">{row.original.phone ?? '—'}</span> },
    { accessorKey: 'orderCount', header: t('doctors.orders'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.number(row.original.orderCount)}</span> },
    { id: 'active', accessorFn: (d) => (d.isActive ? 0 : 1), header: t('common.status'), cell: ({ row }) => <ActiveBadge active={row.original.isActive} /> },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={t('doctors.search')} className="w-72" />
        <Segmented
          size="sm"
          value={active}
          onChange={setActive}
          options={[
            { value: 'true', label: t('common.active') },
            { value: 'false', label: t('common.inactive') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        <Button variant="primary" size="sm" className="ms-auto" onClick={() => setEditing('new')}>
          <Plus />
          {t('doctors.new')}
        </Button>
      </div>
      <div className={cn('transition-opacity', doctors.isFetching && doctors.data && 'opacity-60')}>
        <DataTable
          columns={columns}
          data={doctors.data}
          loading={doctors.isLoading}
          error={doctors.error}
          onRetry={() => void doctors.refetch()}
          onRowClick={(d) => setEditing(d)}
          getRowId={(d) => d.id}
          rowClassName={(d) => (!d.isActive ? 'opacity-60' : undefined)}
          initialSorting={[{ id: 'orderCount', desc: true }]}
          empty={{ icon: Stethoscope, title: dq ? t('common:empty.noMatches') : t('doctors.empty'), description: dq ? undefined : t('doctors.emptyHint') }}
        />
      </div>
      {editing ? <DoctorDrawer key={editing === 'new' ? 'new' : editing.id} doctor={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
