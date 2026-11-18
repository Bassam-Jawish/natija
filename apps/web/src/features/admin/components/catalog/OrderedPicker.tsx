import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Button, Combobox, EmptyState, type Option } from '@/components/ui';
import { Code } from '../common';

export type PickerItem = { id: string; code: string; label: string; hint?: string | null; extra?: ReactNode };

/**
 * Ordered list of catalog items (analytes in a test, tests in a package): add with a searchable
 * box, reorder with the arrows, remove with ×. `ordered` false hides the arrows.
 */
export function OrderedPicker({
  value,
  onChange,
  items,
  placeholder,
  emptyText,
  ordered = true,
  disabled,
  invalid,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  items: PickerItem[];
  placeholder: string;
  emptyText: string;
  ordered?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { t } = useTranslation('admin');
  const byId = new Map(items.map((i) => [i.id, i]));
  const chosen = new Set(value);
  const options: Option[] = items.filter((i) => !chosen.has(i.id)).map((i) => ({ value: i.id, label: `${i.code} · ${i.label}`, hint: i.hint ?? undefined }));
  const move = (index: number, delta: number) => {
    const next = [...value];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {!disabled ? <Combobox value={null} onChange={(v) => v && onChange([...value, v])} options={options} placeholder={placeholder} invalid={invalid} /> : null}
      {value.length === 0 ? (
        <EmptyState className="rounded-lg border border-dashed border-line py-6" title={emptyText} />
      ) : (
        <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {value.map((id, index) => {
            const item = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-2 bg-surface px-2.5 py-1.5 text-[13px]">
                <span className="w-6 shrink-0 text-center text-[11.5px] text-faint tabular ltr-num">{index + 1}</span>
                <Code className="w-20 shrink-0 truncate">{item?.code ?? '?'}</Code>
                <span className="min-w-0 flex-1 truncate text-ink">{item?.label ?? id}</span>
                {item?.extra}
                {!disabled ? (
                  <span className="flex shrink-0 items-center">
                    {ordered ? (
                      <>
                        <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t('catalog.actions.moveUp')}>
                          <ArrowUp />
                        </Button>
                        <Button variant="ghost" size="icon-sm" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={t('catalog.actions.moveDown')}>
                          <ArrowDown />
                        </Button>
                      </>
                    ) : null}
                    <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((x) => x !== id))} aria-label={t('catalog.actions.remove')}>
                      <X />
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
