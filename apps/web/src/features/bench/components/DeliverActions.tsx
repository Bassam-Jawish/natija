import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link2, Mail, MessageCircle, MessageSquare, Printer } from 'lucide-react';
import type { BenchDeliveryChannel } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { openPrint } from '@/lib/print';
import { Button, toast, Tooltip } from '@/components/ui';
import { benchApi } from '../api';
import { ltr, useBenchError } from './common';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a released report over: print, WhatsApp (opens the desk's own WhatsApp with the message
 * ready), SMS / email (queued in the outbox), or copy the patient link.
 */
export function DeliverActions({ orderId, labels = false, version }: { orderId: string; labels?: boolean; version?: number }) {
  const { t } = useTranslation('bench');
  const qc = useQueryClient();
  const { can } = useAuth();
  const errorMessage = useBenchError();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['reports'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };
  const deliver = useMutation({
    mutationFn: ({ channel }: { channel: BenchDeliveryChannel; win?: Window | null }) => benchApi.deliver(orderId, channel),
    onSuccess: (res, { channel, win }) => {
      if (channel === 'whatsapp' && res.url) {
        if (win) win.location.href = res.url;
        else window.open(res.url, '_blank', 'noopener');
        toast.success(t('delivery.whatsappOpened'));
      } else if (channel === 'sms' || channel === 'email') {
        toast.success(t(res.delivery.status === 'simulated' ? 'delivery.simulated' : 'delivery.queued', { channel: t(`delivery.channels.${channel}`), to: ltr(res.delivery.toAddress) }));
      }
      if (res.orderDelivered) toast.info(t('delivery.orderDelivered'));
      done();
    },
    onError: (err, { win }) => {
      win?.close();
      toast.error(errorMessage(err));
    },
  });
  const link = useMutation({
    mutationFn: () => benchApi.link(orderId),
    onSuccess: async (res) => {
      if (await copy(res.url)) toast.success(t('delivery.linkCopied'));
      else toast.info(res.url, { duration: 20_000 });
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const canDeliver = can('reports.deliver');
  const item = (key: string, label: string, icon: ReactNode, onClick: () => void, disabled = false) =>
    labels ? (
      <Button key={key} size="sm" variant="secondary" onClick={onClick} disabled={disabled || deliver.isPending}>
        {icon}
        {label}
      </Button>
    ) : (
      <Tooltip key={key} content={label}>
        <Button size="icon-sm" variant="ghost" onClick={onClick} disabled={disabled || deliver.isPending} aria-label={label}>
          {icon}
        </Button>
      </Tooltip>
    );
  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      {can('reports.print', 'reports.deliver')
        ? item('print', t('delivery.channels.print'), <Printer />, () => {
            openPrint(`/print/report/${orderId}${version ? `?version=${version}` : ''}`);
            deliver.mutate({ channel: 'print' });
          })
        : null}
      {canDeliver
        ? [
            item('whatsapp', t('delivery.channels.whatsapp'), <MessageCircle className="text-ok" />, () => {
              // Opened during the click so pop-up blockers allow it; pointed at wa.me once the link exists.
              const win = window.open('about:blank', '_blank');
              if (win) win.opener = null;
              deliver.mutate({ channel: 'whatsapp', win });
            }),
            item('sms', t('delivery.channels.sms'), <MessageSquare />, () => deliver.mutate({ channel: 'sms' })),
            item('email', t('delivery.channels.email'), <Mail />, () => deliver.mutate({ channel: 'email' })),
            item('link', t('delivery.copyLink'), <Link2 />, () => link.mutate(), link.isPending),
          ]
        : null}
    </div>
  );
}
