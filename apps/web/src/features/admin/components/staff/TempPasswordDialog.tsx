import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import type { StaffTemporaryPassword } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useBi } from '@/lib/i18n';
import { Button, Dialog, InfoList } from '@/components/ui';
import { copyText } from '../common';

/** Shows a new temporary password exactly once (after creating a user or resetting a password). */
export function TempPasswordDialog({ result, mode, onClose }: { result: StaffTemporaryPassword; mode: 'created' | 'reset'; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const { me } = useAuth();
  const [copied, setCopied] = useState(false);
  const name = bi(result.user, 'fullName');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound className="size-5 text-accent" />
          {mode === 'created' ? t('staff.temp.createdTitle') : t('staff.temp.resetTitle')}
        </span>
      }
      description={name}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('staff.temp.done')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-sunken px-4 py-3">
          <span className="font-mono text-[22px] font-medium tracking-wider text-ink select-all ltr-num" aria-label={t('staff.temp.password')}>
            {result.temporaryPassword}
          </span>
          <Button
            variant={copied ? 'success' : 'secondary'}
            size="sm"
            onClick={async () => {
              if (await copyText(result.temporaryPassword)) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t('common:actions.copied') : t('common:actions.copy')}
          </Button>
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t('staff.temp.once', { name })}</span>
        </div>
        <InfoList
          columns={2}
          items={[
            { label: t('staff.temp.labCode'), value: <span className="font-mono ltr-num">{me?.lab.code}</span> },
            { label: t('fields.username'), value: <span className="font-mono ltr-num">{result.user.username}</span> },
          ]}
        />
        <p className="text-[12.5px] text-muted">{t('staff.temp.change')}</p>
      </div>
    </Dialog>
  );
}
