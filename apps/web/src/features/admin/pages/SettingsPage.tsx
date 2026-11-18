import { useTranslation } from 'react-i18next';
import { Building2, FileText, Palette, Wallet, Workflow } from 'lucide-react';
import { Badge, ErrorState, PageHeader, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { BranchesTab } from '../components/settings/BranchesTab';
import { PaymentMethodsTab } from '../components/settings/PaymentMethodsTab';
import { ProfileTab } from '../components/settings/ProfileTab';
import { ReportSettingsForm, WorkflowSettingsForm } from '../components/settings/SettingsForms';
import { useTabParam } from '../components/common';
import { useLabProfile } from '../components/settings/use-lab';

const TABS = ['profile', 'reports', 'workflow', 'methods', 'branches'] as const;

function Loading() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Skeleton className="h-[420px]" />
      <Skeleton className="h-[320px]" />
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(TABS, 'profile');
  const lab = useLabProfile();
  const profile = lab.data;
  const needsProfile = tab === 'profile' || tab === 'reports' || tab === 'workflow';
  // Forms reset when the saved values change (not when only the logo changes).
  const { logoSvg: _logo, settings, updatedAt: _at, ...fields } = profile ?? ({} as NonNullable<typeof profile>);
  void _logo;
  void _at;
  const profileKey = JSON.stringify(fields);
  const settingsKey = JSON.stringify(settings ?? {});

  return (
    <div>
      <PageHeader
        title={t('settings.title')}
        description={t('settings.description')}
        meta={
          profile ? (
            <>
              <Badge tone="neutral" className="font-mono ltr-num">
                {profile.code}
              </Badge>
              {profile.settings.demo ? <Badge tone="warn">{t('settings.demoLab')}</Badge> : null}
            </>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-1">
          <TabsTrigger value="profile">
            <Palette className="size-4" />
            {t('settings.tabs.profile')}
          </TabsTrigger>
          <TabsTrigger value="reports">
            <FileText className="size-4" />
            {t('settings.tabs.reports')}
          </TabsTrigger>
          <TabsTrigger value="workflow">
            <Workflow className="size-4" />
            {t('settings.tabs.workflow')}
          </TabsTrigger>
          <TabsTrigger value="methods">
            <Wallet className="size-4" />
            {t('settings.tabs.methods')}
          </TabsTrigger>
          <TabsTrigger value="branches">
            <Building2 className="size-4" />
            {t('settings.tabs.branches')}
          </TabsTrigger>
        </TabsList>
        {needsProfile && lab.isLoading ? <div className="pt-4"><Loading /></div> : null}
        {needsProfile && lab.error ? <ErrorState error={lab.error} onRetry={() => void lab.refetch()} /> : null}
        {profile ? (
          <>
            <TabsContent value="profile">
              <ProfileTab key={profileKey} profile={profile} />
            </TabsContent>
            <TabsContent value="reports" className="max-w-4xl">
              <ReportSettingsForm key={settingsKey} profile={profile} />
            </TabsContent>
            <TabsContent value="workflow" className="max-w-4xl">
              <WorkflowSettingsForm key={settingsKey} profile={profile} />
            </TabsContent>
          </>
        ) : null}
        <TabsContent value="methods" className="max-w-5xl">
          <PaymentMethodsTab />
        </TabsContent>
        <TabsContent value="branches" className="max-w-5xl">
          <BranchesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
