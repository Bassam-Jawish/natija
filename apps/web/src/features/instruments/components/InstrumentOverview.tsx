import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { INSTRUMENT_TRANSPORTS, INTEGRATION_LEVELS, type InstrumentDetail, type InstrumentUpdateBody, type IntegrationLevel } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, Dialog, Field, InfoList, Input, Select, StatTile, StatusChip, Switch, Textarea, toast } from '@/components/ui';
import { ins, useFormData } from '../api';
import { Callout, ConfidenceChip, ConnectionLine, LevelChip, useInsError } from './common';

/** Status, connection settings (editable with instruments.manage) and the honest notes from the profile. */
export function InstrumentOverview({ instrument }: { instrument: InstrumentDetail }) {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const [editing, setEditing] = useState(false);
  const i = instrument;
  const p = i.profile;
  return (
    <div className="flex flex-col gap-4">
      {i.model === 'ichroma3' ? (
        <Callout tone="crit" title={t('overview.inventedTitle')}>
          {t('overview.invented')}
        </Callout>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label={t('board.messagesToday')} value={i.counts.messagesToday} />
        <StatTile label={t('board.errorsToday')} value={i.counts.errorsToday} tone={i.counts.errorsToday ? 'crit' : undefined} />
        <StatTile label={t('board.openReview')} value={i.counts.openReview} tone={i.counts.openReview ? 'warn' : undefined} to={i.counts.openReview ? '/integration/review' : undefined} />
      </div>
      <Card
        title={t('overview.connection')}
        actions={
          can('instruments.manage') ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              {t('overview.edit')}
            </Button>
          ) : null
        }
      >
        <InfoList
          columns={3}
          items={[
            { label: t('overview.status'), value: <StatusChip kind="instrument" status={i.status} /> },
            { label: t('overview.lastMessage'), value: i.lastMessageAt ? <span className="tabular">{f.relative(i.lastMessageAt)}</span> : t('board.never') },
            { label: t('overview.lastSeen'), value: i.lastSeenAt ? <span className="tabular">{f.dateTime(i.lastSeenAt)}</span> : '—' },
            { label: t('overview.link'), value: <ConnectionLine instrument={i} profile={p} />, wide: true },
            {
              label: t('overview.agent'),
              value: i.agent ? (
                <span className="inline-flex items-center gap-2">
                  {i.agent.isVirtual ? t('agents.virtualName') : i.agent.name}
                  {i.agent.isVirtual ? <Badge tone="violet">{t('agents.virtual')}</Badge> : <StatusChip kind="agent" status={i.agent.status} />}
                  {!i.agent.isVirtual ? <Badge tone={i.agent.online ? 'ok' : 'muted'} dot>{i.agent.online ? t('agents.online') : t('agents.offline')}</Badge> : null}
                </span>
              ) : (
                <span className="text-muted">{t('board.noAgent')}</span>
              ),
            },
            { label: t('overview.department'), value: i.department ? bi(i.department, 'name') : '—' },
            { label: t('overview.level'), value: <LevelChip level={i.integrationLevel} /> },
            { label: t('overview.confidence'), value: p ? <ConfidenceChip confidence={p.confidence} /> : '—' },
            { label: t('overview.mode'), value: i.isSimulated ? <Badge tone="violet">{t('overview.simulatedInstrument')}</Badge> : <Badge tone="info">{t('overview.realInstrument')}</Badge> },
            ...(p?.specimenIdMax ? [{ label: t('overview.specimenIdMax'), value: <span className="tabular">{t('overview.chars', { count: p.specimenIdMax })}</span> }] : []),
            ...(i.notes ? [{ label: t('overview.notes'), value: <span dir="auto" className="block text-start text-[13px] whitespace-pre-wrap">{i.notes}</span>, wide: true }] : []),
          ]}
        />
      </Card>
      {p ? (
        <Card title={t('overview.research')} description={t('overview.researchHint')}>
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{p.name}</span>
              <span className="text-muted">· {p.manufacturer}</span>
              <ConfidenceChip confidence={p.confidence} />
              {p.bidirectional ? <Badge tone="info">{t('overview.bidirectional')}</Badge> : <Badge tone="muted">{t('overview.resultsOnly')}</Badge>}
            </div>
            <p dir="ltr" className="rounded-lg bg-sunken px-3 py-2 text-start text-ink-2">
              {p.note}
            </p>
            <p className="text-[12.5px] text-muted">{t('overview.levelPolicy')}</p>
          </div>
        </Card>
      ) : null}
      <EditInstrumentDialog open={editing} onClose={() => setEditing(false)} instrument={i} />
    </div>
  );
}

function EditInstrumentDialog({ open, onClose, instrument }: { open: boolean; onClose: () => void; instrument: InstrumentDetail }) {
  const { t } = useTranslation('instruments');
  const bi = useBi();
  const qc = useQueryClient();
  const insError = useInsError();
  const form = useFormData();
  const [v, setV] = useState<InstrumentUpdateBody>({});
  useEffect(() => {
    if (!open) return;
    const i = instrument;
    setV({
      name: i.name,
      transport: i.transport,
      host: i.host,
      port: i.port,
      serialPort: i.serialPort,
      baudRate: i.baudRate,
      agentId: i.agent?.id ?? null,
      departmentId: i.department?.id ?? null,
      integrationLevel: i.integrationLevel,
      isSimulated: i.isSimulated,
      isActive: i.isActive,
      notes: i.notes,
    });
  }, [open, instrument]);
  const set = <K extends keyof InstrumentUpdateBody>(k: K, value: InstrumentUpdateBody[K]) => setV((s) => ({ ...s, [k]: value }));
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = useMutation({
    mutationFn: () => ins.update(instrument.id, v),
    onSuccess: () => {
      toast.success(t('overview.saved'));
      void qc.invalidateQueries({ queryKey: ['instruments'] });
      onClose();
    },
    onError: (err) => toast.error(insError(err)),
  });
  const NONE = '__none__';
  const levelUp = v.integrationLevel && v.integrationLevel !== 'L0' && v.integrationLevel !== instrument.integrationLevel;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t('overview.editTitle', { code: instrument.code })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!v.name?.trim()} onClick={() => save.mutate()}>
            {t('common:actions.saveChanges')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('overview.name')} required>
          {(id) => <Input id={id} value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} />}
        </Field>
        <Field label={t('overview.department')}>
          {(id) => (
            <Select
              id={id}
              value={v.departmentId ?? NONE}
              onValueChange={(x) => set('departmentId', x === NONE ? null : x)}
              options={[{ value: NONE, label: '—' }, ...(form.data?.departments ?? []).map((d) => ({ value: d.id, label: bi(d, 'name') }))]}
            />
          )}
        </Field>
        <Field label={t('overview.transport')} hint={t(`transport.hint.${v.transport ?? instrument.transport}`)}>
          {(id) => (
            <Select
              id={id}
              value={v.transport ?? instrument.transport}
              onValueChange={(x) => set('transport', x as InstrumentUpdateBody['transport'])}
              options={INSTRUMENT_TRANSPORTS.map((tr) => ({ value: tr, label: t(`transport.${tr}`) }))}
            />
          )}
        </Field>
        <Field label={t('overview.agent')}>
          {(id) => (
            <Select
              id={id}
              value={v.agentId ?? NONE}
              onValueChange={(x) => set('agentId', x === NONE ? null : x)}
              options={[{ value: NONE, label: t('board.noAgent') }, ...(form.data?.agents ?? []).map((a) => ({ value: a.id, label: a.isVirtual ? t('agents.virtualName') : a.name }))]}
            />
          )}
        </Field>
        {v.transport === 'serial' ? (
          <>
            <Field label={t('overview.serialPort')}>
              {(id) => <Input id={id} ltr value={v.serialPort ?? ''} onChange={(e) => set('serialPort', e.target.value || null)} placeholder="COM3" />}
            </Field>
            <Field label={t('overview.baudRate')}>
              {(id) => <Input id={id} ltr inputMode="numeric" value={v.baudRate ?? ''} onChange={(e) => set('baudRate', num(e.target.value))} />}
            </Field>
          </>
        ) : (
          <>
            <Field label={t('overview.host')} hint={v.transport === 'tcp_client' ? t('overview.hostHintClient') : t('overview.hostHintServer')}>
              {(id) => <Input id={id} ltr value={v.host ?? ''} onChange={(e) => set('host', e.target.value || null)} placeholder="192.168.10.20" />}
            </Field>
            <Field label={t('overview.port')}>
              {(id) => <Input id={id} ltr inputMode="numeric" value={v.port ?? ''} onChange={(e) => set('port', num(e.target.value))} />}
            </Field>
          </>
        )}
        <Field label={t('overview.level')}>
          {(id) => (
            <Select
              id={id}
              value={v.integrationLevel ?? 'L0'}
              onValueChange={(x) => set('integrationLevel', x as IntegrationLevel)}
              options={INTEGRATION_LEVELS.map((l) => ({ value: l, label: t(`common:status.level.${l}`) }))}
            />
          )}
        </Field>
        <div className="flex flex-col justify-end gap-3 pb-1">
          <Switch checked={!!v.isSimulated} onCheckedChange={(x) => set('isSimulated', x)} label={t('overview.isSimulated')} />
          <Switch checked={v.isActive ?? true} onCheckedChange={(x) => set('isActive', x)} label={t('overview.isActive')} />
        </div>
        {levelUp ? (
          <Callout tone="warn" className="sm:col-span-2" title={t('overview.levelWarnTitle')}>
            {t(`overview.levelWarn.${v.integrationLevel}`)}
          </Callout>
        ) : null}
        <Field label={t('overview.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={3} value={v.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} />}
        </Field>
      </div>
    </Dialog>
  );
}
