import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { cn } from '@/lib/utils';

/** Code 128 barcode as SVG (prints sharply on label printers). */
export function Barcode({
  value,
  height = 40,
  barWidth = 1.4,
  showText = true,
  fontSize = 11,
  className,
}: {
  value: string;
  height?: number;
  barWidth?: number;
  showText?: boolean;
  fontSize?: number;
  className?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128',
        height,
        width: barWidth,
        displayValue: showText,
        fontSize,
        font: 'IBM Plex Mono',
        margin: 0,
        background: 'transparent',
        lineColor: '#000000',
      });
    } catch {
      /* invalid value: leave empty */
    }
  }, [value, height, barWidth, showText, fontSize]);
  return <svg ref={ref} className={cn('max-w-full', className)} aria-label={value} role="img" />;
}

/** QR code rendered to a data URL. */
export function QrCode({ value, size = 96, className }: { value: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { margin: 0, width: size * 2, errorCorrectionLevel: 'M' })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt="" className={className} /> : <div style={{ width: size, height: size }} className={className} />;
}
