/**
 * Analyzer integration: instruments, code maps, integration messages, the review queue,
 * Lab Agents, the agent API, QC and maintenance.
 *
 * Request bodies are zod schemas (the API validates with them); responses are plain types.
 * Timestamps are ISO 8601 strings. Every analyzer integration is at readiness level L0
 * (simulated) until it has been built to the vendor spec, bench-tested and put in service.
 */
import { z } from 'zod';
import { isoDate, pageQuery, uuid } from './common';

/* ================================================================== enums */

export const INSTRUMENT_MODELS = ['cobas_pure', 'cobas_e411', 'sysmex_xn', 'ichroma3', 'mindray_bs430', 'medica_easystat', 'other'] as const;
export type InstrumentModelId = (typeof INSTRUMENT_MODELS)[number];

export const INSTRUMENT_PROTOCOLS = ['hl7', 'astm', 'medica_text', 'ichroma_invented'] as const;
export type InstrumentProtocolId = (typeof INSTRUMENT_PROTOCOLS)[number];

/** From the Lab Agent's point of view: tcp_server = the agent listens, tcp_client = the agent connects. */
export const INSTRUMENT_TRANSPORTS = ['tcp_server', 'tcp_client', 'serial'] as const;
export type InstrumentTransport = (typeof INSTRUMENT_TRANSPORTS)[number];

export const INSTRUMENT_STATUSES = ['online', 'offline', 'error', 'unknown'] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

export const INTEGRATION_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type IntegrationLevel = (typeof INTEGRATION_LEVELS)[number];

/** Readiness levels shown in the UI. Never present an analyzer as "integrated" below L3. */
export const INTEGRATION_LEVEL_LABELS: Record<IntegrationLevel, { en: string; ar: string; hintEn: string; hintAr: string }> = {
  L0: { en: 'Simulated', ar: 'محاكاة', hintEn: 'Demo traffic only; never connected to this analyzer.', hintAr: 'حركة تجريبية فقط؛ لم يُوصل بهذا الجهاز بعد.' },
  L1: { en: 'Built to spec', ar: 'مبني وفق المواصفات', hintEn: 'Implemented from the vendor interface manual, not yet tested on a real analyzer.', hintAr: 'منفّذ وفق دليل واجهة الشركة المصنّعة، لم يُختبر على جهاز حقيقي.' },
  L2: { en: 'Bench-tested', ar: 'مُختبَر على الطاولة', hintEn: 'Tested against a real analyzer outside patient work.', hintAr: 'اختُبر على جهاز حقيقي خارج العمل على المرضى.' },
  L3: { en: 'In service', ar: 'قيد الخدمة', hintEn: 'Validated by the lab and used for patient results.', hintAr: 'تحقق منه المخبر ويُستخدم لنتائج المرضى.' },
};

/** Research confidence of the protocol details: V verified, L likely, U unknown. */
export type ResearchConfidence = 'V' | 'L' | 'U';

