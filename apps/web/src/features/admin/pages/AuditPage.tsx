import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AuditChainCheck, AuditLogFacets, AuditLogRow } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button, DataTable, Drawer, InfoList, PageHeader, SearchInput, Select, type ColumnDef } from '@/components/ui';
import { adminKeys } from '../api';
import { ChangeTable } from '../components/audit/ChangeTable';
import { Code, FilterBar, SectionTitle, useAdminError, useRangeParam } from '../components/common';

const LIMIT = 50;
const ALL = 'all';

export default function AuditPage() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const errorMessage = useAdminError();
  const [range, setRange] = useRangeParam(6);
  const [entityType, setEntityType] = useState(ALL);
  const [action, setAction] = useState(ALL);
  const [userId, setUserId] = useState(ALL);
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<AuditLogRow | null>(null);
  useEffect(() => setOffset(0), [range.from, range.to, entityType, action, userId, term]);
  const facets = useQuery({ queryKey: adminKeys.auditFacets, queryFn: () => api.get<AuditLogFacets & { count: number }>('/audit/facets'), staleTime: 60_000 });
  const filters = {
    ...range,
    entityType: entityType === ALL ? undefined : entityType,
    action: action === ALL ? undefined : action,
    userId: userId === ALL ? undefined : userId,
    q: term || undefined,
  };
  const query = useQuery({
    queryKey: adminKeys.audit({ ...filters, offset }),
    queryFn: () => api.get<{ items: AuditLogRow[]; total: number }>('/audit', { ...filters, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
  });
  const verify = useMutation({ mutationFn: () => api.get<AuditChainCheck>('/audit/verify'), onError: () => undefined });
  const entity = (type: string) => t(`audit.entities.${type}`, { defaultValue: type.replace(/_/g, ' ') });

  const columns: ColumnDef<AuditLogRow, unknown>[] = [
    { header: '#', id: 'seq', cell: ({ row }) => <span className="font-mono text-[11.5px] text-muted ltr-num">{row.original.seq}</span>, size: 56 },
    { header: t('audit.when'), id: 'at', cell: ({ row }) => <span className="tabular whitespace-nowrap">{f.dateTime(row.original.at)}</span> },
    { header: t('audit.who'), id: 'who', cell: ({ row }) => <span className="whitespace-nowrap">{row.original.actorName ?? t('common.system')}</span> },
    {
      header: t('audit.what'),
      id: 'what',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="text-ink">{entity(row.original.entityType)}</div>
          <Code className="text-[11.5px] text-muted">{row.original.action}</Code>
        </div>
      ),
    },
    { header: t('audit.summary'), id: 'summary', cell: ({ row }) => <span className="line-clamp-2 text-ink-2">{row.original.summary ?? ''}</span> },
  ];

  const result = verify.data;
  return (
    <div>
      <PageHeader
        title={t('audit.title')}
        description={t('audit.description')}
        meta={facets.data ? <span className="text-[12.5px] text-muted">{t('audit.entries', { n: f.number(facets.data.count) })}</span> : null}
        actions={
          <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
            <ShieldCheck />
            {t('audit.verify')}
          </Button>
        }
      />
      {verify.error ? <Banner tone="crit" title={t('audit.verifyFailed')} body={errorMessage(verify.error)} /> : null}
      {result ? (
        result.ok ? (
          <Banner tone="ok" title={t('audit.intact')} body={t('audit.intactBody', { n: f.number(result.checked), at: f.dateTime(result.verifiedAt) })} />
        ) : (
          <Banner
            tone="crit"
            title={t('audit.broken', { seq: result.broken!.seq })}
            body={
              <>
                {t(`audit.reason.${result.broken!.reason}`)}{' '}
                <span className="text-ink-2">
                  {t('audit.brokenAt', { action: result.broken!.action, at: f.dateTime(result.broken!.at), n: f.number(result.checked) })}
                </span>
                <span className="mt-1 block text-[12px]">{t('audit.brokenHint')}</span>
              </>
            }
          />
        )
      ) : null}
      <FilterBar range={range} onRange={setRange}>
        <Select
          size="sm"
          value={entityType}
          onValueChange={setEntityType}
          className="w-44"
          options={[{ value: ALL, label: t('audit.allEntities') }, ...(facets.data?.entityTypes ?? []).map((e) => ({ value: e, label: entity(e) }))]}
        />
        <Select
          size="sm"
          value={action}
          onValueChange={setAction}
          className="w-56"
          options={[{ value: ALL, label: t('audit.allActions') }, ...(facets.data?.actions ?? []).map((a) => ({ value: a, label: a }))]}
        />
        <Select
          size="sm"
          value={userId}
          onValueChange={setUserId}
          className="w-48"
          options={[{ value: ALL, label: t('audit.allUsers') }, ...(facets.data?.users ?? []).map((u) => ({ value: u.id, label: bi(u, 'fullName') }))]}
        />
        <SearchInput value={q} onChange={setQ} placeholder={t('audit.search')} className="h-8 w-56" />
      </FilterBar>
      <DataTable
        columns={columns}
        data={query.data?.items}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={setOpen}
        getRowId={(r) => r.id}
        dense
        empty={{ title: t('audit.none') }}
        pagination={query.data ? { total: query.data.total, limit: LIMIT, offset, onChange: setOffset } : undefined}
      />
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} width="lg" title={open ? `${entity(open.entityType)} · #${open.seq}` : ''} description={open?.summary ?? undefined}>
        {open ? (
          <div className="flex flex-col gap-5">
            <InfoList
              columns={2}
              items={[
                { label: t('audit.when'), value: <span className="tabular whitespace-nowrap">{f.dateTime(open.at)}</span> },
                { label: t('audit.who'), value: open.actorName ?? t('common.system') },
                { label: t('audit.action'), value: <Code>{open.action}</Code> },
                { label: t('audit.record'), value: open.entityId ? <Code className="text-[11.5px]">{open.entityId}</Code> : '—' },
                { label: t('audit.ip'), value: open.ip ? <Code>{open.ip}</Code> : '—' },
                { label: t('audit.device'), value: <span className="text-[12px] break-all text-muted">{open.userAgent ?? '—'}</span> },
              ]}
            />
            <section>
              <SectionTitle>{t('audit.changes')}</SectionTitle>
              <ChangeTable before={open.before} after={open.after} />
            </section>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function Banner({ tone, title, body }: { tone: 'ok' | 'crit'; title: string; body: ReactNode }) {
  const Icon = tone === 'ok' ? ShieldCheck : ShieldAlert;
  return (
    <div className={cn('mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3', tone === 'ok' ? 'border-ok/30 bg-ok-soft' : 'border-crit/30 bg-crit-soft')} role="status">
      <Icon className={cn('mt-0.5 size-5 shrink-0', tone === 'ok' ? 'text-ok' : 'text-crit')} />
      <div className="min-w-0 text-[13px]">
        <div className={cn('font-semibold', tone === 'ok' ? 'text-ok' : 'text-crit')}>{title}</div>
        <div className="text-ink-2">{body}</div>
      </div>
    </div>
  );
}
