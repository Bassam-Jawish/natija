import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList, ClipboardPlus, FileWarning, GitMerge, Pencil } from 'lucide-react';
import type { OrderListItem } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  PageHeader,
  Skeleton,
  StatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ColumnDef,
} from '@/components/ui';
import { fd, keys, usePatient, useRefresh } from '../api';
import { PatientAttachments } from '../components/PatientAttachments';
import { PatientForm } from '../components/PatientForm';
import { PatientMerge } from '../components/PatientMerge';
import { PatientTrends } from '../components/PatientTrends';
import { Accession, AgeText, CriticalBadge, DailyNo, FdErrorState, LinkButton, Notice, SexText, usePatientName } from '../components/shared';

const TABS = ['orders', 'results', 'attachments', 'details', 'merge'] as const;
type Tab = (typeof TABS)[number];

/** A patient's file: identity, orders, cumulative results, attachments, details and merging. */
export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const name = usePatientName();
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [sp, setSp] = useSearchParams();
  const patient = usePatient(id);
  const history = useQuery({ queryKey: keys.history(id ?? ''), queryFn: () => fd.history(id!), enabled: !!id });
  const fromUrl = sp.get('tab') as Tab | null;
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : 'orders';
  const setTab = (next: string) => setSp(next === 'orders' ? {} : { tab: next }, { replace: true });

  const columns = useMemo<ColumnDef<OrderListItem>[]>(
    () => [
      {
        id: 'order',
        header: t('orders.col.accession'),
        accessorKey: 'createdAt',
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <DailyNo value={row.original.dailyNo} size="sm" className="w-10" />
            <div className="flex flex-col">
              <Accession value={row.original.accession} />
              <span className="text-[12px] text-muted tabular">{f.dateTime(row.original.createdAt)}</span>
            </div>
          </div>
        ),
      },
      {
        id: 'tests',
        header: t('orders.col.tests'),
        cell: ({ row }) => (
          <span className="block max-w-[320px] truncate font-mono text-[12px] text-ink-2 ltr-num" title={row.original.testCodes.join(' · ')}>
            {row.original.testCodes.join(' · ')}
          </span>
        ),
      },
      { id: 'doctor', header: t('order.doctor'), cell: ({ row }) => <span className="text-[12.5px] text-ink-2">{row.original.doctor ? bi(row.original.doctor) : '—'}</span> },
      {
        id: 'status',
        header: t('orders.col.status'),
        accessorKey: 'status',
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <StatusChip kind="order" status={row.original.status} />
            {row.original.hasCritical ? <CriticalBadge /> : null}
          </span>
        ),
      },
      {
        id: 'balance',
        header: t('orders.col.balance'),
        accessorKey: 'balance',
        meta: { align: 'end' },
        cell: ({ row }) =>
          row.original.invoiceStatus === 'void' ? (
            <span className="text-muted">—</span>
          ) : row.original.balance > 0 ? (
            <span className="font-medium text-warn tabular ltr-num">{f.money(row.original.balance)}</span>
          ) : (
            <Badge tone="ok">{t('billing.settled')}</Badge>
          ),
      },
    ],
    [t, f, bi],
  );

  if (patient.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-[360px]" />
      </div>
    );
  }
  if (patient.error || !patient.data) {
    return (
      <>
        <PageHeader title={t('patients.title')} back="/patients" />
        <div className="rounded-[var(--radius-card)] border border-line bg-surface">
          <FdErrorState error={patient.error} onRetry={() => patient.refetch()} />
        </div>
      </>
    );
  }

  const p = patient.data;
  const merged = !!p.mergedInto;
  return (
    <>
      <PageHeader
        back="/patients"
        title={
          <span className="flex items-center gap-3">
            <Avatar name={name(p)} className="size-11 text-[14px]" />
            <span className="min-w-0">
              <span className="block">{p.fullNameAr}</span>
              {p.fullNameEn ? <span className="block text-[14px] font-normal text-muted">{p.fullNameEn}</span> : null}
            </span>
          </span>
        }
        meta={
          <>
            <Badge tone="neutral" className="font-mono ltr-num">
              {p.mrn}
            </Badge>
            <Badge tone="neutral">
              <SexText sex={p.sex} />
            </Badge>
            <Badge tone={p.birthDateEstimated ? 'warn' : 'neutral'}>
              <AgeText birthDate={p.birthDate} estimated={p.birthDateEstimated} />
              {!p.birthDateEstimated ? <span className="text-muted">· {f.date(p.birthDate)}</span> : null}
            </Badge>
            {p.phone ? (
              <Badge tone="neutral">
                <span className="ltr-num">{p.phone}</span>
                <span className="text-muted">· {t(`patient.contact.${p.contactPref}`)}</span>
              </Badge>
            ) : null}
            {p.nationalId ? (
              <Badge tone="neutral">
                {t('patient.nationalId')} <span className="ltr-num">{p.nationalId}</span>
              </Badge>
            ) : null}
            {p.motherNameAr ? <Badge tone="neutral">{t('patient.motherShort', { name: p.motherNameAr })}</Badge> : null}
          </>
        }
        actions={
          !merged ? (
            <>
              {can('patients.write') ? (
                <Button onClick={() => setTab('details')}>
                  <Pencil />
                  {t('common:actions.edit')}
                </Button>
              ) : null}
              {can('orders.create') ? (
                <LinkButton to={`/reception?patient=${p.id}`} variant="primary">
                  <ClipboardPlus />
                  {t('patients.newOrder')}
                </LinkButton>
              ) : null}
            </>
          ) : null
        }
      />
      {merged ? (
        <Notice
          tone="crit"
          icon={<GitMerge />}
          title={t('patient.mergedNotice')}
          className="mb-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => navigate(`/patients/${p.mergedInto!.id}`)}>
              {t('patient.openMerged', { mrn: p.mergedInto!.mrn })}
            </Button>
          }
        />
      ) : null}
      {p.notes ? (
        <Notice tone="info" icon={<FileWarning />} title={t('patient.notes')} className="mb-4">
          <span className="whitespace-pre-line">{p.notes}</span>
        </Notice>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="overflow-y-hidden">
          <TabsTrigger value="orders" count={p.orderCount}>
            {t('patient.tabs.orders')}
          </TabsTrigger>
          <TabsTrigger value="results" count={history.data?.analytes.length}>
            {t('patient.tabs.results')}
          </TabsTrigger>
          <TabsTrigger value="attachments" count={p.attachmentCount}>
            {t('patient.tabs.attachments')}
          </TabsTrigger>
          {!merged && can('patients.write') ? <TabsTrigger value="details">{t('patient.tabs.details')}</TabsTrigger> : null}
          {!merged && can('patients.merge') ? <TabsTrigger value="merge">{t('patient.tabs.merge')}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="orders">
          <DataTable
            columns={columns}
            data={history.data?.orders}
            loading={history.isLoading}
            error={history.error}
            onRetry={() => history.refetch()}
            getRowId={(o) => o.id}
            onRowClick={(o) => navigate(`/orders/${o.id}`)}
            rowClassName={(o) => (o.status === 'cancelled' ? 'opacity-60' : undefined)}
            empty={{ icon: ClipboardList, title: t('patient.noOrders') }}
          />
        </TabsContent>
        <TabsContent value="results">
          {history.isLoading ? <Skeleton className="h-40" /> : history.error ? <FdErrorState error={history.error} onRetry={() => history.refetch()} /> : <PatientTrends analytes={history.data?.analytes ?? []} />}
        </TabsContent>
        <TabsContent value="attachments">
          <PatientAttachments patientId={p.id} />
        </TabsContent>
        {!merged && can('patients.write') ? (
          <TabsContent value="details">
            <div className="max-w-4xl rounded-[var(--radius-card)] border border-line bg-surface p-4">
              <PatientForm
                key={p.updatedAt}
                patient={p}
                onSaved={() => {
                  void refresh.patients();
                  void refresh.orders();
                  setTab('orders');
                }}
                onCancel={() => setTab('orders')}
              />
              <p className="mt-3 text-[12px] text-muted">
                {t('patient.createdBy', {
                  at: f.dateTime(p.createdAt),
                  by: p.createdBy ? bi({ nameAr: p.createdBy.fullNameAr, nameEn: p.createdBy.fullNameEn }) : '—',
                })}
              </p>
            </div>
          </TabsContent>
        ) : null}
        {!merged && can('patients.merge') ? (
          <TabsContent value="merge">
            <PatientMerge patient={p} />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
