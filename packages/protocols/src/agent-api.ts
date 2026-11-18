/**
 * Wire types between the on-site Lab Agent and the platform (/api/v1/agent/*).
 * The server validates the same shapes with zod (packages/contracts/src/instruments.ts).
 */

/** Link state of one analyzer as the agent sees it. */
export type AgentLinkState =
  /** TCP connection up / serial port open. */
  | 'connected'
  /** Listening for the analyzer, or retrying the connection. */
  | 'waiting'
  /** Port could not be opened, bind failed, protocol errors. */
  | 'error'
  /** Configured but switched off in the agent. */
  | 'disabled';

export type AgentEnrollRequest = { code: string; name?: string; version?: string; hostInfo?: Record<string, unknown> };

export type AgentEnrollResponse = {
  /** Long-lived bearer token. Shown once; the server keeps only its hash. */
  token: string;
  agent: { id: string; name: string };
  lab: { code: string; nameEn: string; nameAr: string };
};

export type AgentHeartbeatInstrument = {
  code: string;
  state: AgentLinkState;
  detail?: string | null;
  connectedSince?: string | null;
  lastMessageAt?: string | null;
};

export type AgentHeartbeatRequest = {
  version?: string;
  hostInfo?: Record<string, unknown>;
  uptimeSec?: number;
  queue?: { pending: number; failed: number; incomplete: number };
  instruments: AgentHeartbeatInstrument[];
};

export type AgentHeartbeatResponse = {
  ok: true;
  serverTime: string;
  instruments: Array<{ code: string; id: string | null; status: string; accepted: boolean; reason?: string }>;
};

export type AgentMessageUpload = {
  /** Instrument code as configured in the lab (or its id). */
  instrumentCode?: string;
  instrumentId?: string;
  raw: string;
  /** When the agent received it (ISO 8601). */
  receivedAt: string;
  /** SHA-256 (hex) of `raw`; the server checks it and uses it to drop duplicates. */
  idempotencyKey: string;
  /** The link dropped before the message ended; store it for review, do not apply it. */
  incomplete?: boolean;
  note?: string;
};

export type AgentMessagesRequest = { messages: AgentMessageUpload[] };

export type AgentMessageOutcome = {
  idempotencyKey: string;
  /** True when the server stored the message (including duplicates and unparseable ones). */
  accepted: boolean;
  status: 'processed' | 'partial' | 'unmatched' | 'duplicate' | 'error' | 'rejected';
  messageId: string | null;
  error?: string;
};

export type AgentMessagesResponse = { results: AgentMessageOutcome[] };

export type AgentWorklistItem = {
  barcode: string;
  priority: 'routine' | 'urgent' | 'stat';
  sex: 'male' | 'female';
  birthDate: string;
  collectedAt: string | null;
  /** Instrument test codes still pending for this tube (from the instrument's code map). */
  tests: Array<{ code: string; analyteCode: string }>;
};

export type AgentWorklistResponse = {
  instrument: { id: string; code: string; model: string; protocol: string };
  generatedAt: string;
  items: AgentWorklistItem[];
};