export const MESSAGE_STATUSES = ['received', 'processed', 'duplicate', 'error', 'partial', 'unmatched'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const REVIEW_REASONS = ['unknown_sample', 'unknown_code', 'unit_mismatch', 'no_order_item', 'sample_rejected', 'result_locked'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_STATUSES = ['open', 'assigned', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const SIMULATION_MODES = ['normal', 'abnormal', 'critical'] as const;
export type SimulationMode = (typeof SIMULATION_MODES)[number];

export const SIMULATION_FAULTS = ['none', 'duplicate', 'bad_checksum', 'unknown_code', 'unknown_sample'] as const;
export type SimulationFault = (typeof SIMULATION_FAULTS)[number];

/**
 * Faults that make sense for a protocol: text protocols (printout, demo lines) have no
 * checksum or acknowledgement, so bad_checksum does not apply to them. For HL7, which has
 * no frame checksum, bad_checksum sends a corrupted message that the host refuses (AR).
 */
export function faultsFor(protocol: InstrumentProtocolId): SimulationFault[] {
  return protocol === 'astm' || protocol === 'hl7' ? [...SIMULATION_FAULTS] : SIMULATION_FAULTS.filter((f) => f !== 'bad_checksum');
}

export const AGENT_STATUSES = ['pending', 'active', 'revoked'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_LINK_STATES = ['connected', 'waiting', 'error', 'disabled'] as const;
export type AgentLinkState = (typeof AGENT_LINK_STATES)[number];

export const QC_RUN_STATUSES = ['accepted', 'warning', 'rejected'] as const;
export type QcRunStatus = (typeof QC_RUN_STATUSES)[number];

export const MAINTENANCE_KINDS = ['daily', 'weekly', 'monthly', 'repair', 'calibration', 'service'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MAINTENANCE_OUTCOMES = ['ok', 'issue', 'failed'] as const;
export type MaintenanceOutcome = (typeof MAINTENANCE_OUTCOMES)[number];

const isoDateTime = z.iso.datetime({ offset: true });
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/* ================================================================== instruments */

export const instrumentCreateBody = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9_.-]+$/, 'Letters, digits, dot, dash and underscore only'),
  name: z.string().trim().min(1).max(120),
  model: z.enum(INSTRUMENT_MODELS),
  manufacturer: z.string().trim().max(80).nullish(),
  /** Defaults to the model's profile. */
  protocol: z.enum(INSTRUMENT_PROTOCOLS).optional(),
  transport: z.enum(INSTRUMENT_TRANSPORTS).optional(),
  host: z.string().trim().max(255).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  serialPort: z.string().trim().max(60).nullish(),
  baudRate: z.number().int().min(300).max(921600).nullish(),
  agentId: uuid.nullish(),
  departmentId: uuid.nullish(),
  integrationLevel: z.enum(INTEGRATION_LEVELS).optional(),
  isSimulated: z.boolean().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
  /** Create code mappings from the model's default test menu for analytes that exist in the lab. */
  createDefaultMappings: z.boolean().optional(),
});
export type InstrumentCreateBody = z.infer<typeof instrumentCreateBody>;

export const instrumentUpdateBody = instrumentCreateBody.omit({ createDefaultMappings: true }).partial();
export type InstrumentUpdateBody = z.infer<typeof instrumentUpdateBody>;

export const instrumentListQuery = z.object({ includeInactive: boolQuery.optional() });

export type InstrumentProfileSummary = {
  model: InstrumentModelId;
  name: string;
  manufacturer: string;
  protocol: InstrumentProtocolId;
  transport: InstrumentTransport;
  defaultPort: number;
  serial: { baudRate: number; dataBits: number; parity: string; stopBits: number } | null;
  bidirectional: boolean;
  department: string;
  confidence: ResearchConfidence;
  specimenIdMax: number | null;
  note: string;
  tests: Array<{ code: string; analyte: string; unit: string }>;
};

export type InstrumentAgentRef = {
  id: string;
  name: string;
  status: AgentStatus;
  isVirtual: boolean;
  lastHeartbeatAt: string | null;
  online: boolean;
};

export type InstrumentListItem = {
  id: string;
  code: string;
  name: string;
  model: InstrumentModelId;
  manufacturer: string | null;
  protocol: InstrumentProtocolId;
  transport: InstrumentTransport;
  host: string | null;
  port: number | null;
  serialPort: string | null;
  baudRate: number | null;
  department: { id: string; code: string; nameAr: string; nameEn: string } | null;
  agent: InstrumentAgentRef | null;
  status: InstrumentStatus;
  integrationLevel: IntegrationLevel;
  isSimulated: boolean;
  isActive: boolean;
  lastMessageAt: string | null;
  lastSeenAt: string | null;
  counts: { messagesToday: number; errorsToday: number; openReview: number; mappings: number };
};

export type InstrumentDetail = InstrumentListItem & {
  notes: string | null;
  createdAt: string;
  profile: InstrumentProfileSummary | null;
  /** Faults the simulate endpoint accepts for this instrument's protocol. */
  faults: SimulationFault[];
  recentEvents: IntegrationEventItem[];
};

/** Choices for the instrument, code-map and QC forms. */
export type InstrumentFormData = {
  departments: Array<{ id: string; code: string; nameAr: string; nameEn: string }>;
  agents: Array<{ id: string; name: string; status: AgentStatus; isVirtual: boolean }>;
  analytes: Array<{ id: string; code: string; nameAr: string; nameEn: string; unit: string | null }>;
  instruments: Array<{ id: string; code: string; name: string; model: InstrumentModelId }>;
};

/* ------------------------------------------------------------------ code maps */

export const mappingBody = z.object({
  instrumentCode: z.string().trim().min(1).max(40),
  analyteId: uuid,
  /** Multiply the instrument value by this to get the lab's unit (default 1). */
  unitFactor: z.number().positive().max(1_000_000).optional(),
  instrumentUnit: z.string().trim().max(40).nullish(),
  isActive: z.boolean().optional(),
});
export type MappingBody = z.infer<typeof mappingBody>;
export const mappingUpdateBody = mappingBody.partial();
export type MappingUpdateBody = z.infer<typeof mappingUpdateBody>;

export type InstrumentMappingItem = {
  id: string;
  instrumentId: string;
  instrumentCode: string;
  analyte: { id: string; code: string; nameEn: string; nameAr: string; unit: string | null };
  unitFactor: number;
  instrumentUnit: string | null;
  isActive: boolean;
};

/* ------------------------------------------------------------------ messages and events */

export const messagesQuery = pageQuery.extend({
  status: z.enum(MESSAGE_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  barcode: z.string().trim().max(40).optional(),
  simulated: boolQuery.optional(),
});
export type MessagesQuery = z.infer<typeof messagesQuery>;

export const eventsQuery = pageQuery.extend({
  level: z.enum(EVENT_LEVELS).optional(),
  instrumentId: uuid.optional(),
  agentId: uuid.optional(),
});

export type IntegrationMessageItem = {
  id: string;
  instrumentId: string;
  agentId: string | null;
  direction: 'in' | 'out';
  protocol: InstrumentProtocolId;
  messageType: string | null;
  controlId: string | null;
  status: MessageStatus;
  error: string | null;
  sampleBarcode: string | null;
  resultsCount: number;
  isSimulated: boolean;
  receivedAt: string;
  processedAt: string | null;
};

/** The canonical parsed form of any analyzer message (mirrors @natija/protocols InstrumentMessage). */
export type NormalizedMessageView = {
  model: string;
  protocol: InstrumentProtocolId;
  kind: 'results' | 'query' | 'qc' | 'other';
  messageType: string;
  controlId: string | null;
  sender: string | null;
  sentAt: string | null;
  specimens: Array<{
    sampleId: string;
    isQc: boolean;
    results: Array<{
      code: string;
      name: string | null;
      value: string;
      unit: string | null;
      flags: string | null;
      referenceRange: string | null;
      measuredAt: string | null;
      status: string | null;
      dilution: number | null;
      isQc: boolean;
    }>;
    graphs: Array<{ code: string; ref: string }>;
    comments: string[];
  }>;
  queries: Array<{ sampleIds: string[]; all: boolean }>;
  warnings: string[];
  /** Each record / segment with its non-empty fields, e.g. { type: 'R', fields: [{ ref: 'R.4', value: '7.81' }] }. */
  records: Array<{ type: string; fields: Array<{ ref: string; value: string }> }>;
};

/** What happened to one value of a message. */
export type IngestItem = {
  sampleId: string;
  code: string;
  value: string;
  unit: string | null;
  flags: string | null;
  isQc: boolean;
  outcome: 'applied' | 'locked' | 'review' | 'qc' | 'skipped';
  /**
   * Review reason (unknown_sample, unknown_code, unit_mismatch, no_order_item, sample_rejected,
   * result_locked), or why a value was skipped: no_value, not_done (analyzer status X),
   * qc_no_material, unknown_code (QC only).
   */
  reason: string | null;
  analyteCode: string | null;
  /** Value written to the result after unit conversion. */
  convertedValue: string | null;
  resultId: string | null;
  orderId: string | null;
  reviewItemId: string | null;
  /** Flag the lab's own reference range gave the value. */
  flag: string | null;
  isCritical: boolean;
  qcRunId: string | null;
  qcStatus: QcRunStatus | null;
};

/** Final status of an ingested message ("received" only exists while it is being processed). */
export type IngestStatus = Exclude<MessageStatus, 'received'>;

export type IngestOutcome = {
  messageId: string | null;
  status: IngestStatus;
  /** For duplicates: the message first received with the same content. */
  duplicateOf: string | null;
  kind: NormalizedMessageView['kind'] | null;
  messageType: string | null;
  resultsCount: number;
  reviewCount: number;
  error: string | null;
  items: IngestItem[];
};

/** Stored in integration_messages.parsed. */
export type IntegrationParsed = { normalized: NormalizedMessageView | null; items: IngestItem[]; notes: string[] };

export type IntegrationMessageDetail = IntegrationMessageItem & {
  raw: string;
  parsed: IntegrationParsed | null;
  instrument: { id: string; code: string; name: string; model: InstrumentModelId };
  reviewItems: Array<{ id: string; reason: ReviewReason; status: ReviewStatus; instrumentCode: string | null; sampleBarcode: string | null; valueText: string | null }>;
  /** Result attempts that came from this message. */
  attempts: Array<{ id: string; resultId: string; analyteCode: string; valueNum: number | null; valueText: string | null; unit: string | null; rawFlag: string | null; createdAt: string }>;
};

export type IntegrationEventItem = {
  id: string;
  instrumentId: string | null;
  instrumentCode: string | null;
  agentId: string | null;
  level: EventLevel;
  event: string;
  detail: string | null;
  at: string;
};

/* ------------------------------------------------------------------ simulation */

export const simulateBody = z.object({
  mode: z.enum(SIMULATION_MODES).default('normal'),
  /** Tube barcodes to report on; when omitted, up to 5 tubes with pending work for this analyzer. */
  barcodes: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
  fault: z.enum(SIMULATION_FAULTS).default('none'),
  /** Send QC results for the instrument's QC materials instead of patient results. */
  qc: z.boolean().optional(),
  /** Repeat a run exactly. */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});
export type SimulateBody = z.infer<typeof simulateBody>;

/** One line of the wire trace: what crossed the simulated link. */
export type WireFrame = {
  /** Which simulated transmission (0-based): a duplicate fault sends the same message twice. */
  exchange: number;
  /** Milliseconds since the transmission started. */
  t: number;
  /** instrument = the simulated analyzer wrote it, host = the platform (in the Lab Agent's role) wrote it. */
  side: 'instrument' | 'host';
  dir: 'tx' | 'rx' | 'note';
  kind: 'control' | 'frame' | 'message' | 'text' | 'info' | 'error';
  /** Control characters shown as <STX>, <CR>, <ACK> ... */
  text: string;
  ok?: boolean;
};

export type SimulateResponse = {
  instrument: { id: string; code: string; name: string; model: InstrumentModelId; protocol: InstrumentProtocolId; integrationLevel: IntegrationLevel };
  mode: SimulationMode;
  fault: SimulationFault;
  seed: number;
  specimens: Array<{ sampleId: string; tests: string[]; isQc: boolean }>;
  /** Wire trace of every transmission: frames, control characters and protocol decisions. */
  frames: WireFrame[];
  /** Raw messages the simulated analyzer sent, one per transmission. */
  raw: string[];
  /** Parsed form of each raw message (null when it could not be parsed). */
  parsed: Array<NormalizedMessageView | null>;
  outcome: {
    /** Ingest result per transmission (null when the link refused the message before ingest). */
    messages: Array<IngestOutcome | null>;
    summary: { sent: number; delivered: number; applied: number; review: number; duplicates: number; refused: number };
    notes: string[];
  };
};

/* ================================================================== Lab Agents (staff) */

export const agentCreateBody = z.object({ name: z.string().trim().min(1).max(80) });
export const agentUpdateBody = z.object({ name: z.string().trim().min(1).max(80) });

export type AgentItem = {
  id: string;
  name: string;
  status: AgentStatus;
  isVirtual: boolean;
  version: string | null;
  hostInfo: Record<string, unknown> | null;
  lastHeartbeatAt: string | null;
  /** Heartbeat within the last 90 seconds. */
  online: boolean;
  /** An unused enrollment code exists. */
  enrollPending: boolean;
  enrollExpiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  instruments: Array<{ id: string; code: string; name: string; status: InstrumentStatus }>;
};

/** The enrollment code is shown once; the server keeps only a keyed hash of it. */
export type AgentCreated = { agent: AgentItem; enrollmentCode: string; expiresAt: string };

/* ================================================================== agent API (Lab Agent ↔ platform) */

export const agentEnrollBody = z.object({
  /** 8-character one-time code; spaces and dashes are ignored. */
  code: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{8}$/, 'Enrollment codes have 8 letters or digits')),
  name: z.string().trim().min(1).max(80).optional(),
  version: z.string().trim().max(40).optional(),
  hostInfo: z.record(z.string(), z.unknown()).optional(),
});

