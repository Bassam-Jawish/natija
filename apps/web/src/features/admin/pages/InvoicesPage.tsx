import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { FilterBar, useRangeParam, useTabParam } from '../components/common';
import { InvoiceDrawer } from '../components/finance/InvoiceDrawer';
import { InvoicesTab } from '../components/finance/InvoicesTab';
import { SessionsTab } from '../components/finance/SessionsTab';
import { StatementsTab } from '../components/finance/StatementsTab';

const TABS = ['invoices', 'statements', 'sessions'] as const;

export default function InvoicesPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(TABS, 'invoices');
  const [range, setRange] = useRangeParam(tab === 'statements' ? 29 : 6);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title={t('finance.invoices.title')} description={t('finance.invoices.description')} />
      <FilterBar range={range} onRange={setRange} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map((x) => (
            <TabsTrigger key={x} value={x}>
              {t(`finance.invoices.tabs.${x}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="invoices">{tab === 'invoices' ? <InvoicesTab range={range} onOpen={setOpen} /> : null}</TabsContent>
        <TabsContent value="statements">{tab === 'statements' ? <StatementsTab range={range} onOpen={setOpen} /> : null}</TabsContent>
        <TabsContent value="sessions">{tab === 'sessions' ? <SessionsTab range={range} /> : null}</TabsContent>
      </Tabs>
      <InvoiceDrawer invoiceId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
