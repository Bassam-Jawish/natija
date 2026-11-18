/** Read the Lab Agent's local status page to find an analyzer's port and pending work. */
import { MODELS, type AgentWorklistItem, type InstrumentModel } from '@natija/protocols';

export type AgentInstrument = { code: string; model: string; protocol: string; endpoint: string; state: string };

export async function agentInstruments(agentUrl: string): Promise<AgentInstrument[] | null> {
  try {
    const res = await fetch(`${agentUrl.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { instruments?: AgentInstrument[] };
    return body.instruments ?? [];
  } catch {
    return null;
  }
}

export async function agentWorklist(agentUrl: string, code: string): Promise<{ fetchedAt: string | null; items: AgentWorklistItem[] } | null> {
  try {
    const res = await fetch(`${agentUrl.replace(/\/$/, '')}/worklist?instrument=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return (await res.json()) as { fetchedAt: string | null; items: AgentWorklistItem[] };
  } catch {
    return null;
  }
}

export function isModel(value: string): value is InstrumentModel {
  return (MODELS as string[]).includes(value);
}

/** "TCP server 127.0.0.1:9101" → { host, port }. */
export function endpointAddress(endpoint: string): { host: string; port: number } | null {
  const m = /TCP (?:server|client →)\s+([^\s:]+|\[[^\]]+\]):(\d+)/.exec(endpoint);
  if (!m) return null;
  const host = m[1]!.replace(/^\[|\]$/g, '');
  return { host: host === '0.0.0.0' ? '127.0.0.1' : host, port: Number(m[2]) };
}
