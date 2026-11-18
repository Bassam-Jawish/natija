import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bell, AlertOctagon, Info, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { useLiveEvent } from '@/lib/live';
import { cn } from '@/lib/utils';
import { Button, EmptyState, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';

type Notification = {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export function NotificationsBell() {
  const { t } = useTranslation();
  const bi = useBi();
  const f = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications', { limit: 25 }),
    refetchInterval: 60_000,
  });

  useLiveEvent('notification', (raw) => {
    const n = raw as Notification;
    if (!n?.titleEn) return;
    const show = n.severity === 'critical' ? toast.error : n.severity === 'warning' ? toast.warning : toast.info;
    show(bi(n, 'title'), { description: bi(n, 'body') || undefined, duration: n.severity === 'critical' ? 12_000 : 5_000 });
  });

  const open = async (n: Notification) => {
    if (!n.readAt) {
      await api.post(`/notifications/${n.id}/read`);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    }
    if (n.link) navigate(n.link);
  };

  const unread = data?.unread ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="relative grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-sunken hover:text-ink" aria-label={t('topbar.notifications')}>
          <Bell className="size-[18px]" />
          {unread > 0 ? (
            <span className="absolute -top-0.5 -end-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-crit px-1 text-[10.5px] font-semibold text-white tabular">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-sm font-semibold">{t('topbar.notifications')}</span>
          {unread > 0 ? (
            <Button
              variant="link"
              size="sm"
              onClick={async () => {
                await api.post('/notifications/read-all');
                void qc.invalidateQueries({ queryKey: ['notifications'] });
              }}
            >
              {t('actions.markAllRead')}
            </Button>
          ) : null}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {!data?.items.length ? (
            <EmptyState icon={Bell} title={t('topbar.noNotifications')} />
          ) : (
            data.items.map((n) => {
              const Icon = n.severity === 'critical' ? AlertOctagon : n.severity === 'warning' ? TriangleAlert : Info;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void open(n)}
                  className={cn('flex w-full gap-3 border-b border-line px-4 py-3 text-start last:border-0 hover:bg-sunken', !n.readAt && 'bg-accent-soft/40')}
                >
                  <Icon className={cn('mt-0.5 size-4 shrink-0', n.severity === 'critical' ? 'text-crit' : n.severity === 'warning' ? 'text-warn' : 'text-info')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{bi(n, 'title')}</span>
                    {bi(n, 'body') ? <span className="mt-0.5 block text-[12.5px] text-muted">{bi(n, 'body')}</span> : null}
                    <span className="mt-1 block text-[11.5px] text-faint">{f.relative(n.createdAt)}</span>
                  </span>
                  {!n.readAt ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" /> : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
