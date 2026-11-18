import type {
  AgentEnrollRequest,
  AgentEnrollResponse,
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
  AgentMessagesRequest,
  AgentMessagesResponse,
  AgentWorklistResponse,
} from '@natija/protocols';
import { AGENT_VERSION } from './version';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls to /api/v1/agent/* with the agent's bearer token. */
export class ApiClient {
  constructor(
    private readonly serverUrl: string,
    private token: string | null,
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const url = `${this.serverUrl.replace(/\/$/, '')}/api/v1/agent${path}`;
    const headers: Record<string, string> = { 'user-agent': `natija-lab-agent/${AGENT_VERSION}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new ApiError(0, 'network', `cannot reach ${this.serverUrl}: ${cause}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const problem = (json ?? {}) as { code?: string; title?: string };
      throw new ApiError(res.status, problem.code ?? `http_${res.status}`, problem.title ?? text.slice(0, 200));
    }
    return json as T;
  }

  enroll(body: AgentEnrollRequest): Promise<AgentEnrollResponse> {
    return this.call('POST', '/enroll', body);
  }

  heartbeat(body: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
    return this.call('POST', '/heartbeat', body, 10_000);
  }

  messages(body: AgentMessagesRequest): Promise<AgentMessagesResponse> {
    return this.call('POST', '/messages', body, 60_000);
  }

  worklist(instrument: string): Promise<AgentWorklistResponse> {
    return this.call('GET', `/worklist?instrument=${encodeURIComponent(instrument)}`, undefined, 10_000);
  }
}
