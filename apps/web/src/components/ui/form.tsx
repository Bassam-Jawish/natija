import { forwardRef, useId, useMemo, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Checkbox as RCheckbox, Popover as RPopover, RadioGroup as RRadio, Select as RSelect, Switch as RSwitch } from 'radix-ui';
import { Command } from 'cmdk';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-lg border bg-surface text-ink placeholder:text-faint transition-colors focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted';

/* ------------------------------------------------------------------ Input */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Keep numbers, codes and phone numbers left-to-right inside Arabic pages. */
  ltr?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, leading, trailing, ltr, ...props }, ref) {
  const input = (
    <input
      ref={ref}
      dir={ltr ? 'ltr' : undefined}
      aria-invalid={invalid || undefined}
      className={cn(
        control,
        'h-9 px-3 text-sm',
        invalid ? 'border-crit' : 'border-line-strong',
        leading ? 'ps-9' : null,
        trailing ? 'pe-9' : null,
        ltr ? 'text-left' : null,
        className,
      )}
      {...props}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <div className="relative">
      {leading ? <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-faint [&_svg]:size-4">{leading}</span> : null}
      {input}
      {trailing ? <span className="absolute inset-y-0 end-2 flex items-center text-faint [&_svg]:size-4">{trailing}</span> : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { className, invalid, rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(control, 'px-3 py-2 text-sm', invalid ? 'border-crit' : 'border-line-strong', className)}
      {...props}
    />
  );
});

/** Search box with an icon and a clear button. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  className,
  ltr,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  ltr?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? t('actions.search')}
      autoFocus={autoFocus}
      className={className}
      ltr={ltr}
      leading={<Search />}
      trailing={
        value ? (
          <button type="button" className="rounded p-0.5 hover:text-ink" onClick={() => onChange('')} aria-label={t('actions.clear')}>
            <X />
          </button>
        ) : null
      }
    />
  );
}

/* ------------------------------------------------------------------ Label / Field */

export function Label({ htmlFor, children, required, className }: { htmlFor?: string; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-[13px] font-medium text-ink-2', className)}>
      {children}
      {required ? <span className="ms-0.5 text-crit">*</span> : null}
    </label>
  );
}

/** Label + control + hint/error. Pass the control as children; use the render prop to get the generated id. */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode | ((id: string) => ReactNode);
}) {
  const id = useId();
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label ? (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      ) : null}
      {typeof children === 'function' ? children(id) : children}
      {error ? <p className="text-[12.5px] text-crit">{error}</p> : hint ? <p className="text-[12.5px] text-muted">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Checkbox / Switch / Radio */

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
}: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className="inline-flex items-center gap-2">
      <RCheckbox.Root
        id={cid}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="grid size-[18px] shrink-0 place-items-center rounded-[5px] border border-line-strong bg-surface data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent disabled:opacity-50"
      >
        <RCheckbox.Indicator className="text-accent-ink">
          {checked === 'indeterminate' ? <span className="block h-0.5 w-2.5 rounded bg-current" /> : <Check className="size-3.5" strokeWidth={3} />}
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      {label ? (
        <label htmlFor={cid} className="cursor-pointer text-sm text-ink-2 select-none">
          {label}
        </label>
      ) : null}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="inline-flex items-center gap-2.5">
      <RSwitch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px] rtl:-translate-x-0.5 rtl:data-[state=checked]:-translate-x-[18px]" />
      </RSwitch.Root>
      {label ? (
        <label htmlFor={id} className="cursor-pointer text-sm text-ink-2 select-none">
          {label}
        </label>
      ) : null}
    </div>
  );
}

export function RadioGroup<T extends string>({
  value,
  onValueChange,
  options,
  className,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; hint?: ReactNode }>;
  className?: string;
}) {
  return (
    <RRadio.Root value={value} onValueChange={(v) => onValueChange(v as T)} className={cn('flex flex-col gap-2', className)}>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2.5 text-sm">
          <RRadio.Item value={o.value} className="mt-0.5 grid size-[18px] place-items-center rounded-full border border-line-strong bg-surface data-[state=checked]:border-accent">
            <RRadio.Indicator className="size-2.5 rounded-full bg-accent" />
          </RRadio.Item>
          <span>
            <span className="text-ink">{o.label}</span>
            {o.hint ? <span className="block text-[12.5px] text-muted">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </RRadio.Root>
  );
}

/* ------------------------------------------------------------------ Select */

export type Option = { value: string; label: string; hint?: string; disabled?: boolean };

/** Simple select. Radix needs non-empty values; use "" for "nothing chosen" (placeholder shows). */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  invalid,
  className,
  id,
  size = 'md',
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <RSelect.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <RSelect.Trigger
        id={id}
        aria-invalid={invalid || undefined}
        className={cn(
          control,
          'inline-flex items-center justify-between gap-2 px-3 text-start text-sm data-[placeholder]:text-faint',
          size === 'sm' ? 'h-8' : 'h-9',
          invalid ? 'border-crit' : 'border-line-strong',
          className,
        )}
      >
        <span className="truncate">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon>
          <ChevronDown className="size-4 text-faint" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={4} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-raised shadow-pop">
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 ps-7 pe-2 text-sm text-ink outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken"
              >
                <RSelect.ItemIndicator className="absolute start-2">
                  <Check className="size-3.5 text-accent" />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                {o.hint ? <span className="ms-auto text-[12px] text-muted">{o.hint}</span> : null}
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/* ------------------------------------------------------------------ Combobox */

/** Searchable select (local filtering, or remote via onSearchChange). */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  invalid,
  loading,
  onSearchChange,
  className,
  id,
  clearable,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: Option[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  loading?: boolean;
  onSearchChange?: (q: string) => void;
  className?: string;
  id?: string;
  clearable?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          aria-invalid={invalid || undefined}
          className={cn(control, 'inline-flex h-9 items-center justify-between gap-2 px-3 text-start text-sm', invalid ? 'border-crit' : 'border-line-strong', className)}
        >
          <span className={cn('truncate', !selected && 'text-faint')}>{selected ? selected.label : (placeholder ?? t('actions.choose'))}</span>
          <span className="flex items-center gap-1">
            {clearable && selected ? (
              <X
                className="size-3.5 text-faint hover:text-ink"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            ) : null}
            <ChevronDown className="size-4 text-faint" />
          </span>
        </button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content align="start" sideOffset={4} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-64 rounded-lg border border-line bg-raised shadow-pop">
          <Command shouldFilter={!onSearchChange} className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-faint" />
              <Command.Input
                autoFocus
                placeholder={searchPlaceholder ?? t('actions.search')}
                onValueChange={onSearchChange}
                className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-faint"
              />
              {loading ? <Loader2 className="size-4 animate-spin text-faint" /> : null}
            </div>
            <Command.List className="max-h-72 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted">{emptyText ?? t('empty.noMatches')}</Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                  disabled={o.disabled}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[disabled=true]:opacity-50 data-[selected=true]:bg-sunken"
                >
                  <Check className={cn('size-3.5 text-accent', o.value === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{o.label}</span>
                  {o.hint ? <span className="ms-auto shrink-0 text-[12px] text-muted">{o.hint}</span> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
