import { useTranslation } from 'react-i18next';
import { BarChart3, Stethoscope } from 'lucide-react';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { DirectoryTab } from '../components/doctors/DirectoryTab';
import { ReferralsTab } from '../components/doctors/ReferralsTab';
import { useTabParam } from '../components/common';

const TABS = ['directory', 'referrals'] as const;

export default function DoctorsPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(TABS, 'directory');
  return (
    <div>
      <PageHeader title={t('doctors.title')} description={t('doctors.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-1">
          <TabsTrigger value="directory">
            <Stethoscope className="size-4" />
            {t('doctors.tabs.directory')}
          </TabsTrigger>
          <TabsTrigger value="referrals">
            <BarChart3 className="size-4" />
            {t('doctors.tabs.referrals')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="directory">
          <DirectoryTab />
        </TabsContent>
        <TabsContent value="referrals">
          <ReferralsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
