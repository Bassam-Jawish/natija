import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import type { FinanceExpense, FinanceExpenseCategory, FinanceExpenseList } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, Money, PageHeader, Select, toast, Tooltip, type ColumnDef } from '@/components/ui';
import { financeKeys } from '../api';
import { BarList } from '../components/charts';
import { BilingualFields, FilterBar, settle, useAdminError, usePairName, useRangeParam } from '../components/common';
import { ExpenseForm, useExpenseCategories } from '../components/finance/ExpenseForm';
import { useMySession } from '../components/finance/SessionCard';

const LIMIT = 50;
const end = { align: 'end' as const };

export default function ExpensesPage() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const name = usePairName();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const { can } = useAuth();
  const dayOfMonth = Number(f.today().slice(8, 10));
  const [range, setRange] = useRangeParam(dayOfMonth - 1);
  const [categoryId, setCategoryId] = useState('all');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FinanceExpense | null>(null);
  const session = useMySession();
  const categories = useExpenseCategories();
  const manage = can('finance.expenses');
  useEffect(() => setOffset(0), [range.from, range.to, categoryId]);
  const filters = { ...range, categoryId: categoryId === 'all' ? undefined : categoryId };
  const query = useQuery({
    queryKey: financeKeys.expenses({ ...filters, offset }),
    queryFn: () => api.get<FinanceExpenseList>('/finance/expenses', { ...filters, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/finance/expenses/${id}`),
    onSuccess: () => {
      toast.success(t('common.deleted'));
      void qc.invalidateQueries({ queryKey: financeKeys.all });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const columns: ColumnDef<FinanceExpense, unknown>[] = [
    { header: t('common.date'), id: 'date', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.date(row.original.paidAt)}</span> },
    { header: t('fields.categoryId'), id: 'category', cell: ({ row }) => bi({ nameAr: row.original.categoryNameAr, nameEn: row.original.categoryNameEn }, 'name') },
    { header: t('common.notes'), id: 'note', cell: ({ row }) => <span className="text-ink-2">{row.original.note ?? ''}</span> },
    {
      header: t('finance.expense.source'),
      id: 'source',
      cell: ({ row }) =>
        row.original.cashSessionId ? (
          <Badge tone="info">
            <Wallet className="size-3" />
            {t('finance.expense.drawer')}
          </Badge>
        ) : (
          <span className="text-[12.5px] text-muted">{t('finance.expense.office')}</span>
        ),
    },
    { header: t('common.by'), id: 'by', cell: ({ row }) => <span className="text-muted">{name(row.original.createdByNameAr, row.original.createdByNameEn)}</span> },
    { header: t('common.amount'), id: 'amount', meta: end, cell: ({ row }) => <Money value={row.original.amount} className="font-medium" /> },
    {
      id: 'actions',
      header: '',
      meta: end,
      cell: ({ row }) =>
        manage ? (
          row.original.sessionClosed ? (
            <Tooltip content={t('finance.expense.locked')}>
              <span className="inline-flex text-faint">
                <Lock className="size-4" />
              </span>
            </Tooltip>
          ) : (
            <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} onClick={() => setRemoving(row.original)}>
              <Trash2 />
            </Button>
          )
        ) : null,
    },
  ];
  const d = query.data;
  return (
    <div>
      <PageHeader
        title={t('finance.expense.title')}
        description={t('finance.expense.description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus />
              {t('finance.expense.add')}
            </Button>
          ) : null
        }
      />
      <FilterBar range={range} onRange={setRange}>
        <Select
          size="sm"
          value={categoryId}
          onValueChange={setCategoryId}
          className="w-52"
          options={[{ value: 'all', label: t('finance.expense.allCategories') }, ...(categories.data ?? []).map((c) => ({ value: c.id, label: bi(c, 'name') }))]}
        />
      </FilterBar>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <DataTable
            columns={columns}
            data={d?.items}
            loading={query.isLoading}
            error={query.error}
            onRetry={() => void query.refetch()}
            getRowId={(r) => r.id}
            dense
            empty={{ title: t('finance.expense.none') }}
            pagination={d ? { total: d.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card title={t('finance.expense.total')} description={t('finance.expense.period', { from: f.date(range.from), to: f.date(range.to) })}>
            <Money value={d?.sum ?? 0} className="text-[26px] font-semibold text-ink" />
            {d?.byCategory.length ? (
              <div className="mt-3">
                <BarList data={d.byCategory} label={(c) => bi(c, 'name')} series={[{ key: 'amount', label: t('common.amount') }]} valueFormat={(v) => f.number(v)} labelWidth={130} />
              </div>
            ) : null}
          </Card>
          <CategoriesCard categories={categories.data ?? []} manage={manage} />
        </div>
      </div>
      <Dialog open={adding} onOpenChange={setAdding} title={t('finance.expense.add')} description={session.data?.session ? t('finance.expense.drawerOpen') : undefined}>
        <ExpenseForm drawer={!!session.data?.session} onDone={() => setAdding(false)} />
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        tone="danger"
        title={t('finance.expense.deleteTitle')}
        description={removing ? `${bi({ nameAr: removing.categoryNameAr, nameEn: removing.categoryNameEn }, 'name')} · ${f.money(removing.amount)} · ${f.date(removing.paidAt)}` : undefined}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => settle(remove.mutateAsync(removing!.id))}
      />
    </div>
  );
}

function CategoriesCard({ categories, manage }: { categories: FinanceExpenseCategory[]; manage: boolean }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const f = useFormat();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [editing, setEditing] = useState<FinanceExpenseCategory | 'new' | null>(null);
  const [removing, setRemoving] = useState<FinanceExpenseCategory | null>(null);
  const [ar, setAr] = useState('');
  const [en, setEn] = useState('');
  useEffect(() => {
    if (editing && editing !== 'new') {
      setAr(editing.nameAr);
      setEn(editing.nameEn);
    } else if (editing === 'new') {
      setAr('');
      setEn('');
    }
  }, [editing]);
  const done = () => void qc.invalidateQueries({ queryKey: financeKeys.categories });
  const save = useMutation({
    mutationFn: () =>
      editing === 'new' ? api.post('/finance/expense-categories', { nameAr: ar, nameEn: en }) : api.put(`/finance/expense-categories/${(editing as FinanceExpenseCategory).id}`, { nameAr: ar, nameEn: en }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      done();
      setEditing(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/finance/expense-categories/${id}`),
    onSuccess: () => {
      toast.success(t('common.deleted'));
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card
      title={t('finance.expense.categories')}
      actions={
        manage ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
            <Plus />
            {t('common:actions.add')}
          </Button>
        ) : null
      }
      padded={false}
    >
      <ul className="divide-y divide-line">
        {categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]">
            <span className="text-ink">{bi(c, 'name')}</span>
            <span className="flex items-center gap-1">
              <span className="me-1 text-[12px] text-muted">{t('finance.expense.uses', { n: f.number(c.useCount) })}</span>
              {manage ? (
                <>
                  <Button size="icon-sm" variant="ghost" aria-label={t('common:actions.edit')} onClick={() => setEditing(c)}>
                    <Pencil />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={t('common:actions.delete')} disabled={c.useCount > 0} onClick={() => setRemoving(c)}>
                    <Trash2 />
                  </Button>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        size="sm"
        title={editing === 'new' ? t('finance.expense.newCategory') : t('finance.expense.editCategory')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} disabled={!ar.trim() || !en.trim()} onClick={() => save.mutate()}>
              {t('common:actions.save')}
            </Button>
          </>
        }
      >
        <BilingualFields ar={ar} en={en} onAr={setAr} onEn={setEn} autoFocus />
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        tone="danger"
        title={t('common.deleteTitle', { name: removing ? bi(removing, 'name') : '' })}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => settle(remove.mutateAsync(removing!.id))}
      />
    </Card>
  );
}
