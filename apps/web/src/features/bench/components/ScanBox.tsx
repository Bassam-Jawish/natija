import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ScanBarcode } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Kbd } from '@/components/ui';

export type ScanBoxHandle = { focus: () => void; flash: (tone: 'ok' | 'warn' | 'crit') => void };

/**
 * Scan field for keyboard-wedge barcode scanners (fast keys + Enter). Several codes pasted at
 * once (spaces, commas or new lines) are sent together. Focus stays here between scans.
 */
export const ScanBox = forwardRef<ScanBoxHandle, { onScan: (codes: string[]) => void | Promise<void>; busy?: boolean; label: string; hint?: string; size?: 'lg' | 'md' }>(
  function ScanBox({ onScan, busy, label, hint, size = 'lg' }, ref) {
    const { t } = useTranslation('bench');
    const input = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState('');
    const [tone, setTone] = useState<'ok' | 'warn' | 'crit' | null>(null);
    useImperativeHandle(ref, () => ({
      focus: () => input.current?.focus(),
      flash: (next) => {
        setTone(next);
        window.setTimeout(() => setTone(null), 900);
      },
    }));
    const submit = async () => {
      const codes = value
        .split(/[\s,;]+/)
        .map((c) => c.trim())
        .filter(Boolean);
      if (!codes.length) return;
      setValue('');
      await onScan(codes);
      input.current?.focus();
    };
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          'flex items-center gap-3 rounded-[var(--radius-card)] border-2 bg-surface px-4 transition-colors',
          size === 'lg' ? 'py-3' : 'py-2',
          tone === 'ok' ? 'border-ok' : tone === 'warn' ? 'border-warn' : tone === 'crit' ? 'border-crit' : 'border-line-strong focus-within:border-accent',
        )}
      >
        <ScanBarcode className={cn('shrink-0 text-muted', size === 'lg' ? 'size-7' : 'size-5')} />
        <div className="min-w-0 flex-1">
          <label htmlFor="bench-scan" className="block text-[12px] font-medium text-muted">
            {label}
          </label>
          <input
            id="bench-scan"
            ref={input}
            dir="auto"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('scan.placeholder')}
            className={cn('w-full bg-transparent font-mono text-ink outline-none placeholder:font-sans placeholder:text-faint', size === 'lg' ? 'text-[22px] leading-9 placeholder:text-[17px]' : 'text-[16px] leading-7 placeholder:text-[14px]')}
          />
        </div>
        {busy ? <Loader2 className="size-5 animate-spin text-muted" /> : null}
        <span className="hidden shrink-0 items-center gap-1 text-[12px] text-muted sm:inline-flex">
          {hint ?? t('scan.hint')} <Kbd>Enter</Kbd>
        </span>
      </form>
    );
  },
);
