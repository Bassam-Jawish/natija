/**
 * /integration routes (port of apps/api/src/modules/integration/routes.ts): the review queue for
 * analyzer values that could not be applied automatically (unknown tube, unknown code, unit
 * mismatch, nothing ordered, rejected tube, result already validated), plus the integration
 * overview and event log.
 */
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
import { badRequest, conflict, ctx, forbidden, notFound, now } from '../../core/context';
import { by, find, insert, rows, update, type Row } from '../../core/db';
import { audit, dayRange, page, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { applyResultValue } from '../shared/results-engine';
import { newestFirst } from './helpers';
import { convertValue, iso, markTubeInAnalysis } from './ingest';
import { markSilentInstrumentsOffline } from './offline';
import { AGENT_ONLINE_MS, listEvents } from './serialize';

function reviewItem(r: Row<'reviewItems'>, inst: Row<'instruments'>): ReviewItem {
  const message = r.messageId ? find('integrationMessages', r.messageId) : undefined;
  const resolver = r.resolvedBy ? find('users', r.resolvedBy) : undefined;
  return {
    id: r.id,
    instrument: { id: inst.id, code: inst.code, name: inst.name, model: inst.model },
    messageId: r.messageId,
    messageReceivedAt: iso(message?.receivedAt),
    isSimulated: message?.isSimulated ?? false,
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
    resolvedBy: r.resolvedBy ? { id: r.resolvedBy, fullNameAr: resolver?.fullNameAr ?? '', fullNameEn: resolver?.fullNameEn ?? '' } : null,
    assignedResultId: r.assignedResultId,
  };
}

/** The review item with its instrument (inner join, as on the server). */
function loadReview(id: string | undefined): { r: Row<'reviewItems'>; inst: Row<'instruments'> } {
  const r = find('reviewItems', id);
  const inst = r ? find('instruments', r.instrumentId) : undefined;
  if (!r || !inst) throw notFound('review_item_not_found');
  return { r, inst };
}

const startsWith = (value: string | null, prefix: string) => value !== null && value.toLowerCase().startsWith(prefix);

export function registerIntegrationRoutes(): void {
  route('GET', '/integration/overview', { perm: ['integration.review', 'instruments.read'] }, (): IntegrationOverview => {
    markSilentInstrumentsOffline();
    const active = rows('instruments').filter((i) => i.isActive);
    const byStatus = (s: string) => active.filter((i) => i.status === s).length;
    const byLevel = Object.fromEntries(INTEGRATION_LEVELS.map((l) => [l, active.filter((i) => i.integrationLevel === l).length])) as IntegrationOverview['instruments']['byLevel'];

    const { start } = dayRange();
    const today = rows('integrationMessages').filter((m) => m.receivedAt.getTime() >= start.getTime());
    const msgBy = (s: string) => today.filter((m) => m.status === s).length;

    const open = by('reviewItems', 'status', 'open');
    const byReason = Object.fromEntries(REVIEW_REASONS.map((r) => [r, open.filter((x) => x.reason === r).length])) as IntegrationOverview['review']['byReason'];

    const agentRows = rows('agents').filter((a) => !a.isVirtual);
    const nowMs = now().getTime();
    return {
      instruments: { total: active.length, online: byStatus('online'), offline: byStatus('offline'), error: byStatus('error'), unknown: byStatus('unknown'), byLevel },
      messagesToday: {
        total: today.length,
        processed: msgBy('processed'),
        partial: msgBy('partial'),
        unmatched: msgBy('unmatched'),
        duplicate: msgBy('duplicate'),
        error: msgBy('error'),
        simulated: today.filter((m) => m.isSimulated).length,
      },
      review: { open: open.length, byReason },
      agents: {
        total: agentRows.length,
        active: agentRows.filter((a) => a.status === 'active').length,
        pending: agentRows.filter((a) => a.status === 'pending').length,
        online: agentRows.filter((a) => a.status === 'active' && a.lastHeartbeatAt && nowMs - a.lastHeartbeatAt.getTime() < AGENT_ONLINE_MS).length,
      },
      recentEvents: listEvents({ limit: 20, offset: 0 }).items,
    };
  });

  route('GET', '/integration/events', { perm: ['integration.review', 'instruments.read'] }, (req) => {
    const q = parse(eventsQuery, req.query);
    return listEvents({ instrumentId: q.instrumentId, agentId: q.agentId, level: q.level, limit: q.limit, offset: q.offset });
  });

  route('GET', '/integration/review', { perm: 'integration.review' }, (req) => {
    const q = parse(reviewListQuery, req.query);
    const status = q.status ?? 'open';
    const prefix = q.q ? q.q.replace(/[%_]/g, '').toLowerCase() : null;
    const source = status !== 'all' ? by('reviewItems', 'status', status) : rows('reviewItems');
    const matching = source.filter(
      (r) =>
        (!q.reason || r.reason === q.reason) &&
        (!q.instrumentId || r.instrumentId === q.instrumentId) &&
        (prefix === null || startsWith(r.sampleBarcode, prefix) || startsWith(r.instrumentCode, prefix)),
    );
    const items = newestFirst(matching, (r) => r.createdAt)
      .slice(q.offset, q.offset + q.limit)
      .flatMap((r) => {
        const inst = find('instruments', r.instrumentId);
        return inst ? [reviewItem(r, inst)] : [];
      });
    return page(items, matching.length);
  });

  route('GET', '/integration/review/:id', { perm: 'integration.review' }, (req): ReviewDetail => {
    const { r: item, inst } = loadReview(req.params.id);
    const mapRow = item.instrumentCode ? by('instrumentMappings', 'instrumentId', item.instrumentId).find((m) => m.instrumentCode === item.instrumentCode && !!find('analytes', m.analyteId)) : undefined;
    const mapAnalyte = mapRow ? find('analytes', mapRow.analyteId) : undefined;
    const mapping = mapRow && mapAnalyte ? { analyteId: mapRow.analyteId, analyteCode: mapAnalyte.code, unitFactor: mapRow.unitFactor, instrumentUnit: mapRow.instrumentUnit } : null;
    const tube = item.sampleBarcode ? by('samples', 'barcode', item.sampleBarcode)[0] : undefined;
    const tubeOrder = tube ? find('orders', tube.orderId) : undefined;
    const sample = tube && tubeOrder ? { id: tube.id, barcode: tube.barcode, status: tube.status, orderId: tube.orderId, accession: tubeOrder.accession } : null;

    // Results a reviewer may assign the value to: the tube's order, or recent pending results of the mapped analyte.
    let base: Array<Row<'results'>> = [];
    if (sample) base = by('results', 'orderId', sample.orderId);
    else if (mapping) {
      const since = now().getTime() - 7 * 86_400_000;
      base = by('results', 'analyteId', mapping.analyteId).filter((r) => (r.status === 'pending' || r.status === 'resulted') && r.createdAt.getTime() >= since);
    }
    const joined = base.flatMap((r) => {
      const order = find('orders', r.orderId);
      const analyte = find('analytes', r.analyteId);
      const line = find('orderItems', r.orderItemId);
      if (!order || !analyte || !line || line.status === 'cancelled') return [];
      const lineTube = line.sampleId ? find('samples', line.sampleId) : undefined;
      return [{ r, order, analyte, sampleBarcode: lineTube?.barcode ?? null }];
    });
    joined.sort((a, b) => b.order.createdAt.getTime() - a.order.createdAt.getTime() || a.analyte.sortOrder - b.analyte.sortOrder);
    const candidates: ReviewCandidate[] = joined
      .slice(0, 60)
      .map((c) => ({
        resultId: c.r.id,
        orderId: c.r.orderId,
        accession: c.order.accession,
        analyte: { id: c.analyte.id, code: c.analyte.code, nameEn: c.analyte.nameEn, nameAr: c.analyte.nameAr, unit: c.analyte.unit },
        status: c.r.status,
        valueNum: c.r.valueNum,
        valueText: c.r.valueText,
        sampleBarcode: c.sampleBarcode,
        isMappedAnalyte: !!mapping && c.analyte.id === mapping.analyteId,
      }))
      .sort((a, b) => Number(b.isMappedAnalyte) - Number(a.isMappedAnalyte));
    return { ...reviewItem(item, inst), sample, mapping, candidates };
  });

  /** Put the value on a result (through the results engine) and close the item. */
  route('POST', '/integration/review/:id/assign', { perm: 'integration.review' }, (req) => {
    const body = parse(reviewAssignBody, req.body);
    const auth = req.auth!;
    const item = find('reviewItems', req.params.id);
    if (!item) throw notFound('review_item_not_found');
    if (item.status !== 'open') throw conflict('review_item_closed', `This item is already ${item.status}`);
    const result = find('results', body.resultId);
    const analyte = result ? find('analytes', result.analyteId) : undefined;
    const order = result ? find('orders', result.orderId) : undefined;
    const line = result ? find('orderItems', result.orderItemId) : undefined;
    if (!result || !analyte || !order || !line) throw badRequest('result_not_found');
    if (result.status === 'validated' || result.status === 'released') {
      throw conflict('result_locked', 'The result is already validated; amend it from the results screen instead');
    }
    const mapping = item.instrumentCode ? by('instrumentMappings', 'instrumentId', item.instrumentId).find((m) => m.instrumentCode === item.instrumentCode) : undefined;
    if (body.rememberMapping) {
      if (!auth.permissions.has('instruments.manage')) throw forbidden('permission', 'Needs instruments.manage to add a code mapping');
      if (!item.instrumentCode) throw badRequest('no_instrument_code');
      if (mapping) throw conflict('mapping_exists', `${item.instrumentCode} is already mapped`);
    }
    const received = item.valueText ?? '';
    const value = body.value ?? (mapping && mapping.analyteId === result.analyteId ? convertValue(received, mapping.unitFactor) : received.trim());
    if (!value) throw badRequest('no_value', 'The item has no value; enter one');
    // Written after every check that can refuse (the server would roll the mapping back).
    if (body.rememberMapping && item.instrumentCode) {
      const created = insert('instrumentMappings', { labId: ctx().labId, instrumentId: item.instrumentId, instrumentCode: item.instrumentCode, analyteId: result.analyteId, unitFactor: 1, instrumentUnit: item.unit });
      audit({ action: 'instrument.mapping_create', entityType: 'instrument_mapping', entityId: created.id, summary: `${item.instrumentCode} → ${analyte.code} (from the review queue)`, after: { ...created } });
    }
    const out = applyResultValue({
      resultId: result.id,
      value,
      source: 'instrument',
      instrumentId: item.instrumentId,
      messageId: item.messageId,
      rawFlag: item.flags,
      note: `Assigned from the review queue (${item.reason})${body.note ? `: ${body.note}` : ''}`,
    });
    if (out.locked) throw conflict('result_locked');
    if (line.sampleId) {
      const tube = find('samples', line.sampleId);
      const inst = find('instruments', item.instrumentId);
      if (tube) markTubeInAnalysis(tube, inst?.code ?? 'analyzer');
    }
    update('reviewItems', item, { status: 'assigned', resolvedBy: auth.userId, resolvedAt: now(), assignedResultId: result.id, note: body.note ?? item.note });
    audit({
      action: 'integration.review_assign',
      entityType: 'review_item',
      entityId: item.id,
      summary: `${item.instrumentCode ?? '?'} = ${received} (${item.sampleBarcode ?? 'no barcode'}) → ${order.accession} ${analyte.code} = ${value}`,
      before: { status: 'open', reason: item.reason },
      after: { status: 'assigned', resultId: result.id, value, rememberMapping: !!body.rememberMapping },
    });
    publish({ type: 'integration.message', data: { reviewItemId: item.id, status: 'assigned', instrumentId: item.instrumentId } });
    return { ok: true, resultId: result.id, orderId: out.orderId, value, flag: out.flag, isCritical: out.isCritical };
  });

  route('POST', '/integration/review/:id/dismiss', { perm: 'integration.review' }, (req) => {
    const body = parse(reviewDismissBody, req.body);
    const item = find('reviewItems', req.params.id);
    if (!item) throw notFound('review_item_not_found');
    if (item.status !== 'open') throw conflict('review_item_closed', `This item is already ${item.status}`);
    const note = body.note ?? item.note;
    update('reviewItems', item, { status: 'dismissed', resolvedBy: req.auth!.userId, resolvedAt: now(), note });
    audit({
      action: 'integration.review_dismiss',
      entityType: 'review_item',
      entityId: item.id,
      summary: `${item.instrumentCode ?? '?'} = ${item.valueText ?? ''} (${item.sampleBarcode ?? 'no barcode'}, ${item.reason}) dismissed: ${note ?? ''}`,
      before: { status: 'open' },
      after: { status: 'dismissed', note },
    });
    publish({ type: 'integration.message', data: { reviewItemId: item.id, status: 'dismissed', instrumentId: item.instrumentId } });
    const { r, inst } = loadReview(item.id);
    return reviewItem(r, inst);
  });
}
