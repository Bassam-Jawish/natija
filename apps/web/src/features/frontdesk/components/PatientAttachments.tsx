import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, FileImage, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { ATTACHMENT_KINDS, type AttachmentKind, type AttachmentRow } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Select, Skeleton, toast } from '@/components/ui';
import { fd, keys, useRefresh } from '../api';
import { AnchorButton, FdErrorState, useFdError } from './shared';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';

/** Referral letters, ID copies and previous results: images or PDF, up to 10 MB each. */
export function PatientAttachments({ patientId }: { patientId: string }) {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const errorText = useFdError();
  const refresh = useRefresh();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<AttachmentKind>('referral');
  const [deleting, setDeleting] = useState<AttachmentRow | null>(null);
  const list = useQuery({ queryKey: keys.attachments(patientId), queryFn: () => fd.attachments(patientId) });

  const upload = useMutation({
    mutationFn: (file: File) => fd.upload(patientId, file, kind),
    onSuccess: (row) => {
      toast.success(t('attachments.uploaded', { name: row.fileName }));
      void refresh.patients();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (row: AttachmentRow) => fd.deleteAttachment(patientId, row.id),
    onSuccess: () => {
      toast.success(t('attachments.deleted'));
      void refresh.patients();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const size = (n: number) => (n >= 1024 * 1024 ? `${f.number(n / (1024 * 1024), 1)} MB` : `${f.number(Math.max(1, Math.round(n / 1024)))} KB`);

  return (
    <Card
      title={t('attachments.title')}
      description={t('attachments.hint')}
      actions={
        can('patients.write') ? (
          <>
            <Select size="sm" className="w-44" value={kind} onValueChange={(k) => setKind(k as AttachmentKind)} options={ATTACHMENT_KINDS.map((k) => ({ value: k, label: t(`attachments.kinds.${k}`) }))} />
            <Button size="sm" variant="primary" loading={upload.isPending} onClick={() => input.current?.click()}>
              <Upload />
              {t('attachments.upload')}
            </Button>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > MAX_BYTES) return void toast.error(t('errors.file_too_large'));
                upload.mutate(file);
              }}
            />
          </>
        ) : null
      }
      padded={false}
    >
      {list.isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : list.error ? (
        <FdErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data?.items.length ? (
        <EmptyState icon={Paperclip} title={t('attachments.empty')} />
      ) : (
        <ul>
          {list.data.items.map((a) => {
            const Icon = a.mime === 'application/pdf' ? FileText : FileImage;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
                <Icon className="size-5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <a href={fd.attachmentUrl(patientId, a.id)} target="_blank" rel="noopener" className="block truncate text-[13.5px] font-medium text-ink hover:text-accent hover:underline">
                    {a.fileName}
                  </a>
                  <p className="text-[12px] text-muted">
                    {size(a.size)} · {f.dateTime(a.createdAt)}
                    {a.uploadedBy ? ` · ${bi({ nameAr: a.uploadedBy.fullNameAr, nameEn: a.uploadedBy.fullNameEn })}` : ''}
                  </p>
                </div>
                <Badge tone="neutral">{t(`attachments.kinds.${a.kind}`)}</Badge>
                <AnchorButton href={fd.attachmentUrl(patientId, a.id, true)} size="icon-sm" variant="ghost" aria-label={t('common:actions.download')}>
                  <Download />
                </AnchorButton>
                {can('patients.write') ? (
                  <Button size="icon-sm" variant="ghost" onClick={() => setDeleting(a)} aria-label={t('common:actions.delete')}>
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('attachments.deleteTitle')}
        description={deleting?.fileName}
        confirmLabel={t('common:actions.delete')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting).catch(() => undefined);
        }}
      />
    </Card>
  );
}
