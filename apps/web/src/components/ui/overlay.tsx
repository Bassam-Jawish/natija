import { useEffect, useState, type ReactNode } from 'react';
import { Dialog as RDialog, DropdownMenu as RMenu, Popover as RPopover, Tooltip as RTooltip } from 'radix-ui';
import { ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Field, Input, Textarea } from './form';

/* ------------------------------------------------------------------ Dialog */

const SIZES = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in" />
        <RDialog.Content
          className={cn(
            'fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-xl border border-line bg-surface shadow-pop',
            SIZES[size],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="text-base font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-[13px] text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === 'string' ? title : ''}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('actions.close')}>
                <X />
              </Button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* ------------------------------------------------------------------ Drawer (side panel on the end edge) */

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const { t } = useTranslation();
  const w = { sm: 'w-[380px]', md: 'w-[520px]', lg: 'w-[720px]', xl: 'w-[920px]' }[width];
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RDialog.Content className={cn('fixed inset-y-0 end-0 z-50 flex max-w-[100vw] flex-col border-s border-line bg-surface shadow-pop', w)}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="text-base font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-[13px] text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === 'string' ? title : ''}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('actions.close')}>
                <X />
              </Button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* ------------------------------------------------------------------ Confirm */

/**
 * Confirmation for clinical or destructive actions. With `reason`, the user must type why
 * (cancel order, reject sample, amend result, refund); the reason is passed to onConfirm.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  reason,
  reasonLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  reason?: 'required' | 'optional';
  reasonLabel?: string;
  onConfirm: (reason?: string) => void | Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const disabled = reason === 'required' && text.trim().length < 3;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            disabled={disabled}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason ? text.trim() : undefined);
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel ?? t('actions.confirm')}
          </Button>
        </>
      }
    >
      {reason ? (
        <Field label={reasonLabel ?? t('confirm.reason')} required={reason === 'required'}>
          {(id) => <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={3} />}
        </Field>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ E-signature */

/**
 * Electronic signature for medical validation and amendments: the user re-enters their password.
 * onConfirm receives the password and should call the API; an ApiError with code "wrong_password"
 * shows inline.
 */
export function ESignDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  children?: ReactNode;
  onConfirm: (password: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPassword('');
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="size-5 text-ok" />
          {title}
        </span>
      }
      description={description ?? t('esign.description')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!password} onClick={submit}>
            {confirmLabel ?? t('esign.sign')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void submit();
        }}
      >
        {children}
        <Field label={t('esign.password')} error={error}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus invalid={!!error} />}
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Popover / Tooltip / Menu */

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export function PopoverContent({ children, className, align = 'end' }: { children: ReactNode; className?: string; align?: 'start' | 'center' | 'end' }) {
  return (
    <RPopover.Portal>
      <RPopover.Content align={align} sideOffset={6} className={cn('z-50 rounded-xl border border-line bg-raised shadow-pop', className)}>
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  );
}

export const TooltipProvider = RTooltip.Provider;
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root delayDuration={250}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md bg-ink px-2 py-1 text-[12px] text-paper shadow-pop">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;
export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <RMenu.Portal>
      <RMenu.Content align={align} sideOffset={6} className={cn('z-50 min-w-48 rounded-xl border border-line bg-raised p-1 shadow-pop', className)}>
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}
export function MenuItem({ children, onSelect, danger, disabled }: { children: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken [&_svg]:size-4',
        danger ? 'text-crit' : 'text-ink',
      )}
    >
      {children}
    </RMenu.Item>
  );
}
export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-line" />;
}
export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="px-2.5 py-1.5 text-[12px] font-medium text-muted">{children}</RMenu.Label>;
}
