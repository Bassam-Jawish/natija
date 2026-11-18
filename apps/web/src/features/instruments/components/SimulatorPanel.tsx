import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { faultsFor, type InstrumentDetail, type InstrumentMappingItem, type SimulateResponse, type SimulationFault, type SimulationMode } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Segmented, Select, StatusChip, Switch, toast } from '@/components/ui';
import { ins } from '../api';
import { Callout, Code, RawMessage, useInsError } from './common';
import { OutcomeTable } from './OutcomeTable';
import { ParsedRecords } from './ParsedRecords';
import { WireTrace } from './WireTrace';

/**
 * Scenario: run simulated traffic for this analyzer through the real link layer and watch each
 * stage: what the analyzer sent, the frames on the wire, the parsed records, the code mapping
 * and what happened to every value.
 */
export function SimulatorPanel({ instrument, mappings, onOpenMessage }: { instrument: InstrumentDetail; mappings: InstrumentMappingItem[] | undefined; onOpenMessage?: (id: string) => void }) {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const qc = useQueryClient();
  const insError = useInsError();
  const [mode, setMode] = useState<SimulationMode>('normal');
  const [fault, setFault] = useState<SimulationFault>('none');
  const [barcodes, setBarcodes] = useState('');
  const [qcRun, setQcRun] = useState(false);
  const [result, setResult] = useState<SimulateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = can('instruments.manage', 'results.enter');
  const faults = faultsFor(instrument.protocol);

  const run = useMutation({
    mutationFn: () => {
      const list = barcodes
        .split(/[\s,;]+/)
        .map((b) => b.trim())
        .filter(Boolean)
        .slice(0, 5);
      return ins.simulate(instrument.id, { mode, fault, qc: qcRun || undefined, barcodes: list.length ? list : undefined });
    },
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['instruments'] });
      void qc.invalidateQueries({ queryKey: ['integration'] });
      void qc.invalidateQueries({ queryKey: ['qc'] });
    },
    onError: (err) => {
      const message = insError(err);
      setError(message);
      toast.error(message);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('sim.title')} description={t('sim.description')}>
        <div className="grid gap-4 lg:grid-cols-[auto_1fr_1fr_auto] lg:items-end">
          <Field label={t('sim.mode')}>
            <Segmented<SimulationMode>
              value={mode}
              onChange={setMode}
              options={(['normal', 'abnormal', 'critical'] as const).map((m) => ({ value: m, label: t(`modes.${m}`) }))}
            />
          </Field>
          <Field label={t('sim.barcodes')} hint={qcRun ? t('sim.qcHint') : t('sim.barcodesHint')}>
            {(id) => <Input id={id} ltr value={barcodes} onChange={(e) => setBarcodes(e.target.value)} placeholder="261117-0042-01" disabled={qcRun || fault === 'unknown_sample'} />}
          </Field>
          <Field label={t('sim.fault')} hint={t(`faults.hint.${fault}`)}>
            {(id) => (
              <Select id={id} value={fault} onValueChange={(v) => setFault(v as SimulationFault)} options={faults.map((f) => ({ value: f, label: t(`faults.${f}`) }))} />
            )}
          </Field>
          <div className="flex flex-col gap-3">
            <Switch checked={qcRun} onCheckedChange={setQcRun} label={t('sim.qc')} />
            <Button variant="primary" onClick={() => run.mutate()} loading={run.isPending} disabled={!allowed}>
              <Play />
              {result ? t('sim.runAgain') : t('sim.run')}
            </Button>
          </div>
        </div>
        {!allowed ? <p className="mt-3 text-[12.5px] text-muted">{t('sim.noPermission')}</p> : null}
        {instrument.model === 'ichroma3' ? (
          <Callout tone="crit" className="mt-4" title={t('overview.inventedTitle')}>
            {t('overview.invented')}
          </Callout>
        ) : null}
      </Card>

      {error && !result ? (
        <Callout tone="warn" title={t('sim.failed')}>
          {error}
        </Callout>
      ) : null}
      {result ? <SimulationResult result={result} mappings={mappings} onOpenMessage={onOpenMessage} onReset={() => setResult(null)} /> : null}
    </div>
  );
}

