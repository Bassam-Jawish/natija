/**
 * /agents routes (port of apps/api/src/modules/agents/routes.ts): the lab's Lab Agents, enrolment
 * codes, rename and revoke. In mock mode no Lab Agent ever connects: an enrolment code is shown
 * once and stays pending until it expires. The per-lab virtual agent that carries simulated
 * traffic is created by ensureVirtualAgent() (simulate.ts).
 */
import { agentCreateBody, agentUpdateBody, type AgentCreated, type AgentItem } from '@natija/contracts';
import { badRequest, conflict, ctx, now } from '../../core/context';
import { by, get, insert, rows, update, type Row } from '../../core/db';
import { audit, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { byText, contentHash, typedText } from './helpers';
import { iso, logIntegrationEvent } from './ingest';
import { agentOnline } from './serialize';

/** No 0/O or 1/I: the code is read off a screen and typed on the lab's PC. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ENROLL_TTL_MS = 24 * 3_600_000;

/** 8 characters from 32 symbols; single use, valid 24 h. */
export function newEnrollmentCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Only a hash of the code is kept (the server keys it with HMAC; any stable hash does here). */
export function enrollmentCodeHash(code: string): string {
  return contentHash(`agent-enroll:${code.toUpperCase()}`);
}

type AgentRow = Row<'agents'>;

function agentItems(list: AgentRow[]): AgentItem[] {
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    isVirtual: a.isVirtual,
    version: a.version,
    hostInfo: a.hostInfo ?? null,
    lastHeartbeatAt: iso(a.lastHeartbeatAt),
    online: agentOnline(a),
    enrollPending: !!a.enrollCodeHash && !!a.enrollExpiresAt && a.enrollExpiresAt.getTime() > now().getTime(),
    enrollExpiresAt: iso(a.enrollExpiresAt),
    createdAt: a.createdAt.toISOString(),
    revokedAt: iso(a.revokedAt),
    instruments: by('instruments', 'agentId', a.id)
      .sort((x, y) => byText(x.code, y.code))
      .map(({ id, code, name, status }) => ({ id, code, name, status })),
  }));
}

function loadAgent(id: string | undefined): AgentRow {
  return get('agents', id, 'agent_not_found');
}

export function registerAgentRoutes(): void {
  route('GET', '/agents', { perm: 'instruments.manage' }, (): AgentItem[] =>
    agentItems([...rows('agents')].sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual) || a.createdAt.getTime() - b.createdAt.getTime())),
  );

  route('POST', '/agents', { perm: 'instruments.manage' }, (req): AgentCreated => {
    const body = parse(agentCreateBody, req.body);
    const name = body.name ?? (typedText(req.body, 'name') || 'Lab Agent');
    const code = newEnrollmentCode();
    const expiresAt = new Date(now().getTime() + ENROLL_TTL_MS);
    const row = insert('agents', { labId: ctx().labId, name, status: 'pending', enrollCodeHash: enrollmentCodeHash(code), enrollExpiresAt: expiresAt, createdAt: now() });
    audit({ action: 'agent.create', entityType: 'agent', entityId: row.id, summary: `Lab Agent "${name}" created; enrollment code valid until ${expiresAt.toISOString()}` });
    publish({ type: 'instruments.changed', data: { agentId: row.id } });
    const [item] = agentItems([row]);
    return { agent: item!, enrollmentCode: code, expiresAt: expiresAt.toISOString() };
  });

  route('PATCH', '/agents/:id', { perm: 'instruments.manage' }, (req): AgentItem => {
    const body = parse(agentUpdateBody, req.body);
    const agent = loadAgent(req.params.id);
    const beforeName = agent.name;
    const name = body.name ?? (typedText(req.body, 'name') || beforeName);
    update('agents', agent, { name });
    audit({ action: 'agent.update', entityType: 'agent', entityId: agent.id, summary: `Renamed "${beforeName}" → "${name}"`, before: { name: beforeName }, after: { name } });
    publish({ type: 'instruments.changed', data: { agentId: agent.id } });
    return agentItems([agent])[0]!;
  });

  /** A fresh enrollment code (the old one stops working). */
  route('POST', '/agents/:id/enrollment-code', { perm: 'instruments.manage' }, (req): AgentCreated => {
    const agent = loadAgent(req.params.id);
    if (agent.isVirtual) throw badRequest('virtual_agent', 'The virtual agent runs inside the platform and is never enrolled');
    if (agent.status === 'revoked') throw conflict('agent_revoked', 'Create a new agent instead of re-enrolling a revoked one');
    const code = newEnrollmentCode();
    const expiresAt = new Date(now().getTime() + ENROLL_TTL_MS);
    update('agents', agent, { enrollCodeHash: enrollmentCodeHash(code), enrollExpiresAt: expiresAt });
    audit({ action: 'agent.enrollment_code', entityType: 'agent', entityId: agent.id, summary: `New enrollment code for "${agent.name}", valid until ${expiresAt.toISOString()}` });
    const [item] = agentItems([agent]);
    return { agent: item!, enrollmentCode: code, expiresAt: expiresAt.toISOString() };
  });

  route('POST', '/agents/:id/revoke', { perm: 'instruments.manage' }, (req): AgentItem => {
    const agent = loadAgent(req.params.id);
    if (agent.isVirtual) throw badRequest('virtual_agent', 'The virtual agent cannot be revoked');
    if (agent.status === 'revoked') throw conflict('agent_revoked');
    const beforeStatus = agent.status;
    update('agents', agent, { status: 'revoked', revokedAt: now(), tokenHash: null, enrollCodeHash: null, enrollExpiresAt: null });
    const affected = by('instruments', 'agentId', agent.id).filter((i) => i.status === 'online');
    for (const inst of affected) update('instruments', inst, { status: 'offline' });
    logIntegrationEvent({ agentId: agent.id, level: 'warn', event: 'agent_revoked', detail: `Lab Agent "${agent.name}" revoked; its token no longer works` });
    audit({ action: 'agent.revoke', entityType: 'agent', entityId: agent.id, summary: `Lab Agent "${agent.name}" revoked`, before: { status: beforeStatus }, after: { status: 'revoked', instrumentsOffline: affected.length } });
    publish({ type: 'instruments.changed', data: { agentId: agent.id } });
    return agentItems([agent])[0]!;
  });
}
