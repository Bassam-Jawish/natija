import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/** The lab's own logo (SVG stored with the lab), or a tile with its initial. */
export function LabLogo({ svg, name, className }: { svg: string | null | undefined; name: string; className?: string }) {
  const src = useMemo(() => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null), [svg]);
  if (src) return <img src={src} alt="" className={cn('size-9 shrink-0 rounded-[10px]', className)} />;
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-[10px] bg-brand text-sm font-bold text-white', className)}>
      {name.slice(0, 1)}
    </span>
  );
}

/** Natija wordmark: a tube whose fill reads as a check mark. */
export function NatijaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--c-accent)" />
      <path d="M13 7h6M14 7v8.5L9 24a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 23 24l-5-8.5V7" fill="none" stroke="var(--c-accent-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 21.5l2.2 2.2 4.8-4.8" fill="none" stroke="var(--c-accent-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
