import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ellipsis, KeyRound, Lock, LockOpen, Pencil, UserCheck, UserPlus, UserX } from 'lucide-react';
import type { StaffTemporaryPassword, StaffUser } from '@natija/contracts';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi, useLang } from '@/lib/i18n';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SearchInput,
  Segmented,
  StatusChip,
  toast,
  Tooltip,
  type ColumnDef,
} from '@/components/ui';
import { adminKeys, useBranches, useLookups, useRoles, useStaffUsers } from '../../api';
import { useAdminError } from '../common';
import { settle } from '../common';
import { TempPasswordDialog } from './TempPasswordDialog';
import { UserDrawer } from './UserDrawer';

type Action = 'disable' | 'enable' | 'reset' | 'unlock';

export function UsersTab() {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const lang = useLang();
  const f = useFormat();
  const qc = useQueryClient();
  const { me } = useAuth();
  const errorMessage = useAdminError();
  const users = useStaffUsers();
  const roles = useRoles();
  const lookups = useLookups();
  const branches = useBranches();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [editing, setEditing] = useState<StaffUser | 'new' | null>(null);
  const [temp, setTemp] = useState<{ result: StaffTemporaryPassword; mode: 'created' | 'reset' } | null>(null);
  const [pending, setPending] = useState<{ action: Action; user: StaffUser } | null>(null);

  const roleById = useMemo(() => new Map((roles.data ?? []).map((r) => [r.id, r])), [roles.data]);
  const deptById = useMemo(() => new Map((lookups.data?.departments ?? []).map((d) => [d.id, d])), [lookups.data]);
  const branchById = useMemo(() => new Map((branches.data ?? []).map((b) => [b.id, b])), [branches.data]);

  const act = useMutation({
    mutationFn: ({ action, user }: { action: Action; user: StaffUser }): Promise<StaffUser | StaffTemporaryPassword> =>
      action === 'reset' ? api.post<StaffTemporaryPassword>(`/staff/users/${user.id}/reset-password`) : api.post<StaffUser>(`/staff/users/${user.id}/${action}`),
    onSuccess: async (out, { action, user }) => {
      await Promise.all([qc.invalidateQueries({ queryKey: adminKeys.users }), qc.invalidateQueries({ queryKey: adminKeys.roles })]);
      if (action === 'reset' && 'temporaryPassword' in out) setTemp({ result: out, mode: 'reset' });
      else toast.success(t(`staff.users.done.${action}`, { name: bi(user, 'fullName') }));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const counts = useMemo(() => {
    const all = users.data ?? [];
    return { all: all.length, active: all.filter((u) => u.status === 'active').length, disabled: all.filter((u) => u.status === 'disabled').length };
  }, [users.data]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (users.data ?? []).filter((u) => {
      if (status !== 'all' && u.status !== status) return false;
      if (!term) return true;
      return [u.username, u.fullNameAr, u.fullNameEn, u.email, u.phone, u.title].some((v) => v?.toLowerCase().includes(term));
    });
  }, [users.data, q, status]);

  const scope = (ids: string[], map: Map<string, { nameAr: string; nameEn: string }>, all: string) =>
    ids.length ? ids.map((id) => (map.get(id) ? bi(map.get(id), 'name') : '…')).join(lang === 'ar' ? '، ' : ', ') : <span className="text-faint">{all}</span>;

  const columns: ColumnDef<StaffUser>[] = [
    {
      id: 'user',
      accessorFn: (u) => bi(u, 'fullName'),
      header: t('staff.users.user'),
      cell: ({ row }) => {
        const u = row.original;
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={bi(u, 'fullName')} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate font-medium">
                {u.title ? <span className="text-muted">{u.title}</span> : null}
                {bi(u, 'fullName')}
                {u.id === me?.user.id ? <Badge tone="accent">{t('staff.users.you')}</Badge> : null}
              </div>
              <div className="font-mono text-[12px] text-muted ltr-num">{u.username}</div>
            </div>
          </div>
        );
      },
    },
    {
      id: 'roles',
      header: t('fields.roleIds'),
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.roleIds.map((id) => {
            const r = roleById.get(id);
            return r ? (
              <Badge key={id} tone={r.key === 'owner' ? 'accent' : 'neutral'}>
                {bi(r, 'name')}
              </Badge>
            ) : null;
          })}
        </div>
      ),
    },
    {
      id: 'scope',
      header: t('staff.users.scope'),
      enableSorting: false,
      cell: ({ row }) => (
        <div className="max-w-64 text-[12.5px] leading-5 text-ink-2">
          <div className="truncate">{scope(row.original.departmentIds, deptById, t('staff.users.allDepartments'))}</div>
          {branchById.size > 1 ? <div className="truncate text-muted">{scope(row.original.branchIds, branchById, t('staff.users.allBranches'))}</div> : null}
        </div>
      ),
    },
    {
      id: 'status',
      accessorFn: (u) => u.status,
      header: t('common.status'),
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusChip kind="user" status={row.original.status} />
          {row.original.lockedUntil ? (
            <Tooltip content={t('staff.users.lockedUntil', { time: f.time(row.original.lockedUntil) })}>
              <Badge tone="warn">
                <Lock className="size-3" />
                {t('staff.users.locked')}
              </Badge>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      id: 'lastLogin',
      accessorFn: (u) => u.lastLoginAt ?? '',
      header: t('staff.users.lastLogin'),
      cell: ({ row }) =>
        row.original.lastLoginAt ? (
          <Tooltip content={f.dateTime(row.original.lastLoginAt)}>
            <span className="text-[12.5px] text-ink-2">{f.relative(row.original.lastLoginAt)}</span>
          </Tooltip>
        ) : (
          <span className="text-[12.5px] text-faint">{t('staff.users.never')}</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      meta: { align: 'end' },
      cell: ({ row }) => {
        const u = row.original;
        const self = u.id === me?.user.id;
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('common.actions')}>
                  <Ellipsis />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setEditing(u)}>
                  <Pencil />
                  {t('common:actions.edit')}
                </MenuItem>
                <MenuItem onSelect={() => setPending({ action: 'reset', user: u })}>
                  <KeyRound />
                  {t('staff.users.reset')}
                </MenuItem>
                {u.lockedUntil ? (
                  <MenuItem onSelect={() => setPending({ action: 'unlock', user: u })}>
                    <LockOpen />
                    {t('staff.users.unlock')}
                  </MenuItem>
                ) : null}
                {!self ? <MenuSeparator /> : null}
                {!self && u.status === 'active' ? (
                  <MenuItem danger onSelect={() => setPending({ action: 'disable', user: u })}>
                    <UserX />
                    {t('staff.users.disable')}
                  </MenuItem>
                ) : null}
                {!self && u.status === 'disabled' ? (
                  <MenuItem onSelect={() => setPending({ action: 'enable', user: u })}>
                    <UserCheck />
                    {t('staff.users.enable')}
                  </MenuItem>
                ) : null}
              </MenuContent>
            </Menu>
          </span>
        );
      },
    },
  ];

  const pendingName = pending ? bi(pending.user, 'fullName') : '';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={t('staff.users.search')} className="w-72" />
        <Segmented
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: t('common.all'), count: counts.all },
            { value: 'active', label: t('staff.users.active'), count: counts.active },
            { value: 'disabled', label: t('staff.users.disabled'), count: counts.disabled },
          ]}
        />
        <Button variant="primary" size="sm" className="ms-auto" onClick={() => setEditing('new')}>
          <UserPlus />
          {t('staff.users.new')}
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        loading={users.isLoading}
        error={users.error}
        onRetry={() => void users.refetch()}
        onRowClick={(u) => setEditing(u)}
        getRowId={(u) => u.id}
        rowClassName={(u) => (u.status === 'disabled' ? 'opacity-60' : undefined)}
        empty={{ title: q ? t('common:empty.noMatches') : t('staff.users.empty') }}
      />

      {editing ? (
        <UserDrawer
          key={editing === 'new' ? 'new' : editing.id}
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(result) => setTemp({ result, mode: 'created' })}
        />
      ) : null}
      {temp ? <TempPasswordDialog result={temp.result} mode={temp.mode} onClose={() => setTemp(null)} /> : null}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        tone={pending?.action === 'disable' ? 'danger' : 'primary'}
        title={pending ? t(`staff.users.confirm.${pending.action}Title`, { name: pendingName }) : ''}
        description={pending ? t(`staff.users.confirm.${pending.action}Body`, { name: pendingName }) : ''}
        confirmLabel={pending ? t(`staff.users.${pending.action}`) : undefined}
        onConfirm={() => (pending ? settle(act.mutateAsync(pending)) : undefined)}
      />
    </div>
  );
}