function Step({ n, title, description, children, aside }: { n: number; title: ReactNode; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-semibold text-accent-ink">{n}</span>
          <div className="min-w-0">
            <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
            {description ? <p className="text-[12.5px] text-muted">{description}</p> : null}
          </div>
        </div>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function SimulationResult({
  result,
  mappings,
  onOpenMessage,
  onReset,
}: {
  result: SimulateResponse;
  mappings: InstrumentMappingItem[] | undefined;
  onOpenMessage?: (id: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('instruments');
  const [shown, setShown] = useState(0);
  const s = result.outcome.summary;
  const labels = useMemo(() => {
    const out: Record<number, string> = {};
    result.raw.forEach((_, i) => {
      const base = t('wire.transmission', { n: i + 1 });
      if (result.fault === 'duplicate' && i === 1) out[i] = `${base} · ${t('wire.repeat')}`;
      else if (result.fault === 'bad_checksum' && i === 0) out[i] = `${base} · ${t('wire.withFault')}`;
      else out[i] = base;
    });
    return out;
  }, [result, t]);
  const parsed = result.parsed[shown] ?? null;
  // Explained from the structured outcome (the server's notes are technical English).
  const notes: string[] = [];
  const naks = result.frames.filter((f) => f.side === 'host' && f.text === '<NAK>').length;
  if (s.refused && result.instrument.protocol === 'astm') notes.push(t('notes.checksumAstm', { count: naks }));
  if (result.fault === 'bad_checksum' && result.instrument.protocol === 'hl7') notes.push(t('notes.checksumHl7'));
  if (s.duplicates) notes.push(t('notes.duplicate'));
  if (s.applied) notes.push(t('notes.applied', { count: s.applied }));
  if (s.review) notes.push(t('notes.review', { count: s.review }));
  if (result.instrument.model === 'ichroma3') notes.push(t('notes.ichroma'));
  if (result.instrument.model === 'medica_easystat') notes.push(t('notes.medica'));
  notes.push(t('notes.simulated'));
  const tiles: Array<{ key: keyof typeof s; tone?: string }> = [
    { key: 'sent' },
    { key: 'delivered' },
    { key: 'applied', tone: 'text-ok' },
    { key: 'review', tone: s.review ? 'text-warn' : undefined },
    { key: 'duplicates', tone: s.duplicates ? 'text-muted' : undefined },
    { key: 'refused', tone: s.refused ? 'text-crit' : undefined },
  ];
  const choose = result.raw.length > 1 ? (
    <div className="flex flex-wrap gap-1">
      {result.raw.map((_, i) => (
        <Button key={i} size="sm" variant={i === shown ? 'subtle' : 'ghost'} onClick={() => setShown(i)}>
          {t('wire.transmission', { n: i + 1 })}
        </Button>
      ))}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-3 gap-2 sm:grid-cols-6">
          {tiles.map((tile) => (
            <div key={tile.key} className="rounded-lg border border-line bg-surface px-3 py-2">
              <div className="text-[11.5px] text-muted">{t(`sim.summary.${tile.key}`)}</div>
              <div className={cn('text-[20px] font-semibold tabular', tile.tone ?? 'text-ink')}>{s[tile.key]}</div>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw />
          {t('sim.clear')}
        </Button>
      </div>
      <Callout tone={s.refused || s.review ? 'warn' : 'info'} title={t('sim.whatHappened')}>
        <ul className="list-inside list-disc">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </Callout>

      <Step n={1} title={t('steps.sent')} description={t('steps.sentHint')} aside={<Badge tone="muted">{t('sim.seed', { seed: result.seed })}</Badge>}>
        <div className="flex flex-wrap gap-2">
          {result.specimens.map((sp) => (
            <span key={sp.sampleId} className="inline-flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
              <Code className="font-semibold">{sp.sampleId}</Code>
              {sp.isQc ? <Badge tone="violet">{t('sim.qcBadge')}</Badge> : null}
              <span className="text-[12px] text-muted">{t('sim.tests', { count: sp.tests.length })}</span>
              <Code className="text-[11px] text-muted">{sp.tests.join(' ')}</Code>
            </span>
          ))}
        </div>
      </Step>

      <Step n={2} title={t('steps.wire')} description={t(`steps.wireHint.${result.instrument.protocol}`)}>
        <WireTrace frames={result.frames} labels={labels} />
      </Step>

      <Step n={3} title={t('steps.parsed')} description={t('steps.parsedHint')} aside={choose}>
        {parsed ? <ParsedRecords message={parsed} /> : <Callout tone="crit">{t('steps.unreadable')}</Callout>}
        <details className="mt-3">
          <summary className="cursor-pointer text-[12.5px] font-medium text-accent">{t('steps.raw')}</summary>
          <RawMessage raw={result.raw[shown] ?? ''} className="mt-2" />
        </details>
      </Step>

      <Step n={4} title={t('steps.outcome')} description={t('steps.outcomeHint')}>
        <div className="flex flex-col gap-4">
          {result.outcome.messages.map((m, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-semibold text-ink">{labels[i]}</span>
                {m ? <StatusChip kind="message" status={m.status} /> : <Badge tone="crit">{t('sim.refusedChip')}</Badge>}
                {m?.messageType ? <Code className="text-muted">{m.messageType}</Code> : null}
                {m?.messageId && onOpenMessage ? (
                  <Button variant="link" size="sm" onClick={() => onOpenMessage(m.messageId!)}>
                    {t('sim.openMessage')}
                  </Button>
                ) : null}
              </div>
              {!m ? (
                <Callout tone="crit" icon={<TriangleAlert />}>
                  {t('sim.refusedBody')}
                </Callout>
              ) : m.status === 'duplicate' ? (
                <Callout tone="info">{t('sim.duplicateBody')}</Callout>
              ) : m.status === 'error' ? (
                <Callout tone="crit" title={t('sim.errorTitle')}>
                  <span dir="ltr" className="font-mono text-[12px]">
                    {m.error}
                  </span>
                </Callout>
              ) : (
                <OutcomeTable items={m.items} mappings={mappings} />
              )}
            </div>
          ))}
        </div>
      </Step>
    </div>
  );
}
