import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Cpu, MessageSquare, TriangleAlert } from 'lucide-react';
import type { InstrumentListItem, InstrumentProfileSummary } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, StatusChip } from '@/components/ui';
import { Code, ConfidenceChip, ConnectionLine, LevelChip } from './common';

/** One analyzer on the status board. */
export function InstrumentCard({ instrument: i, profile }: { instrument: InstrumentListItem; profile?: InstrumentProfileSummary }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const bi = useBi();
  const counts = [
    { icon: MessageSquare, label: t('board.messagesToday'), value: i.counts.messagesToday, tone: '' },
    { icon: AlertCircle, label: t('board.errorsToday'), value: i.counts.errorsToday, tone: i.counts.errorsToday ? 'text-crit' : '' },
    { icon: TriangleAlert, label: t('board.openReview'), value: i.counts.openReview, tone: i.counts.openReview ? 'text-warn' : '' },
  ];
  return (
    <Link
      to={`/instruments/${i.id}`}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 transition-colors hover:border-line-strong',
        !i.isActive && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
            <Cpu className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-ink">{i.name}</h3>
            <p className="truncate text-[12.5px] text-muted">
              <Code className="text-[12px]">{i.code}</Code>
              {i.department ? ` · ${bi(i.department, 'name')}` : ''}
              {profile ? ` · ${profile.manufacturer}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusChip kind="instrument" status={i.status} />
          <span className="text-[11.5px] text-muted">{i.lastMessageAt ? t('board.lastMessage', { when: f.relative(i.lastMessageAt) }) : t('board.never')}</span>
        </div>
      </div>
      <div className="rounded-md bg-sunken px-2.5 py-1.5">
        <ConnectionLine instrument={i} profile={profile} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <LevelChip level={i.integrationLevel} />
        {profile ? <ConfidenceChip confidence={profile.confidence} /> : null}
        {i.model === 'ichroma3' ? <Badge tone="crit">{t('board.invented')}</Badge> : null}
        {i.agent ? (
          <Badge tone={i.agent.isVirtual ? 'violet' : i.agent.online ? 'ok' : 'muted'}>{i.agent.isVirtual ? t('agents.virtual') : i.agent.name}</Badge>
        ) : (
          <Badge tone="muted">{t('board.noAgent')}</Badge>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-line pt-3">
        {counts.map((c) => (
          <div key={c.label} className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1 truncate text-[11.5px] text-muted">
              <c.icon className="size-3.5 shrink-0" />
              {c.label}
            </span>
            <span className={cn('text-[18px] font-semibold tabular', c.tone || 'text-ink')}>{c.value}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}