export const agentHeartbeatBody = z.object({
  version: z.string().trim().max(40).optional(),
  hostInfo: z.record(z.string(), z.unknown()).optional(),
  uptimeSec: z.number().int().min(0).optional(),
  queue: z.object({ pending: z.number().int().min(0), failed: z.number().int().min(0), incomplete: z.number().int().min(0) }).optional(),
  instruments: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(30),
        state: z.enum(AGENT_LINK_STATES),
        detail: z.string().max(500).nullish(),
        connectedSince: isoDateTime.nullish(),
        lastMessageAt: isoDateTime.nullish(),
      }),
    )
    .max(50),
});

export const agentMessagesBody = z.object({
  messages: z
    .array(
      z
        .object({
          instrumentCode: z.string().trim().min(1).max(30).optional(),
          instrumentId: uuid.optional(),
          raw: z.string().min(1).max(1_000_000),
          receivedAt: isoDateTime,
          idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/, 'SHA-256 hex of raw'),
          incomplete: z.boolean().optional(),
          note: z.string().max(500).optional(),
        })
        .refine((m) => m.instrumentCode || m.instrumentId, { message: 'instrumentCode or instrumentId is required' }),
    )
    .min(1)
    .max(50),
});

export const agentWorklistQuery = z.object({ instrument: z.string().trim().min(1).max(64) });

