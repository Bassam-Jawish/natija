import { Link, Navigate, useRouteError } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Compass, Hammer } from 'lucide-react';
import { HOME_ORDER } from '@/app/nav';
import { useAuth } from '@/lib/auth';
import { Button, EmptyState, ErrorState } from '@/components/ui';

/** Send each role to the first page it can use (dashboard, reception, worklists…). */
export function HomeRedirect() {
  const { can } = useAuth();
  const target = HOME_ORDER.find((h) => can(...h.perms))?.to ?? '/account';
  return <Navigate to={target} replace />;
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={Compass}
      title={t('notFound.title')}
      description={t('notFound.description')}
      action={
        <Button asChild variant="secondary">
          <Link to="/">{t('notFound.home')}</Link>
        </Button>
      }
    />
  );
}

export function RouteError() {
  const error = useRouteError();
  return (
    <div className="grid min-h-dvh place-items-center bg-paper p-6">
      <ErrorState error={error} onRetry={() => window.location.reload()} />
    </div>
  );
}

/** Temporary page while a module is being built. */
export function ComingSoon({ title }: { title: string }) {
  const { t } = useTranslation();
  return <EmptyState icon={Hammer} title={title} description={t('comingSoon.description')} />;
}
