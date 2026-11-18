/** A file answer (Excel/CSV export, attachment download): returned as is, without the JSON round trip. */
export class MockFile {
  constructor(
    public filename: string,
    public mime: string,
    public content: BlobPart,
  ) {}
}

/** CSV with a UTF-8 byte-order mark, so Excel shows Arabic correctly. */
export function csvFile(filename: string, rows: Array<Array<string | number | null | undefined>>): MockFile {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  return new MockFile(filename.replace(/\.xlsx$/i, '.csv'), 'text/csv;charset=utf-8', `﻿${text}`);
}
