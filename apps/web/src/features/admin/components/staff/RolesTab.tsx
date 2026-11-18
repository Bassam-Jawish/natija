import { Fragment, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ellipsis, Info, Pencil, Plus, Save, ShieldCheck, Trash2, Users } from 'lucide-react';
import type { StaffRole } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBi, useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  toast,
} from '@/components/ui';
import { adminKeys, usePermissionGroups, useRoles } from '../../api';
import { useAdminError } from '../common';
import { settle } from '../common';
import { NewRoleDialog, RenameRoleDialog } from './RoleDialogs';

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/**
 * Role × permission matrix. Edits stay local until saved; each changed role is then saved on
 * its own (the server refuses a change that would leave nobody able to manage staff).
 */
export function RolesTab() {
  const { t } = useTranslation('admin');
  const lang = useLang();
  const bi = useBi();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const errorMessage = useAdminError();
  const roles = useRoles();
  const groups = usePermissionGroups();
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<StaffRole | null>(null);
  const [deleting, setDeleting] = useState<StaffRole | null>(null);

  const list = roles.data ?? [];
  const permsOf = (r: StaffRole) => draft[r.id] ?? r.permissions;
  const dirty = list.filter((r) => draft[r.id] && !sameSet(draft[r.id]!, r.permissions));
  const setPerms = (r: StaffRole, perms: string[]) => setDraft((d) => ({ ...d, [r.id]: [...new Set(perms)].sort() }));
  const toggle = (r: StaffRole, keys: string[], on: boolean) => setPerms(r, on ? [...permsOf(r), ...keys] : permsOf(r).filter((p) => !keys.includes(p)));
  const label = (x: { ar: string; en: string }) => (lang === 'ar' ? x.ar : x.en);

  const remove = useMutation({
    mutationFn: (r: StaffRole) => api.del(`/staff/roles/${r.id}`),
    onSuccess: async () => {
      toast.success(t('common.deleted'));
      await qc.invalidateQueries({ queryKey: adminKeys.roles });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const saveAll = async () => {
    setSaving(true);
    let saved = 0;
    for (const r of dirty) {
      try {
        await api.put(`/staff/roles/${r.id}`, { nameAr: r.nameAr, nameEn: r.nameEn, permissions: draft[r.id] });
        saved++;
        setDraft((d) => {
          const next = { ...d };
          delete next[r.id];
          return next;
        });
      } catch (err) {
        toast.error(`${bi(r, 'name')}: ${errorMessage(err)}`);
      }
    }
    await Promise.all([qc.invalidateQueries({ queryKey: adminKeys.roles }), qc.invalidateQueries({ queryKey: adminKeys.users })]);
    await refresh();
    setSaving(false);
    if (saved) toast.success(t('staff.roles.saved', { count: saved }));
  };

  if (roles.isLoading || groups.isLoading) return <Skeleton className="h-[480px]" />;
  if (roles.error || groups.error) return <ErrorState error={roles.error ?? groups.error} onRetry={() => void Promise.all([roles.refetch(), groups.refetch()])} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-[12.5px] text-info">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{t('staff.roles.note')}</span>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus />
          {t('staff.roles.new')}
        </Button>
      </div>

      {!list.length ? (
        <EmptyState icon={ShieldCheck} title={t('staff.roles.empty')} />
      ) : (
        <Card padded={false}>
          <div className="max-h-[68vh] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-20">
                <tr>
                  <th className="sticky start-0 z-30 min-w-64 border-e border-b border-line bg-sunken px-3 py-2 text-start align-bottom text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                    {t('fields.permissions')}
                  </th>
                  {list.map((r) => {
                    const edited = dirty.includes(r);
                    return (
                      <th key={r.id} className={cn('min-w-[124px] border-b border-line bg-sunken px-2 py-2 align-bottom', edited && 'bg-warn-soft')}>
                        <div className="flex flex-col items-center gap-1 text-center">
                          <span className="text-[12.5px] leading-tight font-semibold text-ink">{bi(r, 'name')}</span>
                          <span className="font-mono text-[10.5px] text-faint ltr-num">{r.key}</span>
                          <div className="flex flex-wrap items-center justify-center gap-1">
                            {r.isSystem ? <Badge tone="muted">{t('staff.roles.system')}</Badge> : null}
                            <Badge tone="neutral" className="ltr-num">
                              <Users className="size-3" />
                              {r.userCount}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1 text-[11px] font-normal text-muted">
                            <span className="tabular">{t('staff.roles.permissionCount', { count: permsOf(r).length })}</span>
                            <Menu>
                              <MenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" className="size-6" aria-label={t('common.actions')}>
                                  <Ellipsis />
                                </Button>
                              </MenuTrigger>
                              <MenuContent>
                                <MenuItem onSelect={() => setRenaming(r)}>
                                  <Pencil />
                                  {t('staff.roles.rename')}
                                </MenuItem>
                                <MenuItem danger disabled={r.isSystem} onSelect={() => setDeleting(r)}>
                                  <Trash2 />
                                  {t('common:actions.delete')}
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          </div>
                          {edited ? (
                            <Badge tone="warn" dot>
                              {t('staff.roles.edited')}
                            </Badge>
                          ) : null}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(groups.data ?? []).map((g) => {
                  const keys = g.permissions.map((p) => p.key);
                  return (
                    <Fragment key={g.group}>
                      <tr>
                        <td className="sticky start-0 z-10 border-e border-b border-line bg-sunken px-3 py-1.5 text-[12.5px] font-semibold text-ink-2">{label(g)}</td>
                        {list.map((r) => {
                          const have = keys.filter((k) => permsOf(r).includes(k)).length;
                          return (
                            <td key={r.id} className="border-b border-line bg-sunken/60 py-1.5 text-center">
                              <span className="inline-flex">
                                <Checkbox
                                  checked={have === keys.length ? true : have > 0 ? 'indeterminate' : false}
                                  onCheckedChange={(v) => toggle(r, keys, v)}
                                  label={<span className="sr-only">{`${bi(r, 'name')} · ${label(g)}`}</span>}
                                />
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                      {g.permissions.map((p) => (
                        <tr key={p.key} className="hover:bg-sunken/40">
                          <td className="sticky start-0 z-10 border-e border-b border-line bg-surface px-3 py-1.5">
                            <div className="text-[13px] text-ink">{label(p)}</div>
                            <div className="font-mono text-[10.5px] text-faint ltr-num">{p.key}</div>
                          </td>
                          {list.map((r) => {
                            const on = permsOf(r).includes(p.key);
                            const changed = draft[r.id] ? on !== r.permissions.includes(p.key) : false;
                            return (
                              <td key={r.id} className={cn('border-b border-line py-1.5 text-center', changed && 'bg-warn-soft/70')}>
                                <span className="inline-flex">
                                  <Checkbox checked={on} onCheckedChange={(v) => toggle(r, [p.key], v)} label={<span className="sr-only">{`${bi(r, 'name')} · ${label(p)}`}</span>} />
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={cn('flex items-center justify-end gap-2 border-t border-line px-4 py-2.5', dirty.length && 'bg-warn-soft/50')}>
            <span className="me-auto text-[12.5px] text-muted">
              {dirty.length ? t('staff.roles.dirty', { count: dirty.length }) : t('staff.roles.clean')}
            </span>
            <Button variant="ghost" disabled={!dirty.length || saving} onClick={() => setDraft({})}>
              {t('common:actions.reset')}
            </Button>
            <Button variant="primary" loading={saving} disabled={!dirty.length} onClick={() => void saveAll()}>
              <Save />
              {t('common:actions.saveChanges')}
            </Button>
          </div>
        </Card>
      )}

      {creating ? <NewRoleDialog roles={list} onClose={() => setCreating(false)} onCreated={() => undefined} /> : null}
      {renaming ? <RenameRoleDialog role={renaming} onClose={() => setRenaming(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('common.deleteTitle', { name: deleting ? bi(deleting, 'name') : '' })}
        description={t('staff.roles.deleteBody')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => (deleting ? settle(remove.mutateAsync(deleting)) : undefined)}
      />
    </div>
  );
}
