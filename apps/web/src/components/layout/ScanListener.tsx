import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Barcode scanners type like a keyboard: fast keystrokes ending in Enter. When that happens
 * outside a text field, open the scanned tube or order. Inside a text field the page handles it.
 */
export function ScanListener() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const buffer = useRef('');
  const last = useRef(0);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (inField || e.ctrlKey || e.metaKey || e.altKey) {
        buffer.current = '';
        return;
      }
      const now = performance.now();
      if (now - last.current > 60) buffer.current = '';
      last.current = now;
      if (e.key === 'Enter') {
        const code = buffer.current;
        buffer.current = '';
        if (code.length < 6 || !can('orders.read')) return;
        try {
          const res = await api.get<{ samples: Array<{ barcode: string; orderId: string }>; orders: Array<{ id: string; accession: string }> }>('/search', { q: code });
          const tube = res.samples.find((s) => s.barcode === code);
          if (tube) return navigate(`/orders/${tube.orderId}?tube=${encodeURIComponent(code)}`);
          const order = res.orders.find((o) => o.accession === code);
          if (order) return navigate(`/orders/${order.id}`);
          toast.warning(t('scan.notFound', { code }));
        } catch {
          toast.error(t('errors.network'));
        }
        return;
      }
      if (e.key.length === 1) buffer.current += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can, navigate, t]);

  return null;
}
