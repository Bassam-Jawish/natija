import { useTranslation } from 'react-i18next';
import type { NormalizedMessageView } from '@natija/contracts';
import { InfoList } from '@/components/ui';
import { Code } from './common';

/** Every record / segment of a parsed message with its non-empty fields (ASTM R.4, HL7 OBX-5 …). */
export function ParsedRecords({ message }: { message: NormalizedMessageView }) {
  const { t } = useTranslation('instruments');
  return (
    <div className="flex flex-col gap-3">
      <InfoList
        columns={4}
        items={[
          { label: t('parsed.type'), value: <Code>{message.messageType}</Code> },
          { label: t('parsed.kind'), value: t(`parsed.kinds.${message.kind}`) },
          { label: t('parsed.controlId'), value: message.controlId ? <Code>{message.controlId}</Code> : '—' },
          { label: t('parsed.sender'), value: message.sender ? <Code>{message.sender}</Code> : '—' },
        ]}
      />
      {message.warnings.length ? (
        <ul dir="ltr" className="list-inside list-disc rounded-md bg-warn-soft px-3 py-2 text-start text-[12px] text-warn">
          {message.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div dir="ltr" className="overflow-auto rounded-lg border border-line text-start">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-sunken text-[11px] font-semibold tracking-wide text-muted uppercase">
            <tr>
              <th className="w-16 border-b border-line px-2 py-1.5 text-start">{t('parsed.record')}</th>
              <th className="border-b border-line px-2 py-1.5 text-start">{t('parsed.fields')}</th>
            </tr>
          </thead>
          <tbody>
            {message.records.map((r, i) => (
              <tr key={i} className="border-b border-line align-top last:border-0">
                <td className="px-2 py-1.5 font-mono font-semibold text-accent">{r.type}</td>
                <td className="px-2 py-1">
                  <div className="flex flex-wrap gap-1">
                    {r.fields.map((f) => (
                      <span key={f.ref} className="inline-flex max-w-full items-baseline gap-1 rounded bg-sunken px-1.5 py-0.5 font-mono" title={f.value}>
                        <span className="text-[10.5px] text-muted">{f.ref}</span>
                        <span className="truncate text-ink">{f.value.length > 60 ? `${f.value.slice(0, 60)}…` : f.value}</span>
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
