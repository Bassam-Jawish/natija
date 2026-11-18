import { Fragment, useMemo, type ReactNode } from 'react';
import type { ReportLanguage, ReportRow, ReportSnapshot } from '@natija/contracts';
import i18n from '@/lib/i18n';
import { QrCode } from '@/components/ui';

/*
 * The laboratory report, drawn from the frozen snapshot. The same component prints on A4
 * (letterhead and footer repeat on every page through the table header/footer groups, page
 * numbers come from the @page margin box) and shows on screen in the patient portal.
 * It is a document, so it stays black on white in both themes; flags use arrows and letters
 * (↑ H, ↓ L, ↑↑ HH, ↓↓ LL, ! A) so the printout reads correctly in black and white.
 */

const FLAG_MARK: Record<string, string> = { H: '↑ H', L: '↓ L', HH: '↑↑ HH', LL: '↓↓ LL', A: '! A' };

function svgSrc(svg: string | null) {
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}

export function ReportDocument({
  snapshot: s,
  language,
  mode,
  origin = typeof window === 'undefined' ? '' : window.location.origin,
}: {
  snapshot: ReportSnapshot;
  language: ReportLanguage;
  mode: 'print' | 'screen';
  origin?: string;
}) {
  const tAr = useMemo(() => i18n.getFixedT('ar', 'bench', 'report'), []);
  const tEn = useMemo(() => i18n.getFixedT('en', 'bench', 'report'), []);
  const bi = language === 'bilingual';
  /** Bilingual reports read left-to-right with English names first and Arabic under them. */
  const primary = language === 'ar' ? 'ar' : 'en';
  const dir = language === 'ar' ? 'rtl' : 'ltr';
  const verifyUrl = `${origin}/verify/${s.verifyCode}`;

  const fmt = useMemo(() => {
    const opts: Intl.DateTimeFormatOptions = { timeZone: s.lab.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    const dt = new Intl.DateTimeFormat(primary === 'ar' && !bi ? 'ar-SY-u-nu-latn' : 'en-GB', opts);
    const d = new Intl.DateTimeFormat(primary === 'ar' && !bi ? 'ar-SY-u-nu-latn' : 'en-GB', { timeZone: s.lab.timezone, day: '2-digit', month: '2-digit', year: 'numeric' });
    return { dateTime: (v: string | null) => (v ? dt.format(new Date(v)) : '—'), date: (v: string | null) => (v ? d.format(new Date(v)) : '—') };
  }, [s.lab.timezone, primary, bi]);

  /** A label in the report's language(s). */
  const L = (key: string, opts?: Record<string, unknown>): ReactNode =>
    bi ? (
      <>
        <span lang="en">{tEn(key, opts)}</span>
        <span className="sep"> / </span>
        <span lang="ar" dir="rtl">
          {tAr(key, opts)}
        </span>
      </>
    ) : primary === 'ar' ? (
      tAr(key, opts)
    ) : (
      tEn(key, opts)
    );
  const name = (row: { nameAr: string; nameEn: string | null }) => (primary === 'ar' ? row.nameAr : row.nameEn || row.nameAr);
  const secondName = (row: { nameAr: string; nameEn: string | null }) => (bi ? row.nameAr : primary === 'ar' ? row.nameEn : null);
  const logo = svgSrc(s.lab.logoSvg);
  const sex = bi ? `${tEn(s.patient.sex)} / ${tAr(s.patient.sex)}` : primary === 'ar' ? tAr(s.patient.sex) : tEn(s.patient.sex);
  const age = bi ? `${s.patient.ageEn} / ${s.patient.ageAr}` : primary === 'ar' ? s.patient.ageAr : s.patient.ageEn;
  const pageLabel =
    language === 'ar'
      ? `"صفحة " counter(page) " من " counter(pages)`
      : language === 'en'
        ? `"Page " counter(page) " of " counter(pages)`
        : `"Page " counter(page) " of " counter(pages) "  ·  صفحة " counter(page) " من " counter(pages)`;

  const labBlock = (lang: 'ar' | 'en') => (
    <div className={`lab-block ${lang}`} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div className="lab-name">{lang === 'ar' ? s.lab.nameAr : s.lab.nameEn}</div>
      {(lang === 'ar' ? s.lab.taglineAr : s.lab.taglineEn) ? <div className="lab-tagline">{lang === 'ar' ? s.lab.taglineAr : s.lab.taglineEn}</div> : null}
      {(lang === 'ar' ? s.lab.directorNameAr : s.lab.directorNameEn) ? (
        <div className="lab-director">
          {lang === 'ar' ? s.lab.directorNameAr : s.lab.directorNameEn}
          {(lang === 'ar' ? s.lab.directorTitleAr : s.lab.directorTitleEn) ? <span className="muted"> · {lang === 'ar' ? s.lab.directorTitleAr : s.lab.directorTitleEn}</span> : null}
        </div>
      ) : null}
    </div>
  );

  const field = (label: ReactNode, value: ReactNode, wide?: boolean) => (
    <div className={wide ? 'pf wide' : 'pf'}>
      <div className="pf-label">{label}</div>
      <div className="pf-value">{value}</div>
    </div>
  );

  const resultRow = (row: ReportRow, key: string) => {
    const abnormal = !!row.flag && row.flag !== 'N';
    const second = secondName(row);
    return (
      <Fragment key={key}>
        <tr className={row.comment ? 'has-comment' : undefined}>
          <td className="c-name">
            <div>{name(row)}</div>
            {second ? (
              <div className="second" lang={bi ? 'ar' : 'en'} dir={bi ? 'rtl' : 'ltr'}>
                {second}
              </div>
            ) : null}
          </td>
          <td className={abnormal ? 'c-value abn' : 'c-value'}>
            <span className="ltr">{row.value ?? '—'}</span>
            {row.amended ? <span className="amended-mark">{L('amendedMark')}</span> : null}
          </td>
          <td className="c-flag">
            {abnormal ? <span className="ltr flag">{FLAG_MARK[row.flag!] ?? row.flag}</span> : null}
            {row.isCritical ? <div className="critical">{L('critical')}</div> : null}
          </td>
          <td className="c-unit">
            <span className="ltr">{row.unit ?? ''}</span>
          </td>
          <td className="c-ref">
            <span className="ltr">{row.refText ?? ''}</span>
          </td>
          <td className="c-prev">
            {row.previous ? (
              <>
                <span className="ltr">{row.previous.value ?? '—'}</span>
                <div className="second ltr">{fmt.date(row.previous.at)}</div>
              </>
            ) : null}
          </td>
        </tr>
        {row.comment ? (
          <tr className="comment-row">
            <td colSpan={6}>
              <span className="muted">{L('comment')}: </span>
              {row.comment}
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  };

  return (
    <article className="rpt" data-mode={mode} dir={dir} lang={primary} style={{ ['--rpt-brand' as string]: s.lab.brandColor }}>
      <style>{reportCss(pageLabel)}</style>
      <table className="frame">
        <thead>
          <tr>
            <td>
              <header className="letterhead">
                <div className="band" />
                <div className={bi ? 'lh-row bi' : 'lh-row'}>
                  {bi ? (
                    <>
                      {labBlock('en')}
                      {logo ? <img className="logo" src={logo} alt="" /> : <div className="logo" />}
                      {labBlock('ar')}
                    </>
                  ) : (
                    <>
                      {logo ? <img className="logo" src={logo} alt="" /> : null}
                      {labBlock(primary)}
                      <div className="lh-contact ltr">
                        {s.lab.phone ? <div>{s.lab.phone}</div> : null}
                        {s.lab.email ? <div>{s.lab.email}</div> : null}
                      </div>
                    </>
                  )}
                </div>
                <div className="lh-address">
                  {bi ? (
                    <>
                      <span lang="en">{s.lab.addressEn}</span>
                      {s.lab.phone ? <span className="ltr"> · {s.lab.phone}</span> : null}
                      {s.lab.email ? <span className="ltr"> · {s.lab.email}</span> : null}
                      {s.lab.addressAr ? (
                        <span lang="ar" dir="rtl">
                          {' '}
                          · {s.lab.addressAr}
                        </span>
                      ) : null}
                    </>
                  ) : primary === 'ar' ? (
                    s.lab.addressAr
                  ) : (
                    s.lab.addressEn
                  )}
                </div>
              </header>
              <section className="patient">
                {field(L('patient'), (
                  <>
                    <strong>{bi || primary === 'ar' || !s.patient.fullNameEn ? s.patient.fullNameAr : s.patient.fullNameEn}</strong>
                    {bi && s.patient.fullNameEn ? (
                      <span className="second-inline" lang="en" dir="ltr">
                        {' '}
                        · {s.patient.fullNameEn}
                      </span>
                    ) : null}
                  </>
                ), true)}
                {field(L('sexAge'), `${sex} · ${age}`)}
                {field(L('mrn'), <span className="ltr mono">{s.patient.mrn}</span>)}
                {field(L('order'), (
                  <span className="ltr mono">
                    {s.order.accession} <span className="muted">#{s.order.dailyNo}</span>
                  </span>
                ))}
                {field(L('doctor'), s.order.doctor ? name(s.order.doctor) : (s.order.referralClinic ?? '—'))}
                {field(L('collected'), <span className="ltr">{fmt.dateTime(s.order.collectedAt ?? s.order.createdAt)}</span>)}
                {field(L('received'), <span className="ltr">{fmt.dateTime(s.order.receivedAt)}</span>)}
                {field(L('validated'), <span className="ltr">{fmt.dateTime(s.order.validatedAt)}</span>)}
                {field(L('released'), <span className="ltr">{fmt.dateTime(s.order.releasedAt)}</span>)}
              </section>
            </td>
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td>
              <footer className="rpt-footer">
                <div className="qr">
                  <QrCode value={verifyUrl} size={64} />
                </div>
                <div className="foot-text">
                  <div>
                    {L('verifyAt')} <span className="ltr mono">{verifyUrl.replace(/^https?:\/\//, '')}</span>
                  </div>
                  <div>
                    {L('code')}: <span className="ltr mono code">{s.verifyCode}</span>
                    {s.version > 1 ? <span className="muted"> · {L('versionN', { version: s.version })}</span> : null}
                  </div>
                  {bi ? (
                    <>
                      {s.footerEn ? <div lang="en">{s.footerEn}</div> : null}
                      {s.footerAr ? (
                        <div lang="ar" dir="rtl">
                          {s.footerAr}
                        </div>
                      ) : null}
                    </>
                  ) : (primary === 'ar' ? s.footerAr : s.footerEn) ? (
                    <div>{primary === 'ar' ? s.footerAr : s.footerEn}</div>
                  ) : null}
                  {s.demo ? <div className="demo">{L('demo')}</div> : null}
                </div>
              </footer>
            </td>
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td>
              {s.version > 1 ? (
                <div className="amended-banner">
                  <strong>{L('amendedBanner', { version: s.replacesVersion ?? s.version - 1 })}</strong>
                  {s.amendReason ? (
                    <div>
                      {L('reason')}: {s.amendReason}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {s.sections.map((section) => (
                <section key={section.department.code} className="dept">
                  <h2 className="dept-title">
                    {bi ? (
                      <>
                        <span lang="en">{section.department.nameEn}</span>
                        <span className="sep"> · </span>
                        <span lang="ar" dir="rtl">
                          {section.department.nameAr}
                        </span>
                      </>
                    ) : (
                      name(section.department)
                    )}
                  </h2>
                  <table className="res">
                    <thead>
                      <tr>
                        <th className="c-name">{L('test')}</th>
                        <th className="c-value">{L('result')}</th>
                        <th className="c-flag">{L('flag')}</th>
                        <th className="c-unit">{L('unit')}</th>
                        <th className="c-ref">{L('reference')}</th>
                        <th className="c-prev">{L('previous')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.tests.map((test) =>
                        test.rows.length > 1 ? (
                          <Fragment key={test.code}>
                            <tr className="test-row">
                              <td colSpan={6}>
                                <strong>{name(test)}</strong>
                                {secondName(test) ? (
                                  <span className="second-inline" lang={bi ? 'ar' : 'en'} dir={bi ? 'rtl' : 'ltr'}>
                                    {' '}
                                    · {secondName(test)}
                                  </span>
                                ) : null}
                                {test.method ? <span className="muted method"> · {test.method}</span> : null}
                              </td>
                            </tr>
                            {test.rows.map((row) => resultRow(row, `${test.code}-${row.code}`))}
                          </Fragment>
                        ) : (
                          test.rows.map((row) => resultRow(row, `${test.code}-${row.code}`))
                        ),
                      )}
                    </tbody>
                  </table>
                </section>
              ))}
              {s.pendingTests.length ? (
                <p className="pending">
                  <strong>{L('pending')}:</strong> {s.pendingTests.map((p) => name(p)).join(' · ')}
                </p>
              ) : null}
              <div className="signature">
                {s.validators.map((v, i) => (
                  <div key={i} className="sig-line">
                    {L('validatedBy')}{' '}
                    <strong>
                      {[v.title, primary === 'ar' && !bi ? v.nameAr : v.nameEn].filter(Boolean).join(' ')}
                      {bi && v.nameAr ? (
                        <span lang="ar" dir="rtl">
                          {' '}
                          / {v.nameAr}
                        </span>
                      ) : null}
                    </strong>{' '}
                    · <span className="ltr">{fmt.dateTime(v.at)}</span> · {L('signed')}
                  </div>
                ))}
                <div className="end-mark">{L('endOfReport')}</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}

function reportCss(pageLabel: string) {
  return `
@page { size: A4; margin: 12mm; @bottom-center { content: ${pageLabel}; font: 8pt 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif; color: #555; } }
.rpt { color: #111; background: #fff; font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif; font-size: 9.5pt; line-height: 1.38; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.rpt[lang=ar] { font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif; }
.rpt [lang=ar] { font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif; }
.rpt[data-mode=screen] { width: 100%; max-width: 210mm; margin: 0 auto; padding: 10mm 11mm; border-radius: 6px; box-shadow: 0 1px 3px rgb(0 0 0 / .12), 0 12px 32px -16px rgb(0 0 0 / .35); }
@media print { .rpt[data-mode=screen] { padding: 0; box-shadow: none; max-width: none; border-radius: 0; } }
.rpt .frame { width: 100%; border-collapse: collapse; }
.rpt .frame > thead > tr > td, .rpt .frame > tbody > tr > td, .rpt .frame > tfoot > tr > td { padding: 0; vertical-align: top; }
.rpt .ltr { direction: ltr; unicode-bidi: isolate; }
.rpt .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
.rpt .muted { color: #555; }
.rpt .sep { color: #888; }
.rpt .band { height: 4px; background: var(--rpt-brand); border-radius: 2px; }
.rpt .lh-row { display: flex; align-items: center; gap: 12px; padding: 8px 0 4px; }
.rpt .lh-row.bi { justify-content: space-between; }
.rpt .lh-row.bi .lab-block { flex: 1; }
.rpt .lh-row.bi .lab-block.en { text-align: left; }
.rpt .lh-row.bi .lab-block.ar { text-align: right; }
.rpt .lh-row:not(.bi) .lab-block { flex: 1; }
.rpt .logo { width: 15mm; height: 15mm; flex: none; }
.rpt .lab-name { font-size: 14pt; font-weight: 700; color: var(--rpt-brand); line-height: 1.2; }
.rpt .lab-tagline { font-size: 8.5pt; color: #444; }
.rpt .lab-director { font-size: 8.5pt; margin-top: 1px; }
.rpt .lh-contact { font-size: 8.5pt; color: #444; text-align: end; }
.rpt .lh-address { font-size: 8pt; color: #555; text-align: center; border-bottom: 1px solid #222; padding-bottom: 4px; margin-bottom: 6px; }
.rpt .patient { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px 12px; padding: 5px 8px; border: 1px solid #bbb; border-radius: 4px; margin-bottom: 8px; }
.rpt .pf.wide { grid-column: span 2; }
.rpt .pf-label { font-size: 7.5pt; color: #555; }
.rpt .pf-value { font-size: 9pt; }
.rpt .second-inline { color: #444; font-weight: 400; }
.rpt .amended-banner { border: 1.5px solid #111; border-radius: 4px; padding: 5px 8px; margin-bottom: 8px; font-size: 9pt; }
.rpt .dept { margin-top: 8px; }
.rpt .dept-title { font-size: 10.5pt; font-weight: 700; margin: 0 0 3px; padding: 2px 6px; background: #f0f0f0; border-inline-start: 3px solid var(--rpt-brand); }
.rpt table.res { width: 100%; border-collapse: collapse; }
.rpt table.res th { font-size: 7.5pt; font-weight: 600; color: #444; text-align: start; padding: 2px 4px; border-bottom: 1px solid #333; }
.rpt table.res td { padding: 2.5px 4px; border-bottom: 0.5px solid #d4d4d4; vertical-align: top; }
.rpt table.res tr { break-inside: avoid; page-break-inside: avoid; }
.rpt table.res tr.has-comment td { border-bottom: 0; }
.rpt table.res .test-row td { padding-top: 5px; border-bottom: 0.5px solid #999; font-size: 9pt; }
.rpt table.res .method { font-size: 7.5pt; }
.rpt .c-name { width: 34%; }
.rpt .c-value { width: 14%; }
.rpt .c-flag { width: 9%; }
.rpt .c-unit { width: 11%; }
.rpt .c-ref { width: 18%; }
.rpt .c-prev { width: 14%; }
.rpt td.c-value { font-size: 10pt; }
.rpt td.c-value.abn { font-weight: 700; }
.rpt .flag { font-weight: 700; white-space: nowrap; }
.rpt .critical { font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; }
.rpt .second { font-size: 7.5pt; color: #555; }
.rpt .amended-mark { font-size: 7pt; margin-inline-start: 4px; font-weight: 400; }
.rpt .comment-row td { font-size: 8.5pt; font-style: italic; padding-top: 0; }
.rpt .pending { margin-top: 8px; font-size: 8.5pt; }
.rpt .signature { margin-top: 12px; font-size: 8.5pt; break-inside: avoid; }
.rpt .sig-line { margin-top: 2px; }
.rpt .end-mark { margin-top: 8px; text-align: center; font-size: 7.5pt; color: #666; letter-spacing: .05em; }
.rpt .rpt-footer { display: flex; align-items: center; gap: 10px; border-top: 1px solid #222; margin-top: 10px; padding-top: 5px; font-size: 7.5pt; color: #333; }
.rpt .rpt-footer .qr img { display: block; }
.rpt .rpt-footer .code { font-size: 9pt; font-weight: 600; letter-spacing: .08em; }
.rpt .foot-text { flex: 1; display: flex; flex-direction: column; gap: 1px; }
.rpt .demo { font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
`;
}
