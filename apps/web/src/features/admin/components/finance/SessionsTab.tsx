import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import type { FinanceCashSession } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Button, DataTable, Drawer, Money, Segmented, StatusChip, type ColumnDef, type DateRange } from '@/components/ui';
import { financeKeys } from '../../api';
import { Metric, usePairName } from '../common';
import { CloseSessionDialog } from './dialogs';

const end = { align: 'end' as const };
const LIMIT = 50;

/** Cash sessions of every cashier: what was expected, what was counted, and the difference. */
export function SessionsTab({ range }: { range: DateRange }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const name = usePairName();
  const { can, me } = useAuth();
  const [status, setStatus] = useState<'all' | 'open' | 'closed'>('all');
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<FinanceCashSession | null>(null);
  const [closing, setClosing] = useState<FinanceCashSession | null>(null);
  useEffect(() => setOffset(0), [range.from, range.to, status]);
  const query = useQuery({
    queryKey: financeKeys.sessions({ ...range, status, offset }),
    queryFn: () => api.get<{ items: FinanceCashSession[]; total: number }>('/finance/cash-sessions', { ...range, status: status === 'all' ? undefined : status, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: ColumnDef<FinanceCashSession, unknown>[] = [
    { header: t('finance.sessions.cashier'), id: 'who', cell: ({ row }) => <span className="font-medium">{name(row.original.openedByNameAr, row.original.openedByNameEn)}</span> },
    { header: t('finance.sessions.opened'), id: 'opened', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.dateTime(row.original.openedAt)}</span> },
    { header: t('finance.sessions.closedAt'), id: 'closed', cell: ({ row }) => <span className="tabular ltr-num text-muted">{row.original.closedAt ? f.dateTime(row.original.closedAt) : '—'}</span> },
    { header: t('finance.session.float'), id: 'float', meta: end, cell: ({ row }) => <Money value={row.original.openingFloat} className="text-muted" /> },
    { header: t('finance.session.expected'), id: 'expected', meta: end, cell: ({ row }) => <Money value={row.original.expectedCash ?? row.original.totals.expectedCash} /> },
    { header: t('fields.countedCash'), id: 'counted', meta: end, cell: ({ row }) => (row.original.countedCash === null ? <span className="text-faint">—</span> : <Money value={row.original.countedCash} />) },
    {
      header: t('finance.sessions.difference'),
      id: 'diff',
      meta: end,
      cell: ({ row }) => {
        const d = row.original.difference;
        if (d === null) return <span className="text-faint">—</span>;
        if (d === 0) return <span className="text-ok">{t('finance.session.balanced')}</span>;
        return <Money value={d} className={d < 0 ? 'font-semibold text-crit' : 'font-semibold text-warn'} />;
      },
    },
    { header: t('common.status'), id: 'status', cell: ({ row }) => <StatusChip kind="session" status={row.original.status} /> },
  ];
  const s = detail;
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        size="sm"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'all', label: t('common.all') },
          { value: 'open', label: t('finance.session.isOpen') },
          { value: 'closed', label: t('finance.session.isClosed') },
        ]}
      />
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={setDetail}
        getRowId={(r) => r.id}
        dense
        empty={{ title: t('finance.sessions.none') }}
        pagination={query.data ? { total: query.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
      <Drawer
        open={!!s}
        onOpenChange={(o) => !o && setDetail(null)}
        width="sm"
        title={s ? name(s.openedByNameAr, s.openedByNameEn) : ''}
        description={s ? `${f.dateTime(s.openedAt)}${s.closedAt ? ` → ${f.dateTime(s.closedAt)}` : ''}` : undefined}
        footer={
          s && s.status === 'open' && (s.openedBy === me?.user.id || can('finance.approve')) ? (
            <Button
              variant="primary"
              onClick={() => {
                setClosing(s);
                setDetail(null);
              }}
            >
              <Lock />
              {s.openedBy === me?.user.id ? t('finance.session.close') : t('finance.sessions.closeFor')}
            </Button>
          ) : null
        }
      >
        {s ? (
          <div className="flex flex-col gap-4">
            <div>
              <Metric label={t('finance.session.float')} value={<Money value={s.openingFloat} />} />
              <Metric label={t('finance.session.cashIn')} value={<Money value={s.totals.cashPayments} />} />
              <Metric label={t('finance.session.cashRefunds')} value={<Money value={-s.totals.cashRefunds} />} />
              <Metric label={t('finance.session.cashExpenses')} value={<Money value={-s.totals.cashExpenses} />} />
              <div className="border-t border-line">
                <Metric label={t('finance.session.expected')} value={<Money value={s.expectedCash ?? s.totals.expectedCash} />} strong />
              </div>
              {s.countedCash !== null ? (
                <>
                  <Metric label={t('fields.countedCash')} value={<Money value={s.countedCash} />} strong />
                  <Metric
                    label={t('finance.sessions.difference')}
                    value={s.difference ? <Money value={s.difference} /> : t('finance.session.balanced')}
                    tone={s.difference ? (s.difference < 0 ? 'crit' : 'warn') : 'ok'}
                    strong
                  />
                </>
              ) : null}
            </div>
            {s.totals.byMethod.length ? (
              <div>
                <div className="mb-1 text-[12px] font-medium text-muted">{t('finance.sessions.byMethod')}</div>
                {s.totals.byMethod.map((m) => (
                  <Metric key={m.methodId} label={bi(m, 'name')} value={<Money value={m.net} />} />
                ))}
              </div>
            ) : null}
            {s.note ? (
              <div>
                <div className="mb-1 text-[12px] font-medium text-muted">{t('common.notes')}</div>
                <p className="text-[13px] whitespace-pre-wrap text-ink-2">{s.note}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
      <CloseSessionDialog session={closing} onClose={() => setClosing(null)} />
    </div>
  );
}
