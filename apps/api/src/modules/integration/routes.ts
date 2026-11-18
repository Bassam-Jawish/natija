/**
 * Review queue for analyzer values that could not be applied automatically (unknown tube,
 * unknown code, nothing ordered, rejected tube, result already validated), plus the
 * integration overview and event log.
 */
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  analytes,
  instrumentMappings,
  instruments,
  integrationMessages,
  orderItems,
  orders,
  results,
  reviewItems,
  samples,
  users,
} from '@natija/db';
import {
  eventsQuery,
  INTEGRATION_LEVELS,
  REVIEW_REASONS,
  reviewAssignBody,
  reviewDismissBody,
  reviewListQuery,
  type IntegrationOverview,
  type ReviewCandidate,
  type ReviewDetail,
  type ReviewItem,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { assertFound, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange, page, parse } from '../../lib/http';
import { applyResultValue } from '../../services/results-engine';
import { convertValue, iso, markTubeInAnalysis } from '../../services/ingest';
import { listEvents, AGENT_ONLINE_MS } from '../instruments/serialize';

const idParams = z.object({ id: z.string().uuid() });

const reviewSelect = {
  r: reviewItems,
  inst: { id: instruments.id, code: instruments.code, name: instruments.name, model: instruments.model },
  receivedAt: integrationMessages.receivedAt,
  isSimulated: integrationMessages.isSimulated,
  resolverAr: users.fullNameAr,
  resolverEn: users.fullNameEn,
};

type ReviewRow = {
  r: typeof reviewItems.$inferSelect;
  inst: { id: string; code: string; name: string; model: (typeof instruments.$inferSelect)['model'] };
  receivedAt: Date | null;
  isSimulated: boolean | null;
  resolverAr: string | null;
  resolverEn: string | null;
};

function reviewItem(row: ReviewRow): ReviewItem {
  const r = row.r;
  return {
    id: r.id,
    instrument: row.inst,
    messageId: r.messageId,
    messageReceivedAt: iso(row.receivedAt),
    isSimulated: row.isSimulated ?? false,
    sampleBarcode: r.sampleBarcode,
    instrumentCode: r.instrumentCode,
    valueText: r.valueText,
    unit: r.unit,
    flags: r.flags,
    reason: r.reason,
    status: r.status,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: iso(r.resolvedAt),
    resolvedBy: r.resolvedBy ? { id: r.resolvedBy, fullNameAr: row.resolverAr ?? '', fullNameEn: row.resolverEn ?? '' } : null,
    assignedResultId: r.assignedResultId,
  };
}

function reviewQuery() {
  return db()
    .select(reviewSelect)
    .from(reviewItems)
    .innerJoin(instruments, eq(instruments.id, reviewItems.instrumentId))
    .leftJoin(integrationMessages, eq(integrationMessages.id, reviewItems.messageId))
    .leftJoin(users, eq(users.id, reviewItems.resolvedBy));
}

async function loadReview(id: string): Promise<ReviewRow> {
  const [row] = await reviewQuery().where(eq(reviewItems.id, id));
  return assertFound(row, 'review_item_not_found');
}

export default async function integrationRoutes(app: FastifyInstance) {
  app.get('/overview', { config: { perm: ['integration.review', 'instruments.read'] } }, async (): Promise<IntegrationOverview> => {
    const { labId } = ctx();
    const instRows = await db()
      .select({ status: instruments.status, level: instruments.integrationLevel, n: count() })
      .from(instruments)
      .where(eq(instruments.isActive, true))
      .groupBy(instruments.status, instruments.integrationLevel);
    const byStatus = (s: string) => instRows.filter((r) => r.status === s).reduce((n, r) => n + r.n, 0);
    const byLevel = Object.fromEntries(INTEGRATION_LEVELS.map((l) => [l, instRows.filter((r) => r.level === l).reduce((n, r) => n + r.n, 0)])) as IntegrationOverview['instruments']['byLevel'];

    const { start } = await dayRange();
    const msgRows = await db()
      .select({ status: integrationMessages.status, simulated: integrationMessages.isSimulated, n: count() })
      .from(integrationMessages)
      .where(gte(integrationMessages.receivedAt, start))
      .groupBy(integrationMessages.status, integrationMessages.isSimulated);
    const msgBy = (s: string) => msgRows.filter((r) => r.status === s).reduce((n, r) => n + r.n, 0);

    const reviewRows = await db().select({ reason: reviewItems.reason, n: count() }).from(reviewItems).where(eq(reviewItems.status, 'open')).groupBy(reviewItems.reason);
    const byReason = Object.fromEntries(REVIEW_REASONS.map((r) => [r, reviewRows.find((x) => x.reason === r)?.n ?? 0])) as IntegrationOverview['review']['byReason'];

    const agentRows = await db()
      .select({ status: agents.status, isVirtual: agents.isVirtual, lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(and(eq(agents.labId, labId), eq(agents.isVirtual, false)));
    const recent = await listEvents({ limit: 20, offset: 0 });
    return {
      instruments: { total: instRows.reduce((n, r) => n + r.n, 0), online: byStatus('online'), offline: byStatus('offline'), error: byStatus('error'), unknown: byStatus('unknown'), byLevel },
      messagesToday: {
        total: msgRows.reduce((n, r) => n + r.n, 0),
        processed: msgBy('processed'),
        partial: msgBy('partial'),
        unmatched: msgBy('unmatched'),
        duplicate: msgBy('duplicate'),
        error: msgBy('error'),
        simulated: msgRows.filter((r) => r.simulated).reduce((n, r) => n + r.n, 0),
      },
      review: { open: reviewRows.reduce((n, r) => n + r.n, 0), byReason },
      agents: {
        total: agentRows.length,
        active: agentRows.filter((a) => a.status === 'active').length,
        pending: agentRows.filter((a) => a.status === 'pending').length,
        online: agentRows.filter((a) => a.status === 'active' && a.lastHeartbeatAt && Date.now() - a.lastHeartbeatAt.getTime() < AGENT_ONLINE_MS).length,
      },
      recentEvents: recent.items,
    };
  });

  app.get('/events', { config: { perm: ['integration.review', 'instruments.read'] } }, async (req) => {
    const q = parse(eventsQuery, req.query);
    return listEvents({ instrumentId: q.instrumentId, agentId: q.agentId, level: q.level, limit: q.limit, offset: q.offset });
  });

  app.get('/review', { config: { perm: 'integration.review' } }, async (req) => {
    const q = parse(reviewListQuery, req.query);
    const conditions: SQL[] = [];
    if (q.status !== 'all') conditions.push(eq(reviewItems.status, q.status));
    if (q.reason) conditions.push(eq(reviewItems.reason, q.reason));
    if (q.instrumentId) conditions.push(eq(reviewItems.instrumentId, q.instrumentId));
    if (q.q) {
      const prefix = `${q.q.replace(/[%_]/g, '')}%`;
      conditions.push(or(ilike(reviewItems.sampleBarcode, prefix), ilike(reviewItems.instrumentCode, prefix))!);
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await reviewQuery().where(where).orderBy(desc(reviewItems.createdAt)).limit(q.limit).offset(q.offset);
    const [total] = await db().select({ n: count() }).from(reviewItems).where(where);
    return page(rows.map(reviewItem), total?.n ?? 0);
  });

  app.get('/review/:id', { config: { perm: 'integration.review' } }, async (req): Promise<ReviewDetail> => {
    const { id } = parse(idParams, req.params);
    const row = await loadReview(id);
    const item = row.r;
    const [mapping] = item.instrumentCode
      ? await db()
          .select({ analyteId: instrumentMappings.analyteId, analyteCode: analytes.code, unitFactor: instrumentMappings.unitFactor, instrumentUnit: instrumentMappings.instrumentUnit })
          .from(instrumentMappings)
          .innerJoin(analytes, eq(analytes.id, instrumentMappings.analyteId))
          .where(and(eq(instrumentMappings.instrumentId, item.instrumentId), eq(instrumentMappings.instrumentCode, item.instrumentCode)))
      : [];
    const [sample] = item.sampleBarcode
      ? await db()
          .select({ id: samples.id, barcode: samples.barcode, status: samples.status, orderId: samples.orderId, accession: orders.accession })
          .from(samples)
          .innerJoin(orders, eq(orders.id, samples.orderId))
          .where(eq(samples.barcode, item.sampleBarcode))
      : [];

    // Results a reviewer may assign the value to: the tube's order, or recent pending results of the mapped analyte.
    let candidateWhere: SQL | undefined;
    if (sample) candidateWhere = eq(results.orderId, sample.orderId);
    else if (mapping) candidateWhere = and(eq(results.analyteId, mapping.analyteId), inArray(results.status, ['pending', 'resulted']), gte(results.createdAt, new Date(Date.now() - 7 * 86_400_000)));
    const candidateRows = candidateWhere
      ? await db()
          .select({
            resultId: results.id,
            orderId: results.orderId,
            accession: orders.accession,
            analyte: { id: analytes.id, code: analytes.code, nameEn: analytes.nameEn, nameAr: analytes.nameAr, unit: analytes.unit },
            status: results.status,
            valueNum: results.valueNum,
            valueText: results.valueText,
            sampleBarcode: samples.barcode,
          })
          .from(results)
          .innerJoin(orders, eq(orders.id, results.orderId))
          .innerJoin(analytes, eq(analytes.id, results.analyteId))
          .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
          .leftJoin(samples, eq(samples.id, orderItems.sampleId))
          .where(and(candidateWhere, sql`${orderItems.status} <> 'cancelled'`))
          .orderBy(desc(orders.createdAt), analytes.sortOrder)
          .limit(60)
      : [];
    const candidates: ReviewCandidate[] = candidateRows
      .map((c) => ({ ...c, sampleBarcode: c.sampleBarcode ?? null, isMappedAnalyte: !!mapping && c.analyte.id === mapping.analyteId }))
      .sort((a, b) => Number(b.isMappedAnalyte) - Number(a.isMappedAnalyte));
    return { ...reviewItem(row), sample: sample ?? null, mapping: mapping ?? null, candidates };
  });

  /** Put the value on a result (through the results engine) and close the item. */
  app.post('/review/:id/assign', { config: { perm: 'integration.review' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(reviewAssignBody, req.body);
    const auth = req.auth!;
    const [item] = await db().select().from(reviewItems).where(eq(reviewItems.id, id)).for('update');
    if (!item) throw notFound('review_item_not_found');
    if (item.status !== 'open') throw conflict('review_item_closed', `This item is already ${item.status}`);
    const [target] = await db()
      .select({ r: results, analyteCode: analytes.code, accession: orders.accession, sampleId: orderItems.sampleId })
      .from(results)
      .innerJoin(analytes, eq(analytes.id, results.analyteId))
      .innerJoin(orders, eq(orders.id, results.orderId))
      .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
      .where(eq(results.id, body.resultId));
    if (!target) throw badRequest('result_not_found');
    if (target.r.status === 'validated' || target.r.status === 'released') {
      throw conflict('result_locked', 'The result is already validated; amend it from the results screen instead');
    }
    const [mapping] = item.instrumentCode
      ? await db().select().from(instrumentMappings).where(and(eq(instrumentMappings.instrumentId, item.instrumentId), eq(instrumentMappings.instrumentCode, item.instrumentCode)))
      : [];
    if (body.rememberMapping) {
      if (!auth.permissions.has('instruments.manage')) throw forbidden('permission', 'Needs instruments.manage to add a code mapping');
      if (!item.instrumentCode) throw badRequest('no_instrument_code');
      if (mapping) throw conflict('mapping_exists', `${item.instrumentCode} is already mapped`);
      const [created] = await db()
        .insert(instrumentMappings)
        .values({ labId: ctx().labId, instrumentId: item.instrumentId, instrumentCode: item.instrumentCode, analyteId: target.r.analyteId, unitFactor: 1, instrumentUnit: item.unit })
        .returning();
      await audit({ action: 'instrument.mapping_create', entityType: 'instrument_mapping', entityId: created!.id, summary: `${item.instrumentCode} → ${target.analyteCode} (from the review queue)`, after: created });
    }
    const received = item.valueText ?? '';
    const value = body.value ?? (mapping && mapping.analyteId === target.r.analyteId ? convertValue(received, mapping.unitFactor) : received.trim());
    if (!value) throw badRequest('no_value', 'The item has no value; enter one');
    const out = await applyResultValue({
      resultId: target.r.id,
      value,
      source: 'instrument',
      instrumentId: item.instrumentId,
      messageId: item.messageId,
      rawFlag: item.flags,
      note: `Assigned from the review queue (${item.reason})${body.note ? `: ${body.note}` : ''}`,
    });
    if (out.locked) throw conflict('result_locked');
    if (target.sampleId) {
      const [tube] = await db().select({ id: samples.id, status: samples.status }).from(samples).where(eq(samples.id, target.sampleId));
      const [inst] = await db().select({ code: instruments.code }).from(instruments).where(eq(instruments.id, item.instrumentId));
      if (tube) await markTubeInAnalysis(tube, inst?.code ?? 'analyzer');
    }
    const now = new Date();
    await db()
      .update(reviewItems)
      .set({ status: 'assigned', resolvedBy: auth.userId, resolvedAt: now, assignedResultId: target.r.id, note: body.note ?? item.note })
      .where(eq(reviewItems.id, id));
    await audit({
      action: 'integration.review_assign',
      entityType: 'review_item',
      entityId: id,
      summary: `${item.instrumentCode ?? '?'} = ${received} (${item.sampleBarcode ?? 'no barcode'}) → ${target.accession} ${target.analyteCode} = ${value}`,
      before: { status: 'open', reason: item.reason },
      after: { status: 'assigned', resultId: target.r.id, value, rememberMapping: !!body.rememberMapping },
    });
    publish({ type: 'integration.message', data: { reviewItemId: id, status: 'assigned', instrumentId: item.instrumentId } });
    return { ok: true, resultId: target.r.id, orderId: out.orderId, value, flag: out.flag, isCritical: out.isCritical };
  });

  app.post('/review/:id/dismiss', { config: { perm: 'integration.review' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(reviewDismissBody, req.body);
    const [item] = await db().select().from(reviewItems).where(eq(reviewItems.id, id)).for('update');
    if (!item) throw notFound('review_item_not_found');
    if (item.status !== 'open') throw conflict('review_item_closed', `This item is already ${item.status}`);
    await db().update(reviewItems).set({ status: 'dismissed', resolvedBy: req.auth!.userId, resolvedAt: new Date(), note: body.note }).where(eq(reviewItems.id, id));
    await audit({
      action: 'integration.review_dismiss',
      entityType: 'review_item',
      entityId: id,
      summary: `${item.instrumentCode ?? '?'} = ${item.valueText ?? ''} (${item.sampleBarcode ?? 'no barcode'}, ${item.reason}) dismissed: ${body.note}`,
      before: { status: 'open' },
      after: { status: 'dismissed', note: body.note },
    });
    publish({ type: 'integration.message', data: { reviewItemId: id, status: 'dismissed', instrumentId: item.instrumentId } });
    return reviewItem(await loadReview(id));
  });
}
