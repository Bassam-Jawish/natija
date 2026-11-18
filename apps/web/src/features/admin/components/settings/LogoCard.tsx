import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ImageUp, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import type { SettingsLabProfile, SettingsLogoResult } from '@natija/contracts';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Badge, Button, Card, ConfirmDialog, toast } from '@/components/ui';
import { useAdminError } from '../common';
import { settle } from '../common';
import { svgDataUrl, useLabSaved } from './use-lab';

const MAX_BYTES = 100 * 1024;

type Pending = { source: string; fileName: string; result: SettingsLogoResult };

function LogoTile({ svg, label }: { svg: string | null; label: string }) {
  const { t } = useTranslation('admin');
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="grid h-28 place-items-center rounded-lg border border-line bg-[repeating-conic-gradient(var(--c-sunken)_0_25%,var(--c-surface)_0_50%)] bg-[length:16px_16px] p-3">
        {svg ? <img src={svgDataUrl(svg)} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[12.5px] text-faint">{t('settings.logo.none')}</span>}
      </div>
      <figcaption className="text-[12px] text-muted">{label}</figcaption>
    </figure>
  );
}

/**
 * Logo upload: the file is read in the browser, cleaned by the server (whitelisted SVG only),
 * previewed, and saved only when the user confirms.
 */
export function LogoCard({ profile }: { profile: SettingsLabProfile }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const errorMessage = useAdminError();
  const saved = useLabSaved();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const preview = useMutation({ mutationFn: (svg: string) => api.post<SettingsLogoResult>('/settings/lab/logo/preview', { svg }) });
  const save = useMutation({
    mutationFn: (svg: string) => api.put<SettingsLogoResult>('/settings/lab/logo', { svg }),
    onSuccess: async () => {
      setPending(null);
      toast.success(t('settings.logo.saved'));
      await saved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.del('/settings/lab/logo'),
    onSuccess: async () => {
      toast.success(t('settings.logo.removed'));
      await saved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const kb = (bytes: number) => f.number(bytes / 1024, 1);

  const onFile = async (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    setProblem(null);
    setPending(null);
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
      setProblem(t('errors.svg_not_svg'));
      return;
    }
    if (file.size > MAX_BYTES) {
      setProblem(t('errors.svg_too_large'));
      return;
    }
    try {
      const source = await file.text();
      const result = await preview.mutateAsync(source);
      setPending({ source, fileName: file.name, result });
    } catch (err) {
      setProblem(err instanceof ApiError ? errorMessage(err) : t('settings.logo.readFailed'));
    }
  };

  return (
    <Card
      title={t('settings.logo.title')}
      description={t('settings.logo.description')}
      actions={
        profile.logoSvg && !pending ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)} className="text-crit">
            <Trash2 />
            {t('settings.logo.remove')}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <LogoTile svg={profile.logoSvg} label={t('settings.logo.current')} />
          {pending ? <LogoTile svg={pending.result.svg} label={t('settings.logo.new', { size: kb(pending.result.bytes) })} /> : null}
        </div>

        {problem ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-crit-soft px-3 py-2 text-[12.5px] text-crit">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{problem}</span>
          </div>
        ) : null}

        {pending ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-sunken/50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <ShieldCheck className="size-4 text-ok" />
              {t('settings.logo.cleaned', { file: pending.fileName })}
            </p>
            {pending.result.removed.length ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                <span>{t('settings.logo.removedParts')}</span>
                {pending.result.removed.map((r) => (
                  <Badge key={r} tone="muted" className="font-mono ltr-num">
                    {r}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate(pending.source)}>
                {t('settings.logo.use')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                {t('common:actions.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept=".svg,image/svg+xml" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button variant="secondary" size="sm" loading={preview.isPending} onClick={() => input.current?.click()}>
            <ImageUp />
            {profile.logoSvg ? t('settings.logo.replace') : t('settings.logo.upload')}
          </Button>
          <span className="text-[12px] text-muted">{t('settings.logo.limits')}</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        tone="danger"
        title={t('settings.logo.removeTitle')}
        description={t('settings.logo.removeBody')}
        confirmLabel={t('settings.logo.remove')}
        onConfirm={() => settle(remove.mutateAsync())}
      />
    </Card>
  );
}
