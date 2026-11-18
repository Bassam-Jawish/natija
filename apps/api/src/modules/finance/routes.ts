import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminIdParam,
  adminListQuery,
  adminRangeQuery,
  FinanceCloseSessionInput,
  FinanceDecideInput,
  FinanceExpenseCategoryInput,
  FinanceExpenseInput,
  FinanceOpenSessionInput,
  FinanceRefundInput,
  isoDate,
} from '@natija/contracts';
import { parse } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { buildWorkbook, L, sendWorkbook } from '../analytics/excel';
import * as svc from './service';

const uuid = z.string().uuid();

/** Back office money: cash sessions, payments, invoices, statements, refunds, approvals, expenses, summary. */
export default async function financeRoutes(app: FastifyInstance) {
  const read = { config: { perm: 'finance.read' as const } };
  const cashier = { config: { perm: ['finance.cash', 'finance.payment'] as Array<'finance.cash' | 'finance.payment'> } };
  const expensesPerm = { config: { perm: 'finance.expenses' as const } };
  const id = (req: { params: unknown }) => parse(adminIdParam, req.params).id;

  /* ---------------------------------------------------------------- cash sessions */

  app.get('/cash-sessions/current', cashier, async () => svc.currentSession());
  app.post('/cash-sessions', cashier, async (req, reply) => reply.status(201).send(await svc.openSession(parse(FinanceOpenSessionInput, req.body))));
  app.post('/cash-sessions/:id/close', cashier, async (req) =>
    svc.closeSession(id(req), parse(FinanceCloseSessionInput, req.body), { canSupervise: req.auth!.permissions.has('finance.approve') }),
  );
  app.get('/cash-sessions', read, async (req) =>
    svc.listSessions(parse(adminListQuery.extend({ status: z.enum(['open', 'closed']).optional(), userId: uuid.optional() }), req.query)),
  );
  app.get('/cash-sessions/:id', { config: { perm: ['finance.read', 'finance.cash', 'finance.payment'] } }, async (req) =>
    svc.getSession(id(req), { canReadAll: req.auth!.permissions.has('finance.read') }),
  );

  /* ---------------------------------------------------------------- payments & invoices */

  app.get('/payments', read, async (req) => {
    const q = parse(
      adminListQuery.extend({
        methodId: uuid.optional(),
        kind: z.enum(['payment', 'refund']).optional(),
        userId: uuid.optional(),
        sessionId: uuid.optional(),
        mine: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    return svc.listPayments({ ...q, userId: q.mine === 'true' ? req.auth!.userId : q.userId });
  });

  app.get('/invoices', read, async (req) =>
    svc.listInvoices(
      parse(
        adminListQuery.extend({
          status: z.enum(['open', 'partial', 'paid', 'void', 'due']).optional(),
          payerGroupId: uuid.optional(),
          payerKind: z.enum(['public', 'insurer', 'client_lab', 'other']).optional(),
        }),
        req.query,
      ),
    ),
  );

  /* ---------------------------------------------------------------- statements */

  const statementQuery = z.object({ payerGroupId: uuid, from: isoDate.optional(), to: isoDate.optional() });
  app.get('/statements', read, async (req) => {
    const q = parse(statementQuery, req.query);
    return svc.statement(q.payerGroupId, q.from, q.to);
  });

  app.get('/statements/export', read, async (req, reply) => {
    const q = parse(statementQuery.extend({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
    const st = await svc.statement(q.payerGroupId, q.from, q.to);
    const lab = await getLab(req.auth!.labId);
    const lang = q.lang;
    const nm = (ar: string | null, en: string | null) => (lang === 'ar' ? ar || en : en || ar) ?? '';
    const buffer = await buildWorkbook(
      [
        {
          name: L(lang, 'Statement', 'كشف حساب'),
          title: `${nm(lab.nameAr, lab.nameEn)} · ${L(lang, 'Statement of account', 'كشف حساب')} · ${nm(st.payer.nameAr, st.payer.nameEn)}`,
          subtitle: `${st.payer.organization ? `${st.payer.organization} · ` : ''}${st.from} → ${st.to}`,
          columns: [
            { header: L(lang, 'Date', 'التاريخ'), key: 'createdAt', format: 'date', width: 12 },
            { header: L(lang, 'Invoice', 'الفاتورة'), key: 'number', width: 18 },
            { header: L(lang, 'Order', 'الطلب'), key: 'accession', width: 14 },
            { header: L(lang, 'Patient', 'المريض'), key: 'patient', width: 30 },
            { header: L(lang, 'File no.', 'رقم الملف'), key: 'mrn', width: 12 },
            { header: L(lang, 'Gross', 'الإجمالي'), key: 'subtotal', format: 'money', width: 14 },
            { header: L(lang, 'Discount', 'الحسم'), key: 'discountTotal', format: 'money', width: 12 },
            { header: L(lang, 'Patient share', 'حصة المريض'), key: 'patientTotal', format: 'money', width: 14 },
            { header: L(lang, 'Payer share', 'حصة الجهة'), key: 'insurerTotal', format: 'money', width: 14 },
            { header: L(lang, 'Paid by patient', 'مدفوع من المريض'), key: 'paidTotal', format: 'money', width: 14 },
          ],
          rows: st.invoices.map((i) => ({ ...i, patient: nm(i.patientNameAr, i.patientNameEn) })),
          totals: { createdAt: null, number: L(lang, 'Total', 'المجموع'), ...st.totals, patient: `${st.totals.count}` },
        },
      ],
      { lang, currency: lab.currency },
    );
    return sendWorkbook(reply, buffer, `natija-statement-${st.payer.code}-${st.from}_${st.to}.xlsx`);
  });

  /* ---------------------------------------------------------------- refunds & approvals */

  app.post('/refunds', { config: { perm: 'finance.refund' } }, async (req, reply) => {
    const result = await svc.refund(parse(FinanceRefundInput, req.body));
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/approvals', { config: { perm: ['finance.approve', 'finance.read'] } }, async (req) =>
    svc.listApprovals(
      parse(
        adminListQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).optional(), kind: z.enum(['discount', 'free', 'refund', 'cancel']).optional() }),
        req.query,
      ),
    ),
  );
  app.post('/approvals/:id/decide', { config: { perm: 'finance.approve' } }, async (req) => svc.decideApproval(id(req), parse(FinanceDecideInput, req.body)));

  /* ---------------------------------------------------------------- expenses */

  const expenseRead = { config: { perm: ['finance.expenses', 'finance.read'] as Array<'finance.expenses' | 'finance.read'> } };
  app.get('/expense-categories', expenseRead, async () => svc.listExpenseCategories());
  app.post('/expense-categories', expensesPerm, async (req) => svc.createExpenseCategory(parse(FinanceExpenseCategoryInput, req.body)));
  app.put('/expense-categories/:id', expensesPerm, async (req) => svc.updateExpenseCategory(id(req), parse(FinanceExpenseCategoryInput, req.body)));
  app.delete('/expense-categories/:id', expensesPerm, async (req) => svc.deleteExpenseCategory(id(req)));

  app.get('/expenses', expenseRead, async (req) => svc.listExpenses(parse(adminListQuery.extend({ categoryId: uuid.optional() }), req.query)));
  app.post('/expenses', expensesPerm, async (req, reply) => reply.status(201).send(await svc.createExpense(parse(FinanceExpenseInput, req.body))));
  app.delete('/expenses/:id', expensesPerm, async (req) => svc.deleteExpense(id(req)));

  /* ---------------------------------------------------------------- summary */

  app.get('/summary', read, async (req) => {
    const q = parse(adminRangeQuery, req.query);
    return svc.summary(q.from, q.to);
  });
}
