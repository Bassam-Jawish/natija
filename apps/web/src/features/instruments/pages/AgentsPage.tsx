import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Copy, KeyRound, MoreHorizontal, Plus, Server, ShieldOff } from 'lucide-react';
import type { AgentCreated, AgentItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  Field,
  InfoList,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageHeader,
  StatusChip,
  toast,
  type ColumnDef,
} from '@/components/ui';
import { ins, keys } from '../api';
import { Callout, Code, HonestyBanner, useInsError } from '../components/common';

/** Lab Agents: the on-site services that talk to the analyzers. */
export default function AgentsPage() {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const qc = useQueryClient();
  const insError = useInsError();
  const list = useQuery({ queryKey: keys.agents, queryFn: ins.agents });
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState<AgentCreated | null>(null);
  const [revoking, setRevoking] = useState<AgentItem | null>(null);
  const [details, setDetails] = useState<AgentItem | null>(null);

  const newCode = useMutation({
    mutationFn: (a: AgentItem) => ins.newCode(a.id),
    onSuccess: (res) => {
      setCode(res);
      void qc.invalidateQueries({ queryKey: ['instruments'] });
    },
    onError: (err) => toast.error(insError(err)),
  });
  const revoke = useMutation({
    mutationFn: (a: AgentItem) => ins.revokeAgent(a.id),
    onSuccess: () => {
      toast.success(t('agents.revoked'));
      void qc.invalidateQueries({ queryKey: ['instruments'] });
    },
    onError: (err) => toast.error(insError(err)),
  });

  const columns = useMemo<ColumnDef<AgentItem>[]>(
    () => [
      {
        id: 'name',
        header: t('agents.col.name'),
        accessorKey: 'name',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2 font-medium text-ink">
            {row.original.isVirtual ? t('agents.virtualName') : row.original.name}
          </span>
        ),
      },
      { id: 'status', header: t('agents.col.status'), cell: ({ row }) => <StatusChip kind="agent" status={row.original.status} /> },
      {
        id: 'heartbeat',
        header: t('agents.col.heartbeat'),
        cell: ({ row }) => {
          const a = row.original;
          if (a.isVirtual) return <span className="text-[12.5px] text-muted">{t('agents.builtIn')}</span>;
          if (a.status === 'revoked') return <span className="text-[12.5px] text-muted">{f.dateTime(a.revokedAt)}</span>;
          if (a.status === 'pending') return <span className="text-[12.5px] text-muted">{a.enrollPending ? t('agents.awaiting', { when: f.dateTime(a.enrollExpiresAt) }) : t('agents.codeExpired')}</span>;
          return (
            <span className="inline-flex items-center gap-2">
              <Badge tone={a.online ? 'ok' : 'muted'} dot>
                {a.online ? t('agents.online') : t('agents.offline')}
              </Badge>
              <span className="text-[12px] text-muted">{a.lastHeartbeatAt ? f.relative(a.lastHeartbeatAt) : '—'}</span>
            </span>
          );
        },
      },
      { id: 'version', header: t('agents.col.version'), cell: ({ row }) => <Code>{row.original.version ?? '—'}</Code> },
      {
        id: 'instruments',
        header: t('agents.col.instruments'),
        cell: ({ row }) =>
          row.original.instruments.length ? (
            <span className="flex flex-wrap gap-1">
              {row.original.instruments.map((i) => (
                <Link key={i.id} to={`/instruments/${i.id}`} onClick={(e) => e.stopPropagation()}>
                  <Badge tone={i.status === 'online' ? 'ok' : 'neutral'}>
                    <Code className="text-[11.5px]">{i.code}</Code>
                  </Badge>
                </Link>
              ))}
            </span>
          ) : (
            <span className="text-[12.5px] text-muted">{t('agents.noInstruments')}</span>
          ),
      },
      {
        id: 'actions',
        header: '',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const a = row.original;
          if (a.isVirtual || a.status === 'revoked') return null;
          return (
            <div onClick={(e) => e.stopPropagation()}>
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.more')}>
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => newCode.mutate(a)}>
                    <KeyRound />
                    {t('agents.newCode')}
                  </MenuItem>
                  <MenuItem danger onSelect={() => setRevoking(a)}>
                    <ShieldOff />
                    {t('agents.revoke')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          );
        },
      },
    ],
    [t, f, newCode],
  );

  return (
    <div>
      <PageHeader
        back="/instruments"
        title={t('agents.title')}
        description={t('agents.description')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            {t('agents.add')}
          </Button>
        }
      />
      <HonestyBanner className="mb-4" />
      <DataTable
        columns={columns}
        data={list.data}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={setDetails}
        empty={{ icon: Server, title: t('agents.empty'), description: t('agents.emptyHint') }}
      />
      <CreateAgentDialog open={creating} onClose={() => setCreating(false)} onCreated={setCode} />
      <EnrollmentCodeDialog value={code} onClose={() => setCode(null)} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        tone="danger"
        title={t('agents.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('agents.revokeHint')}
        confirmLabel={t('agents.revoke')}
        onConfirm={() => (revoking ? revoke.mutateAsync(revoking) : undefined)}
      />
      <AgentDrawer agent={details} onClose={() => setDetails(null)} />
    </div>
  );
}

function CreateAgentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (res: AgentCreated) => void }) {
  const { t } = useTranslation('instruments');
  const qc = useQueryClient();
  const insError = useInsError();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => ins.createAgent(name.trim()),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['instruments'] });
      setName('');
      onClose();
      onCreated(res);
    },
    onError: (err) => toast.error(insError(err)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t('agents.addTitle')}
      description={t('agents.addHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            {t('agents.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field label={t('agents.col.name')} hint={t('agents.nameHint')} required>
          {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('agents.namePlaceholder')} />}
        </Field>
      </form>
    </Dialog>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation('instruments');
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast.error(t('agents.copyFailed'));
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? t('common:actions.copied') : label}
    </Button>
  );
}

