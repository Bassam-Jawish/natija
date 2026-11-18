import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useCatalogTests, useLookups, usePackages } from '../api';
import { AnalytesTab } from '../components/catalog/AnalytesTab';
import { PackagesTab } from '../components/catalog/PackagesTab';
import { useAnalytes } from '../components/catalog/shared';
import { SimpleListCard } from '../components/catalog/SimpleListCard';
import { TestsTab } from '../components/catalog/TestsTab';

const TABS = ['tests', 'analytes', 'packages', 'departments', 'specimens', 'reasons'] as const;
type Tab = (typeof TABS)[number];

/** Test catalogue: tests, analytes and reference ranges, packages, and the small reference lists. */
export default function CatalogPage() {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'tests';
  const lookups = useLookups();
  const tests = useCatalogTests({ active: 'all' });
  const analytes = useAnalytes();
  const packages = usePackages();
  const setTab = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', v);
        return next;
      },
      { replace: true },
    );
  const simple = { loading: lookups.isLoading, error: lookups.error, onRetry: () => void lookups.refetch() };

  return (
    <div>
      <PageHeader title={t('catalog.title')} description={t('catalog.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-1">
          <TabsTrigger value="tests" count={tests.data?.filter((x) => x.isActive).length}>
            {t('catalog.tabs.tests')}
          </TabsTrigger>
          <TabsTrigger value="analytes" count={analytes.data?.filter((x) => x.isActive).length}>
            {t('catalog.tabs.analytes')}
          </TabsTrigger>
          <TabsTrigger value="packages" count={packages.data?.length}>
            {t('catalog.tabs.packages')}
          </TabsTrigger>
          <TabsTrigger value="departments" count={lookups.data?.departments.length}>
            {t('catalog.tabs.departments')}
          </TabsTrigger>
          <TabsTrigger value="specimens">{t('catalog.tabs.specimens')}</TabsTrigger>
          <TabsTrigger value="reasons" count={lookups.data?.rejectionReasons.length}>
            {t('catalog.tabs.reasons')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tests">
          <TestsTab />
        </TabsContent>
        <TabsContent value="analytes">
          <AnalytesTab />
        </TabsContent>
        <TabsContent value="packages">
          <PackagesTab />
        </TabsContent>
        <TabsContent value="departments">
          <div className="max-w-4xl">
            <SimpleListCard kind="department" rows={lookups.data?.departments} {...simple} />
          </div>
        </TabsContent>
        <TabsContent value="specimens">
          <div className="grid gap-4 xl:grid-cols-2">
            <SimpleListCard kind="sample_type" rows={lookups.data?.sampleTypes} {...simple} />
            <SimpleListCard kind="container" rows={lookups.data?.containers} {...simple} />
          </div>
        </TabsContent>
        <TabsContent value="reasons">
          <div className="max-w-4xl">
            <SimpleListCard kind="rejection_reason" rows={lookups.data?.rejectionReasons} {...simple} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
