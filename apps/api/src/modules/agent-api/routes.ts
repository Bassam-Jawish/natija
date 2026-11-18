/**
 * The API the on-site Lab Agent talks to. Enrollment is public (a one-time code); everything
 * else authenticates with the agent's bearer token (route config `agent: true`), which also
 * scopes every query to the agent's lab.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { agents, instruments, labs, type Instrument } from '@natija/db';
import type {
  AgentEnrollResponse,
  AgentHeartbeatResponse,
  AgentMessageOutcome,
  AgentMessagesResponse,
  AgentWorklistResponse,
} from '@natija/protocols';
import { agentEnrollBody, agentHeartbeatBody, agentMessagesBody, agentWorklistQuery } from '@natija/contracts';
import { appDb, ctx, db, withLab } from '../../db';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError, forbidden, notFound, unauthorized } from '../../lib/errors';
import { publish } from '../../lib/events';
import { parse } from '../../lib/http';
import { ingestMessage, iso, logIntegrationEvent, withSavepoint } from '../../services/ingest';
import { enrollmentCodeHash } from '../agents/routes';
import { OFFLINE_AFTER_MS } from '../instruments/offline';
import { pendingWork, testCodes } from './worklist';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AgentRef = { agentId: string; name: string };

/**
 * Whether this agent may act for an instrument. Unassigned instruments (and ones that only
 * carried simulated traffic through the virtual agent) are claimed by the first real agent
 * that reports them; an instrument assigned to another real agent is refused.
 */
async function claimInstrument(inst: Instrument, agent: AgentRef): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (inst.agentId === agent.agentId) return { ok: true };
  if (inst.agentId) {
    const [owner] = await db()
      .select({ isVirtual: agents.isVirtual, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, inst.agentId), eq(agents.labId, ctx().labId)));
    if (owner && !owner.isVirtual && owner.status !== 'revoked') return { ok: false, reason: 'assigned_to_another_agent' };
  }
  await db().update(instruments).set({ agentId: agent.agentId }).where(eq(instruments.id, inst.id));
  inst.agentId = agent.agentId;
  await logIntegrationEvent({ instrumentId: inst.id, agentId: agent.agentId, event: 'agent_assigned', detail: `Now served by Lab Agent "${agent.name}"` });
  await audit({ action: 'instrument.agent_assigned', entityType: 'instrument', entityId: inst.id, summary: `${inst.code} → Lab Agent "${agent.name}"` });
  publish({ type: 'instruments.changed', data: { instrumentId: inst.id } });
  return { ok: true };
}

async function findInstrument(ref: string): Promise<Instrument | undefined> {
  const [row] = await db()
    .select()
    .from(instruments)
    .where(UUID_RE.test(ref) ? eq(instruments.id, ref) : eq(instruments.code, ref));
  return row;
}

const LINK_STATUS = { connected: 'online', waiting: 'offline', disabled: 'offline', error: 'error' } as const;

