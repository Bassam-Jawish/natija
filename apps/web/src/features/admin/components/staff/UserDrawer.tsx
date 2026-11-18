import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { StaffTemporaryPassword, StaffUser } from '@natija/contracts';
import { api } from '@/lib/api';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Checkbox, Drawer, Field, Input, Select, toast } from '@/components/ui';
import { adminKeys, useBranches, useLookups, useRoles } from '../../api';
import { BilingualFields, SectionTitle, useAdminError, useFieldErrors } from '../common';

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,58}[a-z0-9]$/;

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
}

function CheckList({ items, selected, onChange, empty }: { items: Array<{ id: string; label: string; hint?: ReactNode }>; selected: string[]; onChange: (ids: string[]) => void; empty?: string }) {
  if (!items.length) return <p className="text-[12.5px] text-muted">{empty}</p>;
  return (
    <div className="grid gap-x-4 gap-y-2 rounded-lg border border-line p-3 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.id} className="flex min-w-0 items-center justify-between gap-2">
          <Checkbox checked={selected.includes(it.id)} onCheckedChange={(v) => onChange(toggle(selected, it.id, v))} label={it.label} />
          {it.hint ? <span className="shrink-0 text-[11.5px] text-faint">{it.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Create or edit a staff account: names, contact, language, roles and department / branch scope. */
export function UserDrawer({ user, onClose, onCreated }: { user: StaffUser | null; onClose: () => void; onCreated: (r: StaffTemporaryPassword) => void }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const roles = useRoles();
  const lookups = useLookups();
  const branches = useBranches();
  const [username, setUsername] = useState(user?.username ?? '');
  const [fullNameAr, setFullNameAr] = useState(user?.fullNameAr ?? '');
  const [fullNameEn, setFullNameEn] = useState(user?.fullNameEn ?? '');
  const [title, setTitle] = useState(user?.title ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [language, setLanguage] = useState<string>(user?.language ?? 'lab');
  const [roleIds, setRoleIds] = useState<string[]>(user?.roleIds ?? []);
  const [departmentIds, setDepartmentIds] = useState<string[]>(user?.departmentIds ?? []);
  const [branchIds, setBranchIds] = useState<string[]>(user?.branchIds ?? []);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        fullNameAr,
        fullNameEn,
        title,
        email,
        phone,
        language: language === 'lab' ? null : language,
        roleIds,
        departmentIds,
        branchIds,
      };
      if (user) return { kind: 'updated' as const, user: await api.put<StaffUser>(`/staff/users/${user.id}`, body) };
      return { kind: 'created' as const, result: await api.post<StaffTemporaryPassword>('/staff/users', { ...body, username: username.trim().toLowerCase() }) };
    },
    onSuccess: async (out) => {
      await Promise.all([qc.invalidateQueries({ queryKey: adminKeys.users }), qc.invalidateQueries({ queryKey: adminKeys.roles })]);
      if (out.kind === 'created') onCreated(out.result);
      else toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = useFieldErrors(save.error);
  const usernameError = !user && username && !USERNAME.test(username.trim().toLowerCase()) ? t('fieldErrors.invalid_username') : errors.username;
  const valid = fullNameAr.trim() && fullNameEn.trim() && roleIds.length > 0 && (user || USERNAME.test(username.trim().toLowerCase()));

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="md"
      title={user ? t('staff.users.edit') : t('staff.users.new')}
      description={user ? <span className="font-mono ltr-num">{user.username}</span> : t('staff.users.newHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {user ? t('common:actions.saveChanges') : t('staff.users.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <section className="flex flex-col gap-3">
          <SectionTitle>{t('staff.users.account')}</SectionTitle>
          {!user ? (
            <Field label={t('fields.username')} required hint={t('staff.users.usernameHint')} error={usernameError}>
              {(id) => <Input id={id} ltr autoFocus autoComplete="off" className="font-mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} invalid={!!usernameError} />}
            </Field>
          ) : null}
          <BilingualFields
            ar={fullNameAr}
            en={fullNameEn}
            onAr={setFullNameAr}
            onEn={setFullNameEn}
            labelAr={t('staff.users.nameAr')}
            labelEn={t('staff.users.nameEn')}
            errorAr={errors.fullNameAr}
            errorEn={errors.fullNameEn}
            autoFocus={!!user}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('staff.users.title')} hint={t('staff.users.titleHint')}>
              {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}
            </Field>
            <Field label={t('staff.users.language')}>
              {(id) => (
                <Select
                  id={id}
                  value={language}
                  onValueChange={setLanguage}
                  options={[
                    { value: 'lab', label: t('staff.users.labDefault') },
                    { value: 'ar', label: 'العربية' },
                    { value: 'en', label: 'English' },
                  ]}
                />
              )}
            </Field>
            <Field label={t('fields.email')} error={errors.email}>
              {(id) => <Input id={id} ltr type="email" value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!errors.email} />}
            </Field>
            <Field label={t('settings.profile.phone')}>{(id) => <Input id={id} ltr value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
          </div>
        </section>

        <section>
          <SectionTitle>
            {t('fields.roleIds')} <span className="text-crit">*</span>
          </SectionTitle>
          <CheckList
            items={(roles.data ?? []).map((r) => ({
              id: r.id,
              label: bi(r, 'name'),
              hint: r.isSystem ? (
                <Badge tone="muted">{t('staff.roles.system')}</Badge>
              ) : (
                t('staff.roles.permissionCount', { count: r.permissions.length })
              ),
            }))}
            selected={roleIds}
            onChange={setRoleIds}
            empty={t('common.loadingMore')}
          />
          {errors.roleIds ? <p className="mt-1 text-[12.5px] text-crit">{errors.roleIds}</p> : null}
        </section>

        <section>
          <SectionTitle>{t('staff.users.departmentScope')}</SectionTitle>
          <p className="mb-2 text-[12.5px] text-muted">{t('staff.users.departmentScopeHint')}</p>
          <CheckList items={(lookups.data?.departments ?? []).map((d) => ({ id: d.id, label: bi(d, 'name') }))} selected={departmentIds} onChange={setDepartmentIds} empty={t('common.loadingMore')} />
        </section>

        <section>
          <SectionTitle>{t('staff.users.branchScope')}</SectionTitle>
          <p className="mb-2 text-[12.5px] text-muted">{t('staff.users.branchScopeHint')}</p>
          <CheckList items={(branches.data ?? []).map((b) => ({ id: b.id, label: bi(b, 'name') }))} selected={branchIds} onChange={setBranchIds} empty={t('common.loadingMore')} />
        </section>
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