/* ================================================================== review queue */

export const reviewListQuery = pageQuery.extend({
  status: z.enum([...REVIEW_STATUSES, 'all']).default('open'),
  reason: z.enum(REVIEW_REASONS).optional(),
  instrumentId: uuid.optional(),
  /** Barcode or instrument code prefix. */
  q: z.string().trim().max(40).optional(),
});

export const reviewAssignBody = z.object({
  resultId: uuid,
  /** Override the value (e.g. after checking the analyzer). Defaults to the received value, unit-converted. */
  value: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(500).optional(),
  /** unknown_code only: also map this instrument code to the result's analyte (needs instruments.manage). */
  rememberMapping: z.boolean().optional(),
});

export const reviewDismissBody = z.object({ note: z.string().trim().min(1).max(500) });

/** A staff member shown next to an action (who resolved, ran or serviced). */
export type StaffRef = { id: string; fullNameAr: string; fullNameEn: string };

export type ReviewItem = {
  id: string;
  instrument: { id: string; code: string; name: string; model: InstrumentModelId };
  messageId: string | null;
  messageReceivedAt: string | null;
  isSimulated: boolean;
  sampleBarcode: string | null;
  instrumentCode: string | null;
  valueText: string | null;
  unit: string | null;
  flags: string | null;
  reason: ReviewReason;
  status: ReviewStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: StaffRef | null;
  assignedResultId: string | null;
};

