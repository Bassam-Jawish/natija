import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Building2, KeyRound, Languages, UserRound } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { applyLanguage, useBi, useLang } from '@/lib/i18n';
import { MOCK } from '@/lib/mode';
import { cn } from '@/lib/utils';
import { Badge, Button, Field, Input, useErrorMessage } from '@/components/ui';
import { LabLogo, NatijaMark } from '@/components/layout/LabLogo';

type DemoAccounts = {
  password: string;
  labs: Array<{
    lab: { code: string; nameAr: string; nameEn: string; brandColor: string; logoSvg: string | null; city: string | null };
    accounts: Array<{ username: string; fullNameAr: string; fullNameEn: string; roles: Array<{ key: string; nameAr: string; nameEn: string }> }>;
  }>;
};

export default function LoginPage() {
  const { t } = useTranslation();
  const { me, login } = useAuth();
  const lang = useLang();
  const bi = useBi();
  const errorMessage = useErrorMessage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [labCode, setLabCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeLab, setActiveLab] = useState<string | null>(null);

  const demo = useQuery({
    queryKey: ['demo-accounts'],
    queryFn: () => api.get<DemoAccounts>('/auth/demo-accounts'),
    retry: false,
    staleTime: Infinity,
  });

  if (me) return <Navigate to={params.get('next') || '/'} replace />;

  const signIn = async (lab = labCode, user = username, pass = password) => {
    setBusy(true);
    setError(null);
    try {
      await login(lab.trim(), user.trim(), pass);
      navigate(params.get('next') || '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errorMessage(err) : t('errors.network'));
    } finally {
      setBusy(false);
    }
  };

  const labs = demo.data?.labs ?? [];
  const selectedLab = labs.find((l) => l.lab.code === (activeLab ?? labs[0]?.lab.code));

  return (
    <div className="min-h-dvh bg-paper">
      <div className="mx-auto flex min-h-dvh max-w-[1180px] flex-col gap-8 px-4 py-8 lg:flex-row lg:items-center lg:gap-14">
        <div className="flex flex-1 flex-col gap-6 lg:max-w-[420px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <NatijaMark className="size-10" />
              <div>
                <div className="text-xl font-semibold tracking-tight text-ink">
                  Natija <span className="font-medium text-muted">· نتيجة</span>
                </div>
                <div className="text-[13px] text-muted">{t('auth.tagline')}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => applyLanguage(lang === 'ar' ? 'en' : 'ar')}
              className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink-2 hover:bg-sunken"
            >
              <Languages className="size-4" />
              {lang === 'ar' ? 'English' : 'العربية'}
            </button>
          </div>

          <form
            className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn();
            }}
          >
            <div>
              <h1 className="text-lg font-semibold text-ink">{t('auth.title')}</h1>
              <p className="text-[13px] text-muted">{t('auth.subtitle')}</p>
            </div>
            <Field label={t('auth.labCode')} hint={t('auth.labCodeHint')}>
              {(id) => <Input id={id} value={labCode} onChange={(e) => setLabCode(e.target.value)} leading={<Building2 />} autoComplete="organization" ltr required={!MOCK} />}
            </Field>
            <Field label={t('auth.username')}>
              {(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} leading={<UserRound />} autoComplete="username" ltr required={!MOCK} />}
            </Field>
            <Field label={t('auth.password')}>
              {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} leading={<KeyRound />} autoComplete="current-password" required={!MOCK} />}
            </Field>
            {error ? <p className="rounded-lg bg-crit-soft px-3 py-2 text-[13px] text-crit">{error}</p> : null}
            <Button type="submit" variant="primary" size="lg" loading={busy}>
              {t('auth.signIn')}
              <ArrowRight className="rtl:rotate-180" />
            </Button>
            <p className={cn('text-[12px]', MOCK ? 'rounded-lg bg-warn-soft px-3 py-2 text-warn' : 'text-faint')}>{MOCK ? t('mock.loginHint') : t('auth.securityNote')}</p>
          </form>
        </div>

        {labs.length ? (
          <div className="min-w-0 flex-1">
            <div className="rounded-2xl border border-line bg-surface p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold text-ink">{t('auth.demoTitle')}</h2>
                  <p className="text-[13px] text-muted">{t('auth.demoHint')}</p>
                </div>
                <Badge tone="warn">
                  {t('auth.demoPassword')}: <span className="font-mono ltr-num">{demo.data?.password}</span>
                </Badge>
              </div>
              <div className="mb-4 grid gap-2 sm:grid-cols-3">
                {labs.map((l) => (
                  <button
                    key={l.lab.code}
                    type="button"
                    onClick={() => setActiveLab(l.lab.code)}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border p-3 text-start transition-colors',
                      selectedLab?.lab.code === l.lab.code ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong',
                    )}
                  >
                    <LabLogo svg={l.lab.logoSvg} name={l.lab.nameEn} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-ink">{bi(l.lab, 'name')}</span>
                      <span className="block text-[12px] text-muted">
                        {l.lab.city} · <span className="font-mono">{l.lab.code}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {selectedLab ? (
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {selectedLab.accounts.map((a) => (
                    <li key={a.username} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium text-ink">{bi(a, 'fullName')}</span>
                        <span className="block text-[12px] text-muted">
                          <span className="font-mono ltr-num">{a.username}</span> · {a.roles.map((r) => bi(r, 'name')).join(' · ')}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={busy}
                        onClick={() => {
                          setLabCode(selectedLab.lab.code);
                          setUsername(a.username);
                          setPassword(demo.data!.password);
                          void signIn(selectedLab.lab.code, a.username, demo.data!.password);
                        }}
                      >
                        {t('auth.useAccount')}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-3 text-[12px] text-faint">{t('auth.demoDisclaimer')}</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
