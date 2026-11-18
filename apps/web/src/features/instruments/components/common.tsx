import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical, TriangleAlert } from 'lucide-react';
import { INTEGRATION_LEVEL_LABELS, type InstrumentListItem, type InstrumentProfileSummary, type IntegrationLevel } from '@natija/contracts';
import { ApiError } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, StatusChip, Tooltip, type Tone } from '@/components/ui';

/** API errors in the user's language: this feature's codes first, then the shared ones. */
export function useInsError() {
  const { t } = useTranslation('instruments');
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      return t(`errors.${error.code}`, { defaultValue: t(`common:errors.${error.code}`, { defaultValue: error.message || t('common:errors.generic') }) });
    }
    if (error instanceof TypeError) return t('common:errors.network');
    return t('common:errors.generic');
  };
}

/** Codes, barcodes, ports and units: monospace, always left-to-right. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12.5px] ltr-num', className)}>{children}</span>;
}

export function LevelChip({ level }: { level: IntegrationLevel }) {
  const lang = useLang();
  const info = INTEGRATION_LEVEL_LABELS[level];
  return (
    <Tooltip content={lang === 'ar' ? info.hintAr : info.hintEn}>
      <span className="inline-flex">
        <StatusChip kind="level" status={level} />
      </span>
    </Tooltip>
  );
}

const CONFIDENCE_TONE: Record<string, Tone> = { V: 'ok', L: 'info', U: 'crit' };

/** How sure the protocol research is: verified from the vendor manual, likely, or unknown. */
export function ConfidenceChip({ confidence }: { confidence: 'V' | 'L' | 'U' }) {
  const { t } = useTranslation('instruments');
  return (
    <Tooltip content={t(`confidence.hint.${confidence}`)}>
      <span className="inline-flex">
        <Badge tone={CONFIDENCE_TONE[confidence]}>{t(`confidence.${confidence}`)}</Badge>
      </span>
    </Tooltip>
  );
}

const HL7_VERSION: Record<string, string> = { cobas_pure: '2.5', mindray_bs430: '2.3.1' };

type ConnectionFields = Pick<InstrumentListItem, 'model' | 'protocol' | 'transport' | 'host' | 'port' | 'serialPort' | 'baudRate'>;

/**
 * "HL7 v2.5 · TCP client :54000", "ASTM E1381/E1394 · RS-232 9600 8N1". The words follow the
 * page direction; ports, addresses and serial settings stay left-to-right in monospace.
 */
export function ConnectionLine({ instrument: i, profile, className }: { instrument: ConnectionFields; profile?: InstrumentProfileSummary | null; className?: string }) {
  const { t } = useTranslation('instruments');
  const protocol = i.protocol === 'hl7' ? t('protocol.hl7', { version: HL7_VERSION[i.model] ?? '2.x' }) : t(`protocol.${i.protocol}`);
  let endpoint: string;
  if (i.transport === 'serial') {
    const s = profile?.serial;
    const frame = s ? `${s.dataBits}${s.parity[0]!.toUpperCase()}${s.stopBits}` : '';
    endpoint = [i.baudRate ?? s?.baudRate, frame, i.serialPort ? `(${i.serialPort})` : ''].filter(Boolean).join(' ');
  } else {
    endpoint = i.transport === 'tcp_client' && i.host ? `${i.host}:${i.port ?? '?'}` : `:${i.port ?? '?'}`;
  }
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12.5px]', className)}>
      <bdi className="font-medium text-ink-2">{protocol}</bdi>
      <span className="text-faint">·</span>
      <bdi className="text-ink-2">{t(`transport.${i.transport}`)}</bdi>
      <Code className="text-muted">{endpoint}</Code>
    </span>
  );
}

/** The honest statement shown wherever analyzers are presented. */
export function HonestyBanner({ className }: { className?: string }) {
  const { t } = useTranslation('instruments');
  return (
    <div className={cn('flex items-start gap-3 rounded-[var(--radius-card)] border border-info/30 bg-info-soft px-4 py-3 text-[13px] text-ink', className)}>
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-info" />
      <p>
        <span className="font-semibold text-info">{t('honesty.title')}</span> {t('honesty.body')}
      </p>
    </div>
  );
}

export function Callout({ tone = 'warn', icon, title, children, className }: { tone?: 'warn' | 'crit' | 'info'; icon?: ReactNode; title?: ReactNode; children: ReactNode; className?: string }) {
  const box = { warn: 'border-warn/30 bg-warn-soft', crit: 'border-crit/30 bg-crit-soft', info: 'border-info/30 bg-info-soft' }[tone];
  const ink = { warn: 'text-warn', crit: 'text-crit', info: 'text-info' }[tone];
  return (
    <div className={cn('flex items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3 text-[13px] text-ink', box, className)}>
      <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', ink)}>{icon ?? <TriangleAlert />}</span>
      <div className="min-w-0">
        {title ? <p className={cn('font-semibold', ink)}>{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

const CONTROL = /(<(?:STX|ETX|ETB|EOT|ENQ|ACK|NAK|CR|LF|VT|FS|FF|TAB|NUL|0x[0-9a-f]{2})>)/;
const CONTROL_TONE: Record<string, string> = {
  ACK: 'bg-ok-soft text-ok',
  NAK: 'bg-crit-soft text-crit',
  EOT: 'bg-violet-soft text-violet',
  ENQ: 'bg-violet-soft text-violet',
};

/**
 * Wire text with control characters made visible: "<STX>1H|…<CR><ETX>3F<CR><LF>" becomes
 * ⟨STX⟩1H|…⟨CR⟩⟨ETX⟩3F⟨CR⟩⟨LF⟩ with each control character as a small chip.
 */
export function WireText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(CONTROL);
  return (
    <span dir="ltr" className={cn('font-mono text-[12px] leading-6 break-all whitespace-pre-wrap', className)}>
      {parts.map((p, i) => {
        const m = /^<(.+)>$/.exec(p);
        if (m && CONTROL.test(p)) {
          const name = m[1]!;
          return (
            <span key={i} className={cn('mx-px inline-block rounded px-1 text-[10.5px] leading-4 font-semibold', CONTROL_TONE[name] ?? 'bg-sunken text-muted')}>
              ⟨{name}⟩
            </span>
          );
        }
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </span>
  );
}

/** Raw message text (CR-separated records) as wire text, one record per line. */
export function RawMessage({ raw, className }: { raw: string; className?: string }) {
  const printable = raw
    .replace(/\x0b/g, '<VT>')
    .replace(/\x1c/g, '<FS>')
    .replace(/\r\n|\r|\n/g, (m) => (m === '\r\n' ? '<CR><LF>\n' : m === '\r' ? '<CR>\n' : '<LF>\n'));
  return (
    <pre dir="ltr" className={cn('max-h-80 overflow-auto rounded-lg border border-line bg-sunken p-3 text-start', className)}>
      <WireText text={printable} />
    </pre>
  );
}