export type ReviewCandidate = {
  resultId: string;
  orderId: string;
  accession: string;
  analyte: { id: string; code: string; nameEn: string; nameAr: string; unit: string | null };
  status: string;
  valueNum: number | null;
  valueText: string | null;
  sampleBarcode: string | null;
  /** The analyte the instrument code maps to. */
  isMappedAnalyte: boolean;
};

export type ReviewDetail = ReviewItem & {
  sample: { id: string; barcode: string; status: string; orderId: string; accession: string } | null;
  mapping: { analyteId: string; analyteCode: string; unitFactor: number; instrumentUnit: string | null } | null;
  candidates: ReviewCandidate[];
};

export type IntegrationOverview = {
  instruments: { total: number; online: number; offline: number; error: number; unknown: number; byLevel: Record<IntegrationLevel, number> };
  messagesToday: { total: number; processed: number; partial: number; unmatched: number; duplicate: number; error: number; simulated: number };
  review: { open: number; byReason: Record<ReviewReason, number> };
  agents: { total: number; active: number; online: number; pending: number };
  recentEvents: IntegrationEventItem[];
};

/* ================================================================== QC and maintenance */

export const qcMaterialBody = z.object({
  instrumentId: uuid.nullish(),
  analyteId: uuid,
  name: z.string().trim().min(1).max(120),
  lot: z.string().trim().min(1).max(60),
  level: z.string().trim().min(1).max(20),
  targetMean: z.number().finite(),
  targetSd: z.number().positive().finite(),
  unit: z.string().trim().max(30).nullish(),
  expiresOn: isoDate.nullish(),
  isActive: z.boolean().optional(),
});
export const qcMaterialUpdateBody = qcMaterialBody.partial();

