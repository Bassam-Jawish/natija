import { useTranslation } from 'react-i18next';
import { BadgePercent, ListOrdered, Tags } from 'lucide-react';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { usePayerGroups } from '../api';
import { OverridesTab } from '../components/pricing/OverridesTab';
import { PayersTab } from '../components/pricing/PayersTab';
import { PriceListTab } from '../components/pricing/PriceListTab';
import { useTabParam } from '../components/common';

const TABS = ['payers', 'list', 'overrides'] as const;

export default function PricingPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(TABS, 'payers');
  const payers = usePayerGroups();
  return (
    <div>
      <PageHeader title={t('pricing.title')} description={t('pricing.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-1">
          <TabsTrigger value="payers" count={payers.data?.filter((p) => p.isActive).length}>
            <Tags className="size-4" />
            {t('pricing.tabs.payers')}
          </TabsTrigger>
          <TabsTrigger value="list">
            <ListOrdered className="size-4" />
            {t('pricing.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="overrides">
            <BadgePercent className="size-4" />
            {t('pricing.tabs.overrides')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="payers">
          <PayersTab />
        </TabsContent>
        <TabsContent value="list">
          <PriceListTab />
        </TabsContent>
        <TabsContent value="overrides" className="max-w-5xl">
          <OverridesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