/** Shown once: the one-time code and the exact command to run on the lab PC. */
function EnrollmentCodeDialog({ value, onClose }: { value: AgentCreated | null; onClose: () => void }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  if (!value) return null;
  const pretty = `${value.enrollmentCode.slice(0, 4)}-${value.enrollmentCode.slice(4)}`;
  const command = `pnpm agent enroll --server ${window.location.origin} --code ${pretty}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('agents.codeTitle', { name: value.agent.name })}
      description={t('agents.codeHint', { when: f.dateTime(value.expiresAt) })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common:actions.done')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-sunken px-4 py-5">
          <span dir="ltr" className="font-mono text-[34px] font-semibold tracking-[0.2em] text-ink select-all">
            {pretty}
          </span>
          <CopyButton text={pretty} label={t('agents.copyCode')} />
        </div>
        <Field label={t('agents.command')} hint={t('agents.commandHint')}>
          <div className="flex items-start gap-2">
            <pre dir="ltr" className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 text-start font-mono text-[12.5px] text-ink select-all">
              {command}
            </pre>
            <CopyButton text={command} label={t('common:actions.copy')} />
          </div>
        </Field>
        <Callout tone="warn" title={t('agents.onceTitle')}>
          {t('agents.once')}
        </Callout>
        <ol className="list-inside list-decimal text-[13px] text-ink-2">
          <li>{t('agents.step1')}</li>
          <li>{t('agents.step2')}</li>
          <li>{t('agents.step3')}</li>
        </ol>
      </div>
    </Dialog>
  );
}

function AgentDrawer({ agent, onClose }: { agent: AgentItem | null; onClose: () => void }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const info = (agent?.hostInfo ?? {}) as {
    hostname?: string;
    platform?: string;
    node?: string;
    uptimeSec?: number | null;
    queue?: { pending: number; failed: number; incomplete: number } | null;
    links?: Record<string, { state: string; detail: string | null; lastMessageAt: string | null }>;
  };
  return (
    <Drawer open={!!agent} onOpenChange={(o) => !o && onClose()} title={agent?.isVirtual ? t('agents.virtualName') : (agent?.name ?? '')} description={agent?.isVirtual ? t('agents.virtualHint') : undefined}>
      {agent ? (
        <div className="flex flex-col gap-5">
          <InfoList
            items={[
              { label: t('agents.col.status'), value: <StatusChip kind="agent" status={agent.status} /> },
              { label: t('agents.col.version'), value: <Code>{agent.version ?? '—'}</Code> },
              { label: t('agents.col.heartbeat'), value: <span className="tabular">{f.dateTime(agent.lastHeartbeatAt)}</span> },
              { label: t('agents.host'), value: <Code>{info.hostname ?? '—'}</Code> },
              { label: t('agents.platform'), value: <Code>{[info.platform, info.node].filter(Boolean).join(' · ') || '—'}</Code> },
              { label: t('agents.uptime'), value: info.uptimeSec ? f.duration(Math.round(info.uptimeSec / 60)) : '—' },
              {
                label: t('agents.queue'),
                value: info.queue ? t('agents.queueValue', { pending: info.queue.pending, failed: info.queue.failed, incomplete: info.queue.incomplete }) : '—',
                wide: true,
              },
              { label: t('agents.created'), value: <span className="tabular">{f.dateTime(agent.createdAt)}</span> },
              { label: t('agents.revokedAt'), value: <span className="tabular">{f.dateTime(agent.revokedAt)}</span> },
            ]}
          />
          {info.links && Object.keys(info.links).length ? (
            <section>
              <h3 className="mb-2 text-[13.5px] font-semibold text-ink">{t('agents.links')}</h3>
              <ul className="flex flex-col gap-1.5">
                {Object.entries(info.links).map(([code, l]) => (
                  <li key={code} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
                    <Code className="font-semibold">{code}</Code>
                    <Badge tone={l.state === 'connected' ? 'ok' : l.state === 'error' ? 'crit' : 'muted'} dot>
                      {t(`agents.linkStates.${l.state}`, { defaultValue: l.state })}
                    </Badge>
                    {l.detail ? (
                      <span dir="ltr" className="text-[12px] text-muted">
                        {l.detail}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
