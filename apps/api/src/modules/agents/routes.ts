import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { agents, instruments } from '@natija/db';
import { agentCreateBody, agentUpdateBody, type AgentCreated, type AgentItem } from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { hmac } from '../../lib/crypto';
import { assertFound, badRequest, conflict } from '../../lib/errors';
import { publish } from '../../lib/events';
import { parse } from '../../lib/http';
import { iso, logIntegrationEvent } from '../../services/ingest';
import { AGENT_ONLINE_MS } from '../instruments/serialize';

/** No 0/O or 1/I: the code is read off a screen and typed on the lab's PC. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ENROLL_TTL_MS = 24 * 3_600_000;

/** 8 characters from 32 symbols = 40 bits; single use, valid 24 h, enrollment is rate-limited. */
export function newEnrollmentCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Only a keyed hash of the code is stored, so a database copy alone cannot be brute-forced. */
export function enrollmentCodeHash(code: string): string {
  return hmac(`agent-enroll:${code.toUpperCase()}`);
}

type AgentRow = typeof agents.$inferSelect;

async function agentItems(rows: AgentRow[]): Promise<AgentItem[]> {
  const ids = rows.map((r) => r.id);
  const insts = ids.length
    ? await db()
        .select({ id: instruments.id, code: instruments.code, name: instruments.name, status: instruments.status, agentId: instruments.agentId })
        .from(instruments)
        .where(inArray(instruments.agentId, ids))
        .orderBy(asc(instruments.code))
    : [];
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    isVirtual: a.isVirtual,
    version: a.version,
    hostInfo: a.hostInfo ?? null,
    lastHeartbeatAt: iso(a.lastHeartbeatAt),
    online: a.isVirtual ? a.status === 'active' : !!a.lastHeartbeatAt && Date.now() - a.lastHeartbeatAt.getTime() < AGENT_ONLINE_MS,
    enrollPending: !!a.enrollCodeHash && !!a.enrollExpiresAt && a.enrollExpiresAt > new Date(),
    enrollExpiresAt: iso(a.enrollExpiresAt),
    createdAt: a.createdAt.toISOString(),
    revokedAt: iso(a.revokedAt),
    instruments: insts.filter((i) => i.agentId === a.id).map(({ id, code, name, status }) => ({ id, code, name, status })),
  }));
}

/** The agents table has no row-level security: every query here filters by the lab. */
async function loadAgent(id: string): Promise<AgentRow> {
  const [row] = await db().select().from(agents).where(and(eq(agents.id, id), eq(agents.labId, ctx().labId)));
  return assertFound(row, 'agent_not_found');
}

const idParams = z.object({ id: z.string().uuid() });

export default async function agentRoutes(app: FastifyInstance) {
  app.get('/', { config: { perm: 'instruments.manage' } }, async (): Promise<AgentItem[]> => {
    const rows = await db().select().from(agents).where(eq(agents.labId, ctx().labId)).orderBy(asc(agents.isVirtual), asc(agents.createdAt));
    return agentItems(rows);
  });

  app.post('/', { config: { perm: 'instruments.manage' } }, async (req, reply): Promise<AgentCreated> => {
    const body = parse(agentCreateBody, req.body);
    const code = newEnrollmentCode();
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS);
    const [row] = await db()
      .insert(agents)
      .values({ labId: ctx().labId, name: body.name, status: 'pending', enrollCodeHash: enrollmentCodeHash(code), enrollExpiresAt: expiresAt })
      .returning();
    await audit({ action: 'agent.create', entityType: 'agent', entityId: row!.id, summary: `Lab Agent "${body.name}" created; enrollment code valid until ${expiresAt.toISOString()}` });
    publish({ type: 'instruments.changed', data: { agentId: row!.id } });
    reply.status(201);
    const [item] = await agentItems([row!]);
    return { agent: item!, enrollmentCode: code, expiresAt: expiresAt.toISOString() };
  });

  app.patch('/:id', { config: { perm: 'instruments.manage' } }, async (req): Promise<AgentItem> => {
    const { id } = parse(idParams, req.params);
    const body = parse(agentUpdateBody, req.body);
    const before = await loadAgent(id);
    const [row] = await db().update(agents).set({ name: body.name }).where(and(eq(agents.id, id), eq(agents.labId, ctx().labId))).returning();
    await audit({ action: 'agent.update', entityType: 'agent', entityId: id, summary: `Renamed "${before.name}" → "${body.name}"`, before: { name: before.name }, after: { name: body.name } });
    publish({ type: 'instruments.changed', data: { agentId: id } });
    const [item] = await agentItems([row!]);
    return item!;
  });

  /** A fresh enrollment code (the old one stops working). Re-enrolling an active agent replaces its token. */
  app.post('/:id/enrollment-code', { config: { perm: 'instruments.manage' } }, async (req): Promise<AgentCreated> => {
    const { id } = parse(idParams, req.params);
    const agent = await loadAgent(id);
    if (agent.isVirtual) throw badRequest('virtual_agent', 'The virtual agent runs inside the platform and is never enrolled');
    if (agent.status === 'revoked') throw conflict('agent_revoked', 'Create a new agent instead of re-enrolling a revoked one');
    const code = newEnrollmentCode();
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS);
    const [row] = await db()
      .update(agents)
      .set({ enrollCodeHash: enrollmentCodeHash(code), enrollExpiresAt: expiresAt })
      .where(and(eq(agents.id, id), eq(agents.labId, ctx().labId)))
      .returning();
    await audit({ action: 'agent.enrollment_code', entityType: 'agent', entityId: id, summary: `New enrollment code for "${agent.name}", valid until ${expiresAt.toISOString()}` });
    const [item] = await agentItems([row!]);
    return { agent: item!, enrollmentCode: code, expiresAt: expiresAt.toISOString() };
  });

  app.post('/:id/revoke', { config: { perm: 'instruments.manage' } }, async (req): Promise<AgentItem> => {
    const { id } = parse(idParams, req.params);
    const agent = await loadAgent(id);
    if (agent.isVirtual) throw badRequest('virtual_agent', 'The virtual agent cannot be revoked');
    if (agent.status === 'revoked') throw conflict('agent_revoked');
    const now = new Date();
    const [row] = await db()
      .update(agents)
      .set({ status: 'revoked', revokedAt: now, tokenHash: null, enrollCodeHash: null, enrollExpiresAt: null })
      .where(and(eq(agents.id, id), eq(agents.labId, ctx().labId)))
      .returning();
    const affected = await db()
      .update(instruments)
      .set({ status: 'offline' })
      .where(and(eq(instruments.agentId, id), eq(instruments.status, 'online')))
      .returning({ id: instruments.id });
    await logIntegrationEvent({ agentId: id, level: 'warn', event: 'agent_revoked', detail: `Lab Agent "${agent.name}" revoked; its token no longer works` });
    await audit({ action: 'agent.revoke', entityType: 'agent', entityId: id, summary: `Lab Agent "${agent.name}" revoked`, before: { status: agent.status }, after: { status: 'revoked', instrumentsOffline: affected.length } });
    publish({ type: 'instruments.changed', data: { agentId: id } });
    const [item] = await agentItems([row!]);
    return item!;
  });
}
