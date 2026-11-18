import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { FinanceExpenseCategory } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Button, Field, Input, Select, Switch, Textarea, toast } from '@/components/ui';
import { financeKeys } from '../../api';
import { NumberField, toNumber, useAdminError, useFieldErrors } from '../common';

export function useExpenseCategories() {
  return useQuery({ queryKey: financeKeys.categories, queryFn: () => api.get<FinanceExpenseCategory[]>('/finance/expense-categories'), staleTime: 5 * 60_000 });
}

/**
 * Record an expense. `drawer` is whether the signed-in user has an open cash session; when they
 * do, paying from the drawer is the default and the expense lowers the expected cash.
 */
export function ExpenseForm({ drawer, compact, onDone }: { drawer: boolean; compact?: boolean; onDone?: () => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const categories = useExpenseCategories();
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(f.today());
  const [note, setNote] = useState('');
  const [fromDrawer, setFromDrawer] = useState(drawer);
  useEffect(() => setFromDrawer(drawer), [drawer]);
  const save = useMutation({
    mutationFn: () => api.post('/finance/expenses', { categoryId, amount: toNumber(amount), paidOn, note: note.trim() || null, fromDrawer: drawer && fromDrawer }),
    onSuccess: () => {
      toast.success(t('finance.expense.saved'));
      setAmount('');
      setNote('');
      void qc.invalidateQueries({ queryKey: financeKeys.all });
      onDone?.();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const fieldErrors = useFieldErrors(save.error);
  const value = toNumber(amount);
  const valid = !!categoryId && value !== null && value > 0;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <div className={compact ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'}>
        <Field label={t('fields.categoryId')} required error={fieldErrors.categoryId}>
          {(id) => <Select id={id} value={categoryId} onValueChange={setCategoryId} placeholder={t('common:actions.choose')} options={(categories.data ?? []).map((c) => ({ value: c.id, label: bi(c, 'name') }))} />}
        </Field>
        <NumberField label={t('fields.amount')} value={amount} onChange={setAmount} required error={fieldErrors.amount} />
      </div>
      {!compact ? (
        <Field label={t('fields.paidOn')} error={fieldErrors.paidOn}>
          {(id) => <Input id={id} type="date" value={paidOn} max={f.today()} onChange={(e) => setPaidOn(e.target.value || f.today())} className="w-[170px]" />}
        </Field>
      ) : null}
      <Field label={t('common.notes')}>{(id) => <Textarea id={id} rows={compact ? 1 : 2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      {drawer ? <Switch checked={fromDrawer} onCheckedChange={setFromDrawer} label={t('finance.expense.fromDrawer')} /> : <p className="text-[12.5px] text-muted">{t('finance.expense.noDrawer')}</p>}
      <div>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
          {t('finance.expense.add')}
        </Button>
      </div>
    </form>
  );
}