export default async function agentApiRoutes(app: FastifyInstance) {
  /** Exchange a one-time enrollment code for the agent's long-lived token (shown once). */
  app.post(
    '/enroll',
    { config: { public: true, tenant: false, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req): Promise<AgentEnrollResponse> => {
      const body = parse(agentEnrollBody, req.body);
      const hash = enrollmentCodeHash(body.code);
      const [agent] = await appDb.select().from(agents).where(eq(agents.enrollCodeHash, hash));
      if (!agent || agent.isVirtual || agent.status === 'revoked' || !agent.enrollExpiresAt || agent.enrollExpiresAt < new Date()) {
        throw unauthorized('enrollment_code_invalid', 'The enrollment code is wrong, used or expired');
      }
      const [lab] = await appDb.select().from(labs).where(eq(labs.id, agent.labId));
      if (!lab || lab.status !== 'active') throw new AppError(403, 'lab_suspended');
      const token = randomToken(32);
      return withLab(
        agent.labId,
        { actorName: `agent:${agent.name}`, ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
        async () => {
          const [updated] = await db()
            .update(agents)
            .set({
              tokenHash: sha256(token),
              enrollCodeHash: null,
              enrollExpiresAt: null,
              status: 'active',
              version: body.version ?? null,
              hostInfo: body.hostInfo ?? null,
              lastHeartbeatAt: new Date(),
            })
            .where(and(eq(agents.id, agent.id), eq(agents.enrollCodeHash, hash)))
            .returning({ id: agents.id, name: agents.name });
          if (!updated) throw unauthorized('enrollment_code_invalid', 'The enrollment code was just used');
          const wasActive = agent.status === 'active';
          await logIntegrationEvent({
            agentId: agent.id,
            event: 'agent_enrolled',
            detail: `Lab Agent "${agent.name}" ${wasActive ? 're-enrolled (previous token replaced)' : 'enrolled'}${body.version ? `, version ${body.version}` : ''}${body.name && body.name !== agent.name ? `, host calls itself "${body.name}"` : ''}`,
          });
          await audit({ action: 'agent.enroll', entityType: 'agent', entityId: agent.id, summary: `Lab Agent "${agent.name}" enrolled`, after: { version: body.version ?? null, hostInfo: body.hostInfo ?? null } });
          publish({ type: 'instruments.changed', data: { agentId: agent.id } });
          return { token, agent: { id: updated.id, name: updated.name }, lab: { code: lab.code, nameEn: lab.nameEn, nameAr: lab.nameAr } };
        },
      );
    },
  );

  /** Every 30 s: agent liveness plus the link state of each analyzer it serves. */
  app.post('/heartbeat', { config: { agent: true } }, async (req): Promise<AgentHeartbeatResponse> => {
    const body = parse(agentHeartbeatBody, req.body);
    const me = req.agent!;
    const now = new Date();
    const [agent] = await db().select().from(agents).where(and(eq(agents.id, me.agentId), eq(agents.labId, me.labId)));
    if (!agent) throw unauthorized('agent_unauthorized');
    // The agent's own view of each link (shown on the agent screen), separate from instrument status.
    const links = Object.fromEntries(body.instruments.map((i) => [i.code, { state: i.state, detail: i.detail ?? null, connectedSince: i.connectedSince ?? null, lastMessageAt: i.lastMessageAt ?? null }]));
    await db()
      .update(agents)
      .set({
        lastHeartbeatAt: now,
        ...(body.version ? { version: body.version } : {}),
        hostInfo: { ...(agent.hostInfo ?? {}), ...(body.hostInfo ?? {}), uptimeSec: body.uptimeSec ?? null, queue: body.queue ?? null, links, reportedAt: now.toISOString() },
      })
      .where(eq(agents.id, me.agentId));
    if (body.version && agent.version && body.version !== agent.version) {
      await audit({ action: 'agent.version', entityType: 'agent', entityId: me.agentId, summary: `Lab Agent "${me.name}" updated ${agent.version} → ${body.version}` });
    }

    const codes = [...new Set(body.instruments.map((i) => i.code))];
    const rows = codes.length ? await db().select().from(instruments).where(inArray(instruments.code, codes)) : [];
    const out: AgentHeartbeatResponse['instruments'] = [];
    let changed = false;
    for (const rep of body.instruments) {
      const inst = rows.find((r) => r.code === rep.code);
      if (!inst) {
        out.push({ code: rep.code, id: null, status: 'unknown', accepted: false, reason: 'unknown_instrument' });
        continue;
      }
      const claim = await claimInstrument(inst, me);
      if (!claim.ok) {
        out.push({ code: rep.code, id: inst.id, status: inst.status, accepted: false, reason: claim.reason });
        continue;
      }
      // Some analyzers open a TCP connection per transmission: between transmissions the agent
      // reports "waiting". Recent traffic keeps the instrument online; the offline job takes over
      // after 5 quiet minutes.
      const recent = (d: Date | null) => !!d && now.getTime() - d.getTime() < OFFLINE_AFTER_MS;
      let next: 'online' | 'offline' | 'error' = LINK_STATUS[rep.state];
      if (rep.state === 'waiting' && inst.status === 'online' && (recent(inst.lastMessageAt) || recent(inst.lastSeenAt))) next = 'online';
      await db()
        .update(instruments)
        .set({ status: next, ...(rep.state === 'connected' ? { lastSeenAt: now } : {}) })
        .where(eq(instruments.id, inst.id));
      if (next !== inst.status) {
        changed = true;
        const level = next === 'online' ? 'info' : next === 'error' ? 'error' : 'warn';
        const event = next === 'online' ? 'connected' : next === 'error' ? 'link_error' : 'disconnected';
        const detail = `${rep.state}${rep.detail ? `: ${rep.detail}` : ''} (reported by Lab Agent "${me.name}")`;
        await logIntegrationEvent({ instrumentId: inst.id, agentId: me.agentId, level, event, detail });
        await audit({ action: 'instrument.link', entityType: 'instrument', entityId: inst.id, summary: `${inst.code}: ${inst.status} → ${next} (${detail})`, before: { status: inst.status }, after: { status: next } });
      }
      out.push({ code: rep.code, id: inst.id, status: next, accepted: true });
    }
    if (changed) publish({ type: 'instruments.changed', data: { agentId: me.agentId } });
    return { ok: true, serverTime: now.toISOString(), instruments: out };
  });

  /** A batch of raw messages from the agent's journal. Idempotent: the same content is a duplicate. */
  app.post('/messages', { config: { agent: true, rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req): Promise<AgentMessagesResponse> => {
    const body = parse(agentMessagesBody, req.body);
    const me = req.agent!;
    const cache = new Map<string, Instrument | undefined>();
    const results: AgentMessageOutcome[] = [];
    for (const m of body.messages) {
      const base = { idempotencyKey: m.idempotencyKey };
      if (sha256(m.raw) !== m.idempotencyKey) {
        results.push({ ...base, accepted: false, status: 'rejected', messageId: null, error: 'hash_mismatch' });
        continue;
      }
      const ref = m.instrumentId ?? m.instrumentCode!;
      if (!cache.has(ref)) cache.set(ref, await findInstrument(ref));
      const inst = cache.get(ref);
      if (!inst) {
        results.push({ ...base, accepted: false, status: 'rejected', messageId: null, error: 'unknown_instrument' });
        continue;
      }
      try {
        const out = await withSavepoint(async () => {
          const claim = await claimInstrument(inst, me);
          if (!claim.ok) return null;
          return ingestMessage({
            instrumentId: inst.id,
            agentId: me.agentId,
            raw: m.raw,
            receivedAt: new Date(m.receivedAt),
            isSimulated: false,
            incomplete: m.incomplete,
            note: m.note ?? null,
          });
        });
        if (!out) results.push({ ...base, accepted: false, status: 'rejected', messageId: null, error: 'assigned_to_another_agent' });
        else results.push({ ...base, accepted: true, status: out.status, messageId: out.messageId, ...(out.error ? { error: out.error } : {}) });
      } catch (err) {
        req.log.error({ err }, 'agent message ingest failed');
        results.push({ ...base, accepted: false, status: 'rejected', messageId: null, error: 'server_error' });
      }
    }
    return { results };
  });

  /** Pending tubes for one analyzer with its test codes, so the agent can answer host queries offline. */
  app.get('/worklist', { config: { agent: true } }, async (req): Promise<AgentWorklistResponse> => {
    const q = parse(agentWorklistQuery, req.query);
    const me = req.agent!;
    const inst = await findInstrument(q.instrument);
    if (!inst) throw notFound('instrument_not_found');
    if (inst.agentId && inst.agentId !== me.agentId) {
      const [owner] = await db().select({ isVirtual: agents.isVirtual }).from(agents).where(and(eq(agents.id, inst.agentId), eq(agents.labId, me.labId)));
      if (owner && !owner.isVirtual) throw forbidden('assigned_to_another_agent');
    }
    const work = await pendingWork(inst.id, { limit: 500 });
    return {
      instrument: { id: inst.id, code: inst.code, model: inst.model, protocol: inst.protocol },
      generatedAt: new Date().toISOString(),
      items: work.map((t) => ({
        barcode: t.barcode,
        priority: t.priority,
        sex: t.sex,
        birthDate: t.birthDate,
        collectedAt: iso(t.collectedAt),
        tests: testCodes(t).map((code) => ({ code, analyteCode: t.tests.find((x) => x.code === code)!.analyteCode })),
      })),
    };
  });
}
