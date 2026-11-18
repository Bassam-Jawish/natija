/**
 * Excel exports (exceljs). Arabic workbooks are written right-to-left; numbers keep their
 * formats so the lab can keep calculating in Excel.
 */
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';

export type Lang = 'ar' | 'en';
export type ColumnFormat = 'text' | 'int' | 'decimal' | 'money' | 'percent' | 'minutes' | 'datetime' | 'date';

export type SheetSpec = {
  name: string;
  title?: string;
  subtitle?: string;
  columns: Array<{ header: string; key: string; width?: number; format?: ColumnFormat }>;
  rows: Array<Record<string, unknown>>;
  /** Optional totals row, keyed like the columns. */
  totals?: Record<string, unknown>;
};

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Pick the label for the workbook language. */
export const L = (lang: Lang, en: string, ar: string) => (lang === 'ar' ? ar : en);

function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  for (let i = 2; used.has(out); i++) out = `${base.slice(0, 28)} ${i}`;
  used.add(out);
  return out;
}

function numFmt(format: ColumnFormat | undefined, currency: string): string | undefined {
  switch (format) {
    case 'int':
      return '#,##0';
    case 'decimal':
      return '#,##0.00';
    case 'money':
      return currency === 'SYP' ? '#,##0' : '#,##0.00';
    case 'percent':
      return '0.0"%"';
    case 'minutes':
      return '#,##0';
    case 'datetime':
      return 'yyyy-mm-dd hh:mm';
    case 'date':
      return 'yyyy-mm-dd';
    default:
      return undefined;
  }
}

export async function buildWorkbook(sheets: SheetSpec[], opts: { lang: Lang; currency: string; creator?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = opts.creator ?? 'Natija';
  wb.created = new Date();
  const used = new Set<string>();
  const rtl = opts.lang === 'ar';
  for (const spec of sheets) {
    const headerRow = (spec.title ? 1 : 0) + (spec.subtitle ? 1 : 0) + (spec.title || spec.subtitle ? 1 : 0) + 1;
    const ws = wb.addWorksheet(sheetName(spec.name, used), {
      views: [{ rightToLeft: rtl, state: 'frozen', ySplit: headerRow }],
      properties: { defaultRowHeight: 18 },
    });
    ws.columns = spec.columns.map((c) => ({ key: c.key, width: c.width ?? Math.max(12, Math.min(48, c.header.length + 4)) }));
    let r = 1;
    if (spec.title) {
      const cell = ws.getCell(r, 1);
      cell.value = spec.title;
      cell.font = { bold: true, size: 14 };
      r++;
    }
    if (spec.subtitle) {
      const cell = ws.getCell(r, 1);
      cell.value = spec.subtitle;
      cell.font = { color: { argb: 'FF5F697A' } };
      r++;
    }
    if (spec.title || spec.subtitle) r++;
    const header = ws.getRow(r);
    spec.columns.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0F4' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFC3C9D4' } } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    header.height = 22;
    const write = (values: Record<string, unknown>, bold = false) => {
      r++;
      const row = ws.getRow(r);
      spec.columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        let v = values[c.key];
        if ((c.format === 'datetime' || c.format === 'date') && typeof v === 'string' && v) v = new Date(v);
        cell.value = (v ?? null) as ExcelJS.CellValue;
        const fmt = numFmt(c.format, opts.currency);
        if (fmt) cell.numFmt = fmt;
        if (bold) cell.font = { bold: true };
      });
    };
    for (const row of spec.rows) write(row);
    if (spec.totals) write(spec.totals, true);
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function sendWorkbook(reply: FastifyReply, buffer: Buffer, filename: string) {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return reply
    .header('Content-Type', XLSX_MIME)
    .header('Content-Disposition', `attachment; filename="${safe}"`)
    .header('Cache-Control', 'no-store')
    .send(buffer);
}
