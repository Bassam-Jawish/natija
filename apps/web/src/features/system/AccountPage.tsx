import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { applyLanguage, useBi, useLang } from '@/lib/i18n';
import { Badge, Button, Card, Field, InfoList, Input, PageHeader, Segmented, useErrorMessage } from '@/components/ui';
import { useTheme, type ThemeChoice } from '@/components/layout/theme';

export default function AccountPage() {
  const { t } = useTranslation();
  const { me, logout } = useAuth();
  const bi = useBi();
  const lang = useLang();
  const [theme, setTheme] = useTheme();
  const errorMessage = useErrorMessage();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const mismatch = confirm.length > 0 && confirm !== next;
  const changePassword = async () => {
    setBusy(true);
    try {
      await api.put('/auth/me/password', { current, next });
      toast.success(t('account.passwordChanged'));
      await logout();
      navigate('/login');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('account.title')} description={t('account.description')} />
      <div className="flex flex-col gap-4">
        <Card title={t('account.profile')}>
          <InfoList
            items={[
              { label: t('account.name'), value: bi(me.user, 'fullName') },
              { label: t('auth.username'), value: <span className="font-mono ltr-num">{me.user.username}</span> },
              { label: t('account.lab'), value: bi(me.lab, 'name') },
              {
                label: t('account.roles'),
                value: (
                  <span className="flex flex-wrap gap-1.5">
                    {me.roles.map((r) => (
                      <Badge key={r.key} tone="accent">
                        {bi(r, 'name')}
                      </Badge>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        </Card>
        <Card title={t('account.preferences')}>
          <div className="flex flex-col gap-4">
            <Field label={t('topbar.language')}>
              <Segmented
                value={lang}
                onChange={(v) => {
                  applyLanguage(v);
                  void api.put('/auth/me/language', { language: v }).catch(() => {});
                }}
                options={[
                  { value: 'ar', label: 'العربية' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </Field>
            <Field label={t('topbar.theme.label')}>
              <Segmented<ThemeChoice>
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'light', label: t('topbar.theme.light') },
                  { value: 'dark', label: t('topbar.theme.dark') },
                  { value: 'system', label: t('topbar.theme.system') },
                ]}
              />
            </Field>
          </div>
        </Card>
        <Card title={t('account.password')} description={t('account.passwordHint')}>
          <form
            className="grid gap-4 sm:max-w-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void changePassword();
            }}
          >
            <Field label={t('account.currentPassword')}>{(id) => <Input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />}</Field>
            <Field label={t('account.newPassword')} hint={t('account.newPasswordHint')}>
              {(id) => <Input id={id} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />}
            </Field>
            <Field label={t('account.confirmPassword')} error={mismatch ? t('account.mismatch') : null}>
              {(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={mismatch} autoComplete="new-password" />}
            </Field>
            <div>
              <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < 8 || next !== confirm}>
                {t('account.changePassword')}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
