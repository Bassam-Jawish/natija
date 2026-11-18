import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import type { FinanceApproval } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { Badge, Button, DataTable, Dialog, Field, InfoList, Money, PageHeader, Segmented, StatusChip, Textarea, toast, Tooltip, type ColumnDef } from '@/components/ui';
import { financeKeys } from '../api';
import { Code, Metric, usePairName, useAdminError } from '../components/common';
import { InvoiceDrawer } from '../components/finance/InvoiceDrawer';

type Status = 'pending' | 'approved' | 'rejected' | 'all';
const LIMIT = 50;

export default function ApprovalsPage() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const { me, can } = useAuth();
  const [status, setStatus] = useState<Status>('pending');
  const [offset, setOffset] = useState(0);
  const [deciding, setDeciding] = useState<{ approval: FinanceApproval; approve: boolean } | null>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  useEffect(() => setOffset(0), [status]);
  const query = useQuery({
    queryKey: financeKeys.approvals({ status, offset }),
    queryFn: () => api.get<{ items: FinanceApproval[]; total: number; pending: number }>('/finance/approvals', { status: status === 'all' ? undefined : status, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
  });
  const segregation = me?.lab.settings?.segregationOfDuties !== false;
  const canDecide = can('finance.approve');

  const columns: ColumnDef<FinanceApproval, unknown>[] = [
    {
      header: t('approvals.requested'),
      id: 'requested',
      cell: ({ row }) => (
        <div>
          <div className="tabular whitespace-nowrap">{f.dateTime(row.original.requestedAt)}</div>
          <div className="text-[11.5px] text-muted">{name(row.original.requestedByNameAr, row.original.requestedByNameEn)}</div>
        </div>
      ),
    },
    { header: t('approvals.kind'), id: 'kind', cell: ({ row }) => <Badge tone={row.original.kind === 'free' ? 'violet' : 'neutral'}>{t(`approvals.kinds.${row.original.kind}`)}</Badge> },
    {
      header: t('approvals.patient'),
      id: 'patient',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate">{name(row.original.patientNameAr, row.original.patientNameEn) || '—'}</div>
          {row.original.orderId ? (
            <Link to={`/orders/${row.original.orderId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[11.5px] text-accent ltr-num hover:underline">
              {row.original.accession}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      header: t('approvals.request'),
      id: 'amount',
      meta: { align: 'end' },
      cell: ({ row }) => {
        const a = row.original;
        return (
          <div>
            {a.effectiveAmount !== null ? <Money value={a.effectiveAmount} className="font-semibold" /> : '—'}
            <div className="text-[11.5px] text-muted">
              {a.percent !== null ? <span className="ltr-num">{f.percent(a.percent, 1)}</span> : null}
              {a.invoiceNet !== null ? (
                <span>
                  {a.percent !== null ? ' · ' : ''}
                  {t('approvals.ofNet')} <Money value={a.invoiceNet} />
                </span>
              ) : null}
            </div>
          </div>
        );
      },
    },
    { header: t('approvals.reason'), id: 'reason', cell: ({ row }) => <span className="line-clamp-2 max-w-[280px] text-ink-2">{row.original.reason}</span> },
    {
      header: t('common.status'),
      id: 'status',
      cell: ({ row }) => (
        <div>
          <StatusChip kind="approval" status={row.original.status} />
          {row.original.decidedAt ? (
            <div className="mt-0.5 text-[11.5px] text-muted">
              {name(row.original.decidedByNameAr, row.original.decidedByNameEn)} · {f.date(row.original.decidedAt)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      meta: { align: 'end' },
      cell: ({ row }) => {
        const a = row.original;
        if (a.status !== 'pending' || !canDecide) return null;
        const own = segregation && a.requestedBy === me?.user.id;
        const buttons = (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="success" disabled={own} onClick={(e) => (e.stopPropagation(), setDeciding({ approval: a, approve: true }))}>
              <Check />
              {t('approvals.approve')}
            </Button>
            <Button size="sm" variant="secondary" disabled={own} onClick={(e) => (e.stopPropagation(), setDeciding({ approval: a, approve: false }))}>
              <X />
              {t('approvals.reject')}
            </Button>
          </div>
        );
        return own ? (
          <Tooltip content={t('approvals.ownRequest')}>
            <span>{buttons}</span>
          </Tooltip>
        ) : (
          buttons
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader title={t('approvals.title')} description={t('approvals.description')} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: t('approvals.pending'), count: query.data?.pending },
            { value: 'approved', label: t('approvals.approved') },
            { value: 'rejected', label: t('approvals.rejected') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        {segregation ? <span className="text-[12.5px] text-muted">{t('approvals.segregationOn')}</span> : null}
      </div>
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={(a) => a.invoiceId && setInvoice(a.invoiceId)}
        getRowId={(a) => a.id}
        empty={{ title: status === 'pending' ? t('approvals.nonePending') : t('approvals.none'), description: status === 'pending' ? t('approvals.nonePendingHint') : undefined }}
        pagination={query.data ? { total: query.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
      <DecideDialog target={deciding} onClose={() => setDeciding(null)} />
      <InvoiceDrawer invoiceId={invoice} onClose={() => setInvoice(null)} />
    </div>
  );
}

function DecideDialog({ target, onClose }: { target: { approval: FinanceApproval; approve: boolean } | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const name = usePairName();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [target]);
  const decide = useMutation({
    mutationFn: () => api.post<{ status: string; applied: number | null }>(`/finance/approvals/${target!.approval.id}/decide`, { approve: target!.approve, note: note.trim() || null }),
    onSuccess: (res) => {
      toast.success(res.status === 'approved' ? (res.applied ? t('approvals.appliedToast', { amount: f.money(res.applied) }) : t('approvals.approvedToast')) : t('approvals.rejectedToast'));
      void qc.invalidateQueries({ queryKey: financeKeys.all });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const a = target?.approval;
  const approve = target?.approve ?? true;
  const applies = a && (a.kind === 'discount' || a.kind === 'free');
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={approve ? t('approvals.approveTitle') : t('approvals.rejectTitle')}
      description={a ? t(`approvals.kinds.${a.kind}`) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant={approve ? 'success' : 'danger'} loading={decide.isPending} disabled={!approve && note.trim().length < 3} onClick={() => decide.mutate()}>
            {approve ? t('approvals.approve') : t('approvals.reject')}
          </Button>
        </>
      }
    >
      {a ? (
        <div className="flex flex-col gap-4">
          <InfoList
            columns={2}
            items={[
              { label: t('approvals.patient'), value: name(a.patientNameAr, a.patientNameEn) || '—' },
              { label: t('approvals.invoice'), value: a.invoiceNumber ? <Code>{a.invoiceNumber}</Code> : '—' },
              { label: t('approvals.requestedBy'), value: name(a.requestedByNameAr, a.requestedByNameEn) },
              { label: t('approvals.reason'), value: a.reason, wide: true },
            ]}
          />
          {applies ? (
            <div className="rounded-lg bg-sunken px-3 py-1">
              {a.invoiceNet !== null ? <Metric label={t('approvals.net')} value={<Money value={a.invoiceNet} />} /> : null}
              <Metric label={t('approvals.discount')} value={a.effectiveAmount !== null ? <Money value={-a.effectiveAmount} /> : '—'} strong />
              {a.invoiceNet !== null && a.effectiveAmount !== null ? <Metric label={t('approvals.after')} value={<Money value={Math.max(0, a.invoiceNet - a.effectiveAmount)} />} /> : null}
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">{t('approvals.recordOnly')}</p>
          )}
          {approve && applies ? <p className="text-[12.5px] text-muted">{t('approvals.applyHint')}</p> : null}
          <Field label={t('approvals.note')} required={!approve}>
            {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}
          </Field>
        </div>
      ) : null}
    </Dialog>
  );
}
