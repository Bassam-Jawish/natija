import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { ErrorState, PageHeader, Skeleton, StatusChip, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { ins, keys } from '../api';
import { Code, ConfidenceChip, HonestyBanner, LevelChip } from '../components/common';
import { EventsPanel } from '../components/EventsPanel';
import { InstrumentOverview } from '../components/InstrumentOverview';
import { MaintenancePanel } from '../components/Maintenance';
import { MappingsPanel } from '../components/MappingsPanel';
import { MessageDrawer } from '../components/MessageDrawer';
import { MessagesPanel } from '../components/MessagesPanel';
import { SimulatorPanel } from '../components/SimulatorPanel';

const TABS = ['overview', 'simulator', 'messages', 'mappings', 'events', 'maintenance'] as const;
type Tab = (typeof TABS)[number];

export default function InstrumentPage() {
  const { t } = useTranslation('instruments');
  const { id = '' } = useParams();
  const { can } = useAuth();
  const f = useFormat();
  const [sp, setSp] = useSearchParams();
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const detail = useQuery({ queryKey: keys.detail(id), queryFn: () => ins.detail(id) });
  const mappings = useQuery({ queryKey: keys.mappings(id), queryFn: () => ins.mappings(id) });
  const tabs = TABS.filter((tab) => tab !== 'maintenance' || can('qc.read'));
  const tab: Tab = (tabs as readonly string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as Tab) : 'overview';
  const setTab = (next: string) => {
    const params = new URLSearchParams(sp);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSp(params, { replace: true });
  };

  if (detail.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-16 w-96" />
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const i = detail.data;

  return (
    <div>
      <PageHeader
        back="/instruments"
        title={i.name}
        description={i.profile ? `${i.profile.manufacturer} · ${i.profile.name}` : undefined}
        meta={
          <>
            <Code className="rounded bg-sunken px-1.5 py-0.5">{i.code}</Code>
            <StatusChip kind="instrument" status={i.status} />
            <LevelChip level={i.integrationLevel} />
            {i.profile ? <ConfidenceChip confidence={i.profile.confidence} /> : null}
            <span className="text-[12.5px] text-muted">{i.lastMessageAt ? t('board.lastMessage', { when: f.relative(i.lastMessageAt) }) : t('board.never')}</span>
          </>
        }
      />
      <HonestyBanner className="mb-4" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {tabs.map((tb) => (
            <TabsTrigger
              key={tb}
              value={tb}
              count={tb === 'mappings' ? mappings.data?.length : tb === 'messages' ? i.counts.messagesToday || undefined : undefined}
            >
              {t(`tabs.${tb}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <InstrumentOverview instrument={i} />
        </TabsContent>
        <TabsContent value="simulator">
          <SimulatorPanel instrument={i} mappings={mappings.data} onOpenMessage={setOpenMessage} />
        </TabsContent>
        <TabsContent value="messages">
          <MessagesPanel instrumentId={i.id} onOpen={setOpenMessage} />
        </TabsContent>
        <TabsContent value="mappings">
          <MappingsPanel instrumentId={i.id} query={mappings} />
        </TabsContent>
        <TabsContent value="events">
          <EventsPanel instrumentId={i.id} />
        </TabsContent>
        {can('qc.read') ? (
          <TabsContent value="maintenance">
            <MaintenancePanel instrumentId={i.id} />
          </TabsContent>
        ) : null}
      </Tabs>
      <MessageDrawer messageId={openMessage} onClose={() => setOpenMessage(null)} mappings={mappings.data} />
    </div>
  );
}
