import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { DoctorsTab, InstrumentsTab, RevenueTab } from '../components/analytics/BusinessTabs';
import { ProductivityTab, RejectionsTab, TatTab, VolumeTab } from '../components/analytics/OperationsTabs';
import { ExportButton, FilterBar, useRangeParam, useTabParam } from '../components/common';

const TABS = ['tat', 'volume', 'revenue', 'productivity', 'rejections', 'instruments', 'doctors'] as const;
type Tab = (typeof TABS)[number];

export default function AnalyticsPage() {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const money = can('finance.read');
  const tabs = TABS.filter((x) => x !== 'revenue' || money);
  const [tab, setTab] = useTabParam<Tab>(tabs, 'tat');
  const [range, setRange] = useRangeParam(29);

  return (
    <div>
      <PageHeader title={t('analytics.title')} description={t('analytics.description')} />
      <FilterBar range={range} onRange={setRange} end={<ExportButton path={`/analytics/export/${tab}`} query={range} />} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {tabs.map((x) => (
            <TabsTrigger key={x} value={x}>
              {t(`analytics.tabs.${x}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="tat">{tab === 'tat' ? <TatTab range={range} /> : null}</TabsContent>
        <TabsContent value="volume">{tab === 'volume' ? <VolumeTab range={range} /> : null}</TabsContent>
        {money ? <TabsContent value="revenue">{tab === 'revenue' ? <RevenueTab range={range} /> : null}</TabsContent> : null}
        <TabsContent value="productivity">{tab === 'productivity' ? <ProductivityTab range={range} /> : null}</TabsContent>
        <TabsContent value="rejections">{tab === 'rejections' ? <RejectionsTab range={range} /> : null}</TabsContent>
        <TabsContent value="instruments">{tab === 'instruments' ? <InstrumentsTab range={range} /> : null}</TabsContent>
        <TabsContent value="doctors">{tab === 'doctors' ? <DoctorsTab range={range} /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
