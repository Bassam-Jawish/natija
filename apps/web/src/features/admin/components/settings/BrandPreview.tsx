import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { inkOn, svgDataUrl } from './use-lab';

/** How the report letterhead will look with the chosen colour and logo (both languages). */
export function BrandPreview({
  color,
  logoSvg,
  nameAr,
  nameEn,
  taglineAr,
  taglineEn,
  phone,
  className,
}: {
  color: string;
  logoSvg: string | null;
  nameAr: string;
  nameEn: string;
  taglineAr: string;
  taglineEn: string;
  phone: string;
  className?: string;
}) {
  const { t } = useTranslation('admin');
  const valid = /^#[0-9a-fA-F]{6}$/.test(color);
  const brand = valid ? color : '#2347B0';
  return (
    <div className={cn('overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface', className)} aria-label={t('settings.brand.preview')}>
      <div className="h-1.5" style={{ background: brand }} />
      <div className="flex items-center gap-3 px-4 py-3">
        {logoSvg ? (
          <img src={svgDataUrl(logoSvg)} alt="" className="size-11 shrink-0 rounded-[10px] object-contain" />
        ) : (
          <span className="grid size-11 shrink-0 place-items-center rounded-[10px] text-base font-bold" style={{ background: brand, color: inkOn(brand) }}>
            {(nameAr || nameEn || '?').slice(0, 1)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink" dir="rtl">
            {nameAr || '—'}
          </p>
          <p className="truncate text-[12.5px] text-muted" dir="ltr">
            {nameEn || '—'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-[11.5px] text-muted">
        <span className="truncate" dir="rtl">
          {taglineAr || taglineEn || t('settings.brand.noTagline')}
        </span>
        {phone ? <span className="ltr-num">{phone}</span> : null}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-sunken/60 px-4 py-2">
        <span className="h-6 rounded-md px-2.5 text-[12px] leading-6 font-medium" style={{ background: brand, color: inkOn(brand) }}>
          {t('settings.brand.sampleTitle')}
        </span>
        <span className="text-[12px] font-medium" style={{ color: brand }}>
          {t('settings.brand.sampleLink')}
        </span>
      </div>
    </div>
  );
}
