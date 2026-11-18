import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, LockOpen, Wallet } from 'lucide-react';
import type { FinanceCashSession } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, ErrorState, Money, Skeleton, toast } from '@/components/ui';
import { financeKeys } from '../../api';
import { Metric, NumberField, toNumber, useAdminError } from '../common';
import { CloseSessionDialog } from './dialogs';

export function useMySession() {
  return useQuery({
    queryKey: financeKeys.session,
    queryFn: () => api.get<{ session: FinanceCashSession | null }>('/finance/cash-sessions/current'),
    refetchInterval: 60_000,
  });
}

/** The signed-in user's cash drawer: open it with a float, watch the expected cash, close it with a count. */
export function SessionCard() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const q = useMySession();
  const [float, setFloat] = useState('');
  const [closing, setClosing] = useState<FinanceCashSession | null>(null);
  const open = useMutation({
    mutationFn: () => api.post<FinanceCashSession>('/finance/cash-sessions', { openingFloat: toNumber(float) ?? 0 }),
    onSuccess: () => {
      toast.success(t('finance.session.opened'));
      setFloat('');
      void qc.invalidateQueries({ queryKey: financeKeys.all });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const s = q.data?.session ?? null;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Wallet className="size-4 text-muted" />
          {t('finance.session.title')}
          {s ? <Badge tone="ok" dot>{t('finance.session.isOpen')}</Badge> : q.data ? <Badge tone="muted" dot>{t('finance.session.isClosed')}</Badge> : null}
        </span>
      }
      description={s ? t('finance.session.openedAt', { time: f.dateTime(s.openedAt), name: bi({ nameAr: s.openedByNameAr, nameEn: s.openedByNameEn }, 'name') }) : t('finance.session.hint')}
    >
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="py-6" /> : null}
      {!q.data && !q.error ? <Skeleton className="h-36" /> : null}
      {q.data && !s ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            open.mutate();
          }}
        >
          <NumberField label={t('fields.openingFloat')} value={float} onChange={setFloat} hint={t('finance.session.floatHint')} placeholder="0" />
          <Button type="submit" variant="primary" loading={open.isPending} disabled={toNumber(float) !== null && toNumber(float)! < 0}>
            <LockOpen />
            {t('finance.session.open')}
          </Button>
        </form>
      ) : null}
      {s ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg bg-sunken px-3 py-2.5 text-center">
            <div className="text-[12px] text-muted">{t('finance.session.expected')}</div>
            <Money value={s.totals.expectedCash} className="text-[28px] leading-tight font-semibold text-ink" />
            <div className="text-[12px] text-muted">{t('finance.session.expectedHint')}</div>
          </div>
          <div className="px-1">
            <Metric label={t('finance.session.float')} value={<Money value={s.openingFloat} />} />
            <Metric label={t('finance.session.cashIn')} value={<Money value={s.totals.cashPayments} />} tone="ok" />
            <Metric label={t('finance.session.cashRefunds')} value={s.totals.cashRefunds ? <Money value={-s.totals.cashRefunds} /> : '—'} />
            <Metric label={t('finance.session.cashExpenses')} value={s.totals.cashExpenses ? <Money value={-s.totals.cashExpenses} /> : '—'} />
            <Metric label={t('finance.session.payments')} value={f.number(s.totals.paymentCount)} />
          </div>
          {s.totals.byMethod.some((m) => !m.isCash && m.net) ? (
            <div className="border-t border-line px-1 pt-2">
              <div className="mb-1 text-[12px] font-medium text-muted">{t('finance.session.otherMethods')}</div>
              {s.totals.byMethod
                .filter((m) => !m.isCash && m.net)
                .map((m) => (
                  <Metric key={m.methodId} label={bi(m, 'name')} value={<Money value={m.net} />} />
                ))}
            </div>
          ) : null}
          <Button variant="secondary" onClick={() => setClosing(s)}>
            <Lock />
            {t('finance.session.close')}
          </Button>
        </div>
      ) : null}
      <CloseSessionDialog session={closing} onClose={() => setClosing(null)} />
    </Card>
  );
}
