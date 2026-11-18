import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { PricingBulkResult, PricingPayerGroup } from '@natija/contracts';
import { roundMoney } from '@natija/domain';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Button, Checkbox, Dialog, Field, Input, Segmented, Select, toast } from '@/components/ui';
import { NumberField, toNumber, useAdminError } from '../common';

const ROUNDING = [1, 5, 10, 50, 100, 500];

/**
 * Change the unit price of several payer groups at once (yearly price updates). The preview uses
 * the same rounding as the server; the result lists what actually changed.
 */
export function BulkPriceDialog({ payers, onClose }: { payers: PricingPayerGroup[]; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const active = payers.filter((p) => p.isActive);
  const [selected, setSelected] = useState<string[]>(active.map((p) => p.id));
  const [mode, setMode] = useState<'percent' | 'set'>('percent');
  const [value, setValue] = useState('');
  const [roundTo, setRoundTo] = useState('1');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<PricingBulkResult | null>(null);

  const v = toNumber(value);
  const valueError = v === null ? undefined : mode === 'set' ? (v < 0 ? t('fieldErrors.must_be_positive') : undefined) : v < -90 || v > 1000 ? t('pricing.bulk.percentRange') : undefined;

  const preview = useMemo(() => {
    if (v === null) return [];
    const step = Number(roundTo);
    return payers
      .filter((p) => selected.includes(p.id))
      .map((p) => {
        const raw = mode === 'set' ? v : p.unitPrice * (1 + v / 100);
        const rounded = Math.max(0, Math.round(raw / step) * step);
        const after = step === 1 ? roundMoney(rounded, f.currency) : rounded;
        return { payer: p, before: p.unitPrice, after, change: p.unitPrice ? ((after - p.unitPrice) / p.unitPrice) * 100 : null };
      });
  }, [payers, selected, mode, v, roundTo, f.currency]);
  const effective = preview.filter((r) => r.after !== r.before).length;

  const apply = useMutation({
    mutationFn: () =>
      api.post<PricingBulkResult>('/pricing/bulk-unit-price', { payerGroupIds: selected, mode, value: v, roundTo: Number(roundTo), reason: reason.trim() || null }),
    onSuccess: async (res) => {
      setResult(res);
      toast.success(t('pricing.bulk.applied', { count: res.changes.length }));
      await qc.invalidateQueries({ queryKey: ['admin', 'pricing'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (result) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="md"
        title={t('pricing.bulk.doneTitle')}
        description={t('pricing.bulk.applied', { count: result.changes.length })}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('common:actions.done')}
          </Button>
        }
      >
        {result.changes.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {result.changes.map((c) => {
              const p = payers.find((x) => x.id === c.payerGroupId);
              return (
                <li key={c.payerGroupId} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className="flex items-center gap-2">
                    <Check className="size-4 text-ok" />
                    {p ? bi(p, 'name') : c.code}
                  </span>
                  <span className="tabular ltr-num text-ink-2">
                    {f.money(c.before)} → <span className="font-semibold text-ink">{f.money(c.after)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">{t('pricing.bulk.nothing')}</p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t('pricing.bulk.title')}
      description={t('pricing.bulk.description')}
      footer={
        <>
          <span className="me-auto text-[12.5px] text-muted">{v !== null ? t('pricing.bulk.willChange', { count: effective }) : null}</span>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={apply.isPending} disabled={v === null || !!valueError || !selected.length || !effective} onClick={() => apply.mutate()}>
            {t('pricing.bulk.apply')}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col gap-3">
          <Field label={t('pricing.bulk.mode')}>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'percent', label: t('pricing.bulk.percent') },
                { value: 'set', label: t('pricing.bulk.set') },
              ]}
            />
          </Field>
          <NumberField
            label={mode === 'percent' ? t('pricing.bulk.percentLabel') : t('pricing.bulk.setLabel')}
            hint={mode === 'percent' ? t('pricing.bulk.percentHint') : undefined}
            value={value}
            onChange={setValue}
            suffix={mode === 'percent' ? '%' : f.currencyLabel()}
            error={valueError}
            required
          />
          <Field label={t('pricing.bulk.roundTo')} hint={t('pricing.bulk.roundHint')}>
            {(id) => (
              <Select
                id={id}
                value={roundTo}
                onValueChange={setRoundTo}
                options={ROUNDING.map((r) => ({ value: String(r), label: r === 1 ? t('pricing.bulk.noRounding') : f.money(r) }))}
              />
            )}
          </Field>
          <Field label={t('fields.reason')} hint={t('pricing.bulk.reasonHint')}>
            {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
          </Field>
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink-2">{t('fields.payerGroupIds')}</span>
            <Button variant="link" size="sm" onClick={() => setSelected(selected.length === active.length ? [] : active.map((p) => p.id))}>
              {selected.length === active.length ? t('pricing.bulk.none') : t('common:actions.selectAll')}
            </Button>
          </div>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-sunken text-[11.5px] text-muted">
                <tr>
                  <th className="px-3 py-1.5 text-start font-semibold">{t('pricing.bulk.payer')}</th>
                  <th className="px-3 py-1.5 text-end font-semibold">{t('pricing.bulk.before')}</th>
                  <th className="px-3 py-1.5 text-end font-semibold">{t('pricing.bulk.after')}</th>
                </tr>
              </thead>
              <tbody>
                {active.map((p) => {
                  const row = preview.find((r) => r.payer.id === p.id);
                  const on = selected.includes(p.id);
                  return (
                    <tr key={p.id} className={cn('border-t border-line', !on && 'text-muted')}>
                      <td className="px-3 py-1.5">
                        <Checkbox
                          checked={on}
                          onCheckedChange={(c) => setSelected((s) => (c ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                          label={
                            <span className="inline-flex items-center gap-1.5">
                              {bi(p, 'name')}
                              <Badge tone="muted">{t(`kinds.${p.kind}`)}</Badge>
                            </span>
                          }
                        />
                      </td>
                      <td className="px-3 py-1.5 text-end tabular ltr-num">{f.money(p.unitPrice)}</td>
                      <td className="px-3 py-1.5 text-end tabular ltr-num">
                        {row ? (
                          <span className={cn(row.after !== row.before && 'font-semibold text-ink')}>
                            {f.money(row.after)}
                            {row.change !== null && row.after !== row.before ? <span className="ms-1 text-[11.5px] font-normal text-muted">({row.change > 0 ? '+' : ''}{f.number(row.change, 1)}%)</span> : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12px] text-muted">{t('pricing.bulk.note')}</p>
        </div>
      </div>
    </Dialog>
  );
}
