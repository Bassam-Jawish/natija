/**
 * Boditech ichroma III — INVENTED DEMO FORMAT.
 *
 * Boditech publishes no host-interface specification for the ichroma III (research
 * status: Unknown). So that the demo covers all six instruments, the simulator and this
 * parser use a line format we made up:
 *
 *   ICHROMA-DEMO|<sampleId>|<test>|<value>|<unit>|<YYYY-MM-DDTHH:MM:SS>
 *
 * one line per result, CR LF terminated. THIS IS NOT BODITECH'S PROTOCOL. A real
 * integration needs the vendor's interface document or a capture from a real analyzer.
 */

export const ICHROMA_DEMO_TAG = 'ICHROMA-DEMO';
export const ICHROMA_DEMO_NOTICE = 'Invented demo format, not Boditech\'s protocol (no public ichroma III host-interface specification).';

export type IchromaDemoLine = { sampleId: string; test: string; value: string; unit: string; time: string };

export function buildIchromaDemo(lines: IchromaDemoLine[]): string {
  const clean = (s: string) => s.replace(/[|\r\n]/g, ' ').trim();
  return lines
    .map((l) => [ICHROMA_DEMO_TAG, clean(l.sampleId), clean(l.test), clean(l.value), clean(l.unit), clean(l.time)].join('|'))
    .map((l) => `${l}\r\n`)
    .join('');
}

export function parseIchromaDemo(text: string): { lines: IchromaDemoLine[]; warnings: string[] } {
  const lines: IchromaDemoLine[] = [];
  const warnings: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts[0] !== ICHROMA_DEMO_TAG) {
      warnings.push(`ignored line that is not in the demo format: ${line.slice(0, 60)}`);
      continue;
    }
    if (parts.length !== 6) {
      warnings.push(`demo line with ${parts.length} fields instead of 6: ${line.slice(0, 60)}`);
      continue;
    }
    const [, sampleId, test, value, unit, time] = parts as [string, string, string, string, string, string];
    if (!sampleId || !test) {
      warnings.push(`demo line without sample ID or test: ${line.slice(0, 60)}`);
      continue;
    }
    lines.push({ sampleId, test, value, unit, time });
  }
  return { lines, warnings };
}
