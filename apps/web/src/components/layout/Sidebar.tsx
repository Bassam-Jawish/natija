import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NAV } from '@/app/nav';
import { useAuth } from '@/lib/auth';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Tooltip } from '@/components/ui';
import { LabLogo, NatijaMark } from './LabLogo';

export function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const bi = useBi();
  if (!me) return null;
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(...i.perms)) })).filter((g) => g.items.length);
  const labName = bi(me.lab, 'name');

  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-e border-line bg-surface transition-[width] duration-200', collapsed ? 'w-[68px]' : 'w-[248px]')}>
      <div className={cn('flex items-center gap-3 border-b border-line px-3.5', collapsed ? 'h-14 justify-center px-0' : 'h-14')}>
        <LabLogo svg={me.lab.logoSvg} name={labName} />
        {!collapsed ? (
          <div className="min-w-0">
            <div className="truncate text-[13.5px] leading-tight font-semibold text-ink">{labName}</div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
              <span className="truncate">{bi(me.lab, 'tagline') || me.lab.code}</span>
            </div>
          </div>
        ) : null}
      </div>
      {me.lab.settings?.demo && !collapsed ? (
        <div className="px-3.5 pt-3">
          <Badge tone="warn" className="w-full justify-center">
            {t('app.demoBanner')}
          </Badge>
        </div>
      ) : null}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {groups.map((g) => (
          <div key={g.key} className="mb-4">
            {!collapsed ? <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">{t(g.labelKey)}</div> : <div className="mx-auto mb-2 h-px w-6 bg-line" />}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const link = (
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
                        collapsed && 'justify-center px-0',
                        isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-sunken hover:text-ink',
                      )
                    }
                  >
                    <item.icon className="size-[18px] shrink-0" />
                    {!collapsed ? <span className="truncate">{t(item.labelKey)}</span> : null}
                  </NavLink>
                );
                return <li key={item.to}>{collapsed ? <Tooltip content={t(item.labelKey)} side="right">{link}</Tooltip> : link}</li>;
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cn('flex items-center border-t border-line p-2.5', collapsed ? 'justify-center' : 'justify-between')}>
        {!collapsed ? (
          <span className="flex items-center gap-2 ps-1 text-[12px] text-muted">
            <NatijaMark className="size-5" />
            <span className="font-semibold text-ink-2">Natija</span>
            <span className="text-faint">نتيجة</span>
          </span>
        ) : null}
        {onToggle ? (
          <button type="button" onClick={onToggle} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink" aria-label={t('topbar.toggleSidebar')}>
            {collapsed ? <PanelLeftOpen className="size-4 rtl:rotate-180" /> : <PanelLeftClose className="size-4 rtl:rotate-180" />}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