export const qcMaterialsQuery = z.object({
  instrumentId: uuid.optional(),
  analyteId: uuid.optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
});

export const qcRunBody = z.object({
  materialId: uuid,
  value: z.number().finite(),
  runAt: isoDateTime.optional(),
  note: z.string().trim().max(500).optional(),
});

export const qcRunsQuery = pageQuery.extend({
  materialId: uuid.optional(),
  instrumentId: uuid.optional(),
  status: z.enum(QC_RUN_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const qcChartQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Most recent runs to plot (default 60). */
  limit: z.coerce.number().int().min(5).max(500).default(60),
});

export const maintenanceBody = z.object({
  instrumentId: uuid,
  kind: z.enum(MAINTENANCE_KINDS),
  performedAt: isoDateTime.optional(),
  performedByName: z.string().trim().max(120).optional(),
  nextDueAt: isoDateTime.nullish(),
  description: z.string().trim().max(2000).optional(),
  outcome: z.enum(MAINTENANCE_OUTCOMES).default('ok'),
});

export const maintenanceQuery = pageQuery.extend({
  instrumentId: uuid.optional(),
  kind: z.enum(MAINTENANCE_KINDS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type QcMaterialItem = {
  id: string;
  instrument: { id: string; code: string; name: string } | null;
  analyte: { id: string; code: string; nameEn: string; nameAr: string; unit: string | null };
  name: string;
  lot: string;
  level: string;
  targetMean: number;
  targetSd: number;
  unit: string | null;
  expiresOn: string | null;
  isActive: boolean;
  createdAt: string;
  lastRun: { id: string; value: number; runAt: string; status: QcRunStatus; violations: string[] } | null;
  runs30d: number;
};

export type QcRunItem = {
  id: string;
  materialId: string;
  value: number;
  /** (value - target mean) / target SD. */
  z: number | null;
  runAt: string;
  user: StaffRef | null;
  source: 'manual' | 'instrument';
  status: QcRunStatus;
  /** Westgard rules broken: 1-2s (warning), 1-3s, 2-2s, R-4s, 4-1s, 10x (reject). */
  violations: string[];
  note: string | null;
};

export type QcChart = {
  material: QcMaterialItem;
  mean: number;
  sd: number;
  lines: { mean: number; plus1: number; plus2: number; plus3: number; minus1: number; minus2: number; minus3: number };
  points: Array<{ id: string; runAt: string; value: number; z: number; status: QcRunStatus; violations: string[]; source: 'manual' | 'instrument' }>;
  stats: { n: number; observedMean: number | null; observedSd: number | null; cvPct: number | null };
};

export type MaintenanceItem = {
  id: string;
  instrument: { id: string; code: string; name: string };
  kind: MaintenanceKind;
  performedAt: string;
  performedBy: StaffRef | null;
  performedByName: string | null;
  nextDueAt: string | null;
  overdue: boolean;
  description: string | null;
  outcome: MaintenanceOutcome;
  createdAt: string;
};
