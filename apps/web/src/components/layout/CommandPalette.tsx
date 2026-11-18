import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Dialog as RDialog } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { ClipboardList, CornerDownLeft, Search, TestTube, UserRound } from 'lucide-react';
import { NAV } from '@/app/nav';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { StatusChip, Spinner } from '@/components/ui';

type SearchResult = {
  patients: Array<{ id: string; mrn: string; fullNameAr: string; fullNameEn: string | null; sex: string; birthDate: string; phone: string | null }>;
  orders: Array<{ id: string; accession: string; status: string; createdAt: string; patientName: string }>;
  samples: Array<{ id: string; barcode: string; status: string; orderId: string }>;
};

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const f = useFormat();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', term],
    queryFn: () => api.get<SearchResult>('/search', { q: term }),
    enabled: open && term.length >= 2 && can('patients.read', 'orders.read'),
  });

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const items = NAV.flatMap((g) => g.items).filter((i) => can(...i.perms));

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-raised shadow-pop">
          <RDialog.Title className="sr-only">{t('palette.title')}</RDialog.Title>
          <RDialog.Description className="sr-only">{t('palette.placeholder')}</RDialog.Description>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-[18px] text-faint" />
              <Command.Input value={q} onValueChange={setQ} placeholder={t('palette.placeholder')} className="h-13 w-full bg-transparent py-4 text-[15px] outline-none placeholder:text-faint" />
              {isFetching ? <Spinner /> : null}
            </div>
            <Command.List className="max-h-[56vh] overflow-y-auto p-2">
              {term.length >= 2 && data && !data.patients.length && !data.orders.length && !data.samples.length ? (
                <div className="px-3 py-8 text-center text-sm text-muted">{t('palette.noResults')}</div>
              ) : null}
              {data?.samples.length ? (
                <Command.Group heading={t('palette.samples')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint">
                  {data.samples.map((s) => (
                    <Command.Item key={s.id} value={`s-${s.id}`} onSelect={() => go(`/orders/${s.orderId}?tube=${s.barcode}`)} className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm data-[selected=true]:bg-sunken">
                      <TestTube className="size-4 text-muted" />
                      <span className="font-mono ltr-num">{s.barcode}</span>
                      <StatusChip kind="sample" status={s.status} className="ms-auto" />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {data?.orders.length ? (
                <Command.Group heading={t('palette.orders')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint">
                  {data.orders.map((o) => (
                    <Command.Item key={o.id} value={`o-${o.id}`} onSelect={() => go(`/orders/${o.id}`)} className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm data-[selected=true]:bg-sunken">
                      <ClipboardList className="size-4 text-muted" />
                      <span className="font-mono ltr-num">{o.accession}</span>
                      <span className="truncate text-muted">{o.patientName}</span>
                      <StatusChip kind="order" status={o.status} className="ms-auto" />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {data?.patients.length ? (
                <Command.Group heading={t('palette.patients')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint">
                  {data.patients.map((p) => (
                    <Command.Item key={p.id} value={`p-${p.id}`} onSelect={() => go(`/patients/${p.id}`)} className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm data-[selected=true]:bg-sunken">
                      <UserRound className="size-4 text-muted" />
                      <span className="truncate">{p.fullNameAr}</span>
                      <span className="ms-auto shrink-0 text-[12px] text-muted">
                        <span className="font-mono ltr-num">{p.mrn}</span> · {t(`common.${p.sex}`)} · {f.age(p.birthDate)}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group heading={t('palette.navigation')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint">
                {items
                  .filter((i) => !term || t(i.labelKey).toLowerCase().includes(term.toLowerCase()))
                  .map((i) => (
                    <Command.Item key={i.to} value={`n-${i.to}`} onSelect={() => go(i.to)} className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm data-[selected=true]:bg-sunken">
                      <i.icon className="size-4 text-muted" />
                      {t(i.labelKey)}
                      <CornerDownLeft className="ms-auto size-3.5 text-faint" />
                    </Command.Item>
                  ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
