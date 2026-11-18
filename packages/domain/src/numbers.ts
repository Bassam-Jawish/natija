/** Calendar date (YYYY-MM-DD) in the lab's time zone. */
export function dateKey(date: Date, timeZone = 'Asia/Damascus'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Order number: YYMMDD-NNNN, e.g. 261117-0042. The daily part resets each morning. */
export function accessionFor(date: Date, dailyNo: number, timeZone = 'Asia/Damascus'): string {
  const key = dateKey(date, timeZone).replace(/-/g, '').slice(2);
  return `${key}-${String(dailyNo).padStart(4, '0')}`;
}

/** Tube barcode: order number plus the tube number, e.g. 261117-0042-01. */
export function tubeBarcode(accession: string, seq: number): string {
  return `${accession}-${String(seq).padStart(2, '0')}`;
}

export function mrnFor(n: number): string {
  return `P-${String(n).padStart(6, '0')}`;
}

export function invoiceNumber(year: number, n: number): string {
  return `INV-${year}-${String(n).padStart(6, '0')}`;
}

/** Six-digit access code printed on the receipt for the patient's report link. */
export function portalCode(random: () => number = Math.random): string {
  return String(Math.floor(random() * 1_000_000)).padStart(6, '0');
}

/** Short public code behind the QR on a printed report, unambiguous to read aloud. */
export function verifyCode(randomBytes: Uint8Array): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[randomBytes[i]! % alphabet.length];
  return out;
}
