import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FlaskConical, ShieldCheck, Send, Syringe, TestTubes, Microscope, FileCheck2, type LucideIcon } from 'lucide-react';
import type { AnalyticsDashboard } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui';

type Stage = { key: keyof AnalyticsDashboard['wip']; icon: LucideIcon; to: string; perms: string[] };

const STAGES: Stage[] = [
  { key: 'toCollect', icon: Syringe, to: '/collection', perms: ['samples.collect'] },
  { key: 'toReceive', icon: TestTubes, to: '/samples', perms: ['samples.receive'] },
  { key: 'inAnalysis', icon: FlaskConical, to: '/worklists', perms: ['results.enter'] },
  { key: 'toVerify', icon: Microscope, to: '/worklists', perms: ['results.verify', 'results.enter'] },
  { key: 'toValidate', icon: ShieldCheck, to: '/validation', perms: ['results.validate'] },
  { key: 'toRelease', icon: FileCheck2, to: '/validation', perms: ['results.validate'] },
  { key: 'toDeliver', icon: Send, to: '/delivery', perms: ['reports.deliver'] },
];

/** Work in progress right now, stage by stage, each linking to the page that clears it. */
export function Pipeline({ wip }: { wip: AnalyticsDashboard['wip'] }) {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const f = useFormat();
  const busiest = Math.max(...STAGES.filter((s) => s.key !== 'toDeliver').map((s) => wip[s.key]));
  return (
    <Card title={t('dashboard.pipeline.title')} description={t('dashboard.pipeline.description')} padded={false}>
      <ol className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
        {STAGES.map((s, i) => {
          const value = wip[s.key];
          const Icon = s.icon;
          const allowed = can(...s.perms);
          const body = (
            <div
              className={cn(
                'relative flex h-full flex-col gap-1.5 px-4 py-3.5 transition-colors',
                allowed && 'hover:bg-sunken/60',
              )}
            >
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(`dashboard.pipeline.${s.key}`)}</span>
              </div>
              <div className={cn('text-[24px] leading-tight font-semibold tracking-tight', value ? 'text-ink' : 'text-faint')}>{f.number(value)}</div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
                {t(`dashboard.pipeline.${s.key}Unit`)}
                {value > 0 && value === busiest && s.key !== 'toDeliver' ? (
                  <span className="rounded-full bg-warn-soft px-1.5 text-[10.5px] font-medium text-warn">{t('dashboard.pipeline.busiest')}</span>
                ) : null}
              </div>
              {i < STAGES.length - 1 ? (
                <ChevronRight className="absolute top-1/2 -end-2 z-10 hidden size-4 -translate-y-1/2 rounded-full bg-surface text-faint xl:block rtl:rotate-180" aria-hidden />
              ) : null}
            </div>
          );
          return (
            <li
              key={s.key}
              className="min-w-0 border-t border-line [&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(-n+4)]:border-t-0 xl:border-t-0 xl:not-first:border-s"
            >
              {allowed ? (
                <Link to={s.to} className="block h-full">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
