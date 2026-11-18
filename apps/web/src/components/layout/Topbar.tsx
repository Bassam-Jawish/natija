import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Languages, LogOut, Menu as MenuIcon, Monitor, Moon, RotateCcw, Search, Sun, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { applyLanguage, useBi, useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { loadMock, MOCK } from '@/lib/mode';
import { cn } from '@/lib/utils';
import { Avatar, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '@/components/ui';
import { NotificationsBell } from './NotificationsBell';
import { useTheme, type ThemeChoice } from './theme';

export function Topbar({ onOpenNav, onOpenPalette }: { onOpenNav: () => void; onOpenPalette: () => void }) {
  const { t } = useTranslation();
  const { me, logout } = useAuth();
  const bi = useBi();
  const lang = useLang();
  const live = useLive();
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  if (!me) return null;

  const switchLanguage = () => {
    const next = lang === 'ar' ? 'en' : 'ar';
    applyLanguage(next);
    void api.put('/auth/me/language', { language: next }).catch(() => {});
  };

  const themeIcon = { light: Sun, dark: Moon, system: Monitor }[theme];
  const ThemeIcon = themeIcon;
  const name = bi(me.user, 'fullName');

  return (
    <header className="no-print flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 lg:px-5">
      <button type="button" onClick={onOpenNav} className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-sunken lg:hidden" aria-label={t('topbar.menu')}>
        <MenuIcon className="size-5" />
      </button>
      <button
        type="button"
        onClick={onOpenPalette}
        className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-sunken px-3 text-start text-[13.5px] text-faint transition-colors hover:border-line-strong sm:max-w-[460px]"
      >
        <Search className="size-4 shrink-0" />
        <span className="truncate">{t('topbar.search')}</span>
        <span className="ms-auto hidden items-center gap-1 sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ms-auto flex items-center gap-1">
        {MOCK ? (
          <Tooltip content={t('mock.badgeHint')}>
            <span className="hidden rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-medium text-warn sm:inline">{t('mock.badge')}</span>
          </Tooltip>
        ) : null}
        <Tooltip content={live.connected ? t('topbar.live') : t('topbar.offline')}>
          <span className="hidden items-center gap-1.5 px-2 text-[12px] text-muted md:flex">
            <span className={cn('size-2 rounded-full', live.connected ? 'bg-ok' : 'bg-faint')} />
            {live.connected ? t('topbar.liveShort') : t('topbar.offlineShort')}
          </span>
        </Tooltip>
        <button type="button" onClick={switchLanguage} className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink-2 hover:bg-sunken" aria-label={t('topbar.language')}>
          <Languages className="size-4" />
          {lang === 'ar' ? 'EN' : 'ع'}
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-sunken" aria-label={t('topbar.theme.label')}>
              <ThemeIcon className="size-[18px]" />
            </button>
          </MenuTrigger>
          <MenuContent>
            {(['light', 'dark', 'system'] as ThemeChoice[]).map((c) => (
              <MenuItem key={c} onSelect={() => setTheme(c)}>
                <Check className={cn(theme === c ? 'opacity-100' : 'opacity-0')} />
                {t(`topbar.theme.${c}`)}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <NotificationsBell />
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="ms-1 flex items-center gap-2 rounded-lg p-1 pe-2 hover:bg-sunken">
              <Avatar name={name} />
              <span className="hidden min-w-0 text-start md:block">
                <span className="block max-w-40 truncate text-[13px] leading-tight font-medium text-ink">{name}</span>
                <span className="block max-w-40 truncate text-[11.5px] leading-tight text-muted">{me.roles.map((r) => bi(r, 'name')).join(' · ')}</span>
              </span>
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>
              {me.user.username} @ {me.lab.code}
            </MenuLabel>
            <MenuItem onSelect={() => navigate('/account')}>
              <UserRound />
              {t('nav.account')}
            </MenuItem>
            {MOCK ? (
              <MenuItem
                onSelect={async () => {
                  if (!window.confirm(t('mock.resetConfirm'))) return;
                  await (await loadMock()).resetMock();
                  window.location.reload();
                }}
              >
                <RotateCcw />
                {t('mock.resetData')}
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={async () => {
                await logout();
                navigate('/login');
              }}
            >
              <LogOut />
              {t('actions.signOut')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}
