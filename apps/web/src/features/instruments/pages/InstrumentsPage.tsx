import { useMemo } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, AlertCircle, Cpu, MessageSquare, Server } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { buttonVariants, EmptyState, ErrorState, PageHeader, Skeleton, StatTile } from '@/components/ui';
import { ins, keys, useProfiles } from '../api';
import { HonestyBanner } from '../components/common';
import { InstrumentCard } from '../components/InstrumentCard';

/** Status board: one card per analyzer, live. */
export default function InstrumentsPage() {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const list = useQuery({ queryKey: keys.list, queryFn: ins.list });
  const overview = useQuery({ queryKey: keys.overview, queryFn: ins.overview, enabled: can('integration.review', 'instruments.read') });
  const profiles = useProfiles();
  const byModel = useMemo(() => new Map((profiles.data ?? []).map((p) => [p.model as string, p])), [profiles.data]);
  const o = overview.data;

  return (
    <div>
      <PageHeader
        title={t('board.title')}
        description={t('board.description')}
        actions={
          <>
            {can('instruments.manage') ? (
              <Link to="/instruments/agents" className={buttonVariants({ variant: 'secondary' })}>
                <Server />
                {t('board.agents')}
              </Link>
            ) : null}
            {can('integration.review') ? (
              <Link to="/integration/review" className={buttonVariants({ variant: 'secondary' })}>
                <AlertCircle />
                {t('board.review')}
              </Link>
            ) : null}
            {can('qc.read') ? (
              <Link to="/qc" className={buttonVariants({ variant: 'secondary' })}>
                <Activity />
                {t('board.qc')}
              </Link>
            ) : null}
          </>
        }
      />
      <HonestyBanner className="mb-4" />
      {o ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile icon={Cpu} label={t('board.stats.online')} value={`${o.instruments.online}/${o.instruments.total}`} tone={o.instruments.online ? 'ok' : undefined} />
          <StatTile icon={MessageSquare} label={t('board.stats.messages')} value={o.messagesToday.total} hint={t('board.stats.simulated', { count: o.messagesToday.simulated })} />
          <StatTile
            icon={AlertCircle}
            label={t('board.stats.review')}
            value={o.review.open}
            tone={o.review.open ? 'warn' : undefined}
            to={can('integration.review') ? '/integration/review' : undefined}
          />
          <StatTile
            icon={Server}
            label={t('board.stats.agents')}
            value={`${o.agents.online}/${o.agents.total}`}
            hint={o.agents.pending ? t('board.stats.pending', { count: o.agents.pending }) : undefined}
            to={can('instruments.manage') ? '/instruments/agents' : undefined}
          />
        </div>
      ) : null}
      {list.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data?.length ? (
        <EmptyState icon={Cpu} title={t('board.empty')} description={t('board.emptyHint')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((i) => (
            <InstrumentCard key={i.id} instrument={i} profile={byModel.get(i.model)} />
          ))}
        </div>
      )}
    </div>
  );
}
