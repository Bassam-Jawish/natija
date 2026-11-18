import { useTranslation } from 'react-i18next';
import { ShieldCheck, Users } from 'lucide-react';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useRoles, useStaffUsers } from '../api';
import { useTabParam } from '../components/common';
import { RolesTab } from '../components/staff/RolesTab';
import { UsersTab } from '../components/staff/UsersTab';

const TABS = ['users', 'roles'] as const;

export default function StaffPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(TABS, 'users');
  const users = useStaffUsers();
  const roles = useRoles();
  return (
    <div>
      <PageHeader title={t('staff.title')} description={t('staff.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-1">
          <TabsTrigger value="users" count={users.data?.filter((u) => u.status === 'active').length}>
            <Users className="size-4" />
            {t('staff.tabs.users')}
          </TabsTrigger>
          <TabsTrigger value="roles" count={roles.data?.length}>
            <ShieldCheck className="size-4" />
            {t('staff.tabs.roles')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="roles">
          <RolesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
