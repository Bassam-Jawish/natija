import { Suspense, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Dialog as RDialog } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';
import { safeStorage } from '@/lib/utils';
import { EmptyState, Spinner } from '@/components/ui';
import { CommandPalette } from './CommandPalette';
import { ScanListener } from './ScanListener';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function PageSpinner() {
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <Spinner className="size-6" />
    </div>
  );
}

/** Signed-in area: sidebar, top bar, live updates, command palette and barcode scanning. */
export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => safeStorage().get('natija.sidebar') === 'collapsed');
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const toggle = () => {
    setCollapsed((c) => {
      safeStorage().set('natija.sidebar', c ? 'open' : 'collapsed');
      return !c;
    });
  };
  return (
    <LiveProvider>
      <div className="flex h-dvh overflow-hidden bg-paper">
        <div className="no-print hidden lg:block">
          <Sidebar collapsed={collapsed} onToggle={toggle} />
        </div>
        <RDialog.Root open={mobileNav} onOpenChange={setMobileNav}>
          <RDialog.Portal>
            <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40 lg:hidden" />
            <RDialog.Content className="fixed inset-y-0 start-0 z-50 lg:hidden">
              <RDialog.Title className="sr-only">Navigation</RDialog.Title>
              <RDialog.Description className="sr-only">Navigation</RDialog.Description>
              <Sidebar collapsed={false} onNavigate={() => setMobileNav(false)} />
            </RDialog.Content>
          </RDialog.Portal>
        </RDialog.Root>
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenNav={() => setMobileNav(true)} onOpenPalette={() => setPalette(true)} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1680px] px-4 py-5 lg:px-6">
              <Suspense fallback={<PageSpinner />}>
                <Outlet />
              </Suspense>
            </div>
          </main>
        </div>
        <CommandPalette open={palette} onOpenChange={setPalette} />
        <ScanListener />
      </div>
    </LiveProvider>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageSpinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

/** Shows a "no access" state when the user lacks every listed permission. */
export function RequirePerm({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { can } = useAuth();
  const { t } = useTranslation();
  if (!can(...perms)) return <EmptyState icon={Lock} title={t('noAccess.title')} description={t('noAccess.description')} />;
  return <>{children}</>;
}
