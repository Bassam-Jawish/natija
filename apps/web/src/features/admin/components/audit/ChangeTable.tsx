import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Before/after of an audit entry as a field table. Changed fields are marked; entries that only
 * have "after" (created) or only "before" (deleted) show one column.
 */
export function ChangeTable({ before, after }: { before: unknown; after: unknown }) {
  const { t } = useTranslation('admin');
  if (before === null && after === null) return <p className="text-[13px] text-muted">{t('audit.noDetails')}</p>;
  if (!isObject(before) && !isObject(after)) {
    return (
      <div className="grid gap-2 text-[12.5px] sm:grid-cols-2">
        <Raw label={t('audit.before')} value={before} />
        <Raw label={t('audit.after')} value={after} />
      </div>
    );
  }
  const b = isObject(before) ? before : {};
  const a = isObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const both = isObject(before) && isObject(after);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full table-fixed text-[12.5px]">
        <thead className="bg-sunken text-[11.5px] text-muted">
          <tr>
            <th className="w-[28%] px-3 py-1.5 text-start font-medium">{t('audit.field')}</th>
            {isObject(before) ? <th className="px-3 py-1.5 text-start font-medium">{t('audit.before')}</th> : null}
            {isObject(after) ? <th className="px-3 py-1.5 text-start font-medium">{t('audit.after')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const changed = both && JSON.stringify(b[k]) !== JSON.stringify(a[k]);
            return (
              <tr key={k} className={cn('border-t border-line align-top', changed && 'bg-warn-soft/40')}>
                <td className="px-3 py-1.5 font-mono text-[11.5px] break-all text-ink-2 ltr-num">{k}</td>
                {isObject(before) ? <td className={cn('px-3 py-1.5 break-words', changed ? 'text-crit line-through decoration-crit/40' : 'text-muted')}>{show(b[k])}</td> : null}
                {isObject(after) ? <td className={cn('px-3 py-1.5 break-words', changed ? 'font-medium text-ink' : 'text-ink-2')}>{show(a[k])}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Raw({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-muted">{label}</div>
      <pre className="overflow-x-auto rounded-md bg-sunken p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-2" dir="ltr">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
