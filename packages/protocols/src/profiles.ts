/**
 * Instrument profiles used by the simulators, the seed data and the default code maps.
 *
 * IMPORTANT: these are DEMO profiles. Protocol families and connection details follow the
 * research in docs/analyzers.md; instrument test codes are examples a lab would configure
 * (Roche-style reagent abbreviations, Sysmex parameter names, Mindray test names). Real codes
 * must be taken from each instrument's configuration and host-interface manual.
 * The ichroma III profile uses an invented format because Boditech publishes no specification.
 */

export type InstrumentModel = 'cobas_pure' | 'cobas_e411' | 'sysmex_xn' | 'ichroma3' | 'mindray_bs430' | 'medica_easystat';
export type ProtocolFamily = 'hl7' | 'astm' | 'medica_text' | 'ichroma_invented';

export type ProfileTest = {
  /** Code the instrument sends. */
  code: string;
  /** Lab analyte code it maps to by default. */
  analyte: string;
  unit: string;
  decimals: number;
  /** Typical normal span used by the simulator (instrument units). */
  normal: [number, number];
  /** Values that would be clearly abnormal / critical, for simulated abnormal runs. */
  abnormal?: [number, number];
  critical?: [number, number];
};

export type InstrumentProfile = {
  model: InstrumentModel;
  name: string;
  manufacturer: string;
  protocol: ProtocolFamily;
  /** How the instrument is usually connected in a lab. */
  transport: 'tcp_server' | 'tcp_client' | 'serial';
  /** Default TCP port used by the Lab Agent / simulator for this instrument. */
  defaultPort: number;
  /** Serial settings when connected over RS-232 (or a serial device server). */
  serial?: { baudRate: number; dataBits: 7 | 8; parity: 'none' | 'even' | 'odd'; stopBits: 1 | 2 };
  /** Analyzer asks the host for its work list (host query). */
  bidirectional: boolean;
  department: string;
  /** Research confidence for the protocol family: V verified, L likely, U unknown. */
  confidence: 'V' | 'L' | 'U';
  /** Longest specimen ID the analyzer accepts, when the manual states one. */
  specimenIdMax?: number;
  note: string;
  tests: ProfileTest[];
};

export const PROFILES: Record<InstrumentModel, InstrumentProfile> = {
  sysmex_xn: {
    model: 'sysmex_xn',
    name: 'Sysmex XN-550',
    manufacturer: 'Sysmex',
    protocol: 'astm',
    transport: 'tcp_server',
    defaultPort: 9101,
    bidirectional: true,
    department: 'HEM',
    confidence: 'L',
    note: 'XN-L series: ASTM E1381/E1394 over LAN (analyzer connects to the host) or RS-232. Record layout follows the ASTM standard; exact Sysmex fields need the XN ASTM host specification.',
    tests: [
      { code: 'WBC', analyte: 'WBC', unit: '10*3/uL', decimals: 2, normal: [4.5, 10.5], abnormal: [12, 18], critical: [1.2, 42] },
      { code: 'RBC', analyte: 'RBC', unit: '10*6/uL', decimals: 2, normal: [4.3, 5.6], abnormal: [3.2, 3.8] },
      { code: 'HGB', analyte: 'HGB', unit: 'g/dL', decimals: 1, normal: [12.5, 16.5], abnormal: [9.2, 10.8], critical: [5.9, 21.5] },
      { code: 'HCT', analyte: 'HCT', unit: '%', decimals: 1, normal: [37, 49], abnormal: [29, 33] },
      { code: 'MCV', analyte: 'MCV', unit: 'fL', decimals: 1, normal: [82, 96], abnormal: [66, 74] },
      { code: 'MCH', analyte: 'MCH', unit: 'pg', decimals: 1, normal: [27.5, 32.5], abnormal: [20, 24] },
      { code: 'MCHC', analyte: 'MCHC', unit: 'g/dL', decimals: 1, normal: [32.2, 35.5], abnormal: [29, 31] },
      { code: 'RDW-CV', analyte: 'RDW', unit: '%', decimals: 1, normal: [11.8, 14.2], abnormal: [16, 21] },
      { code: 'PLT', analyte: 'PLT', unit: '10*3/uL', decimals: 0, normal: [170, 380], abnormal: [95, 135], critical: [22, 1150] },
      { code: 'MPV', analyte: 'MPV', unit: 'fL', decimals: 1, normal: [8.2, 11.0], abnormal: [12, 13.5] },
      { code: 'NEUT%', analyte: 'NEUT%', unit: '%', decimals: 1, normal: [45, 70], abnormal: [78, 88] },
      { code: 'LYMPH%', analyte: 'LYMPH%', unit: '%', decimals: 1, normal: [22, 40], abnormal: [10, 16] },
      { code: 'MONO%', analyte: 'MONO%', unit: '%', decimals: 1, normal: [3, 9], abnormal: [11, 14] },
      { code: 'EO%', analyte: 'EOS%', unit: '%', decimals: 1, normal: [1, 5], abnormal: [8, 14] },
      { code: 'BASO%', analyte: 'BASO%', unit: '%', decimals: 1, normal: [0.2, 1.2], abnormal: [2.5, 3.5] },
      { code: 'NEUT#', analyte: 'NEUT#', unit: '10*3/uL', decimals: 2, normal: [2.2, 6.8], abnormal: [8.5, 14] },
      { code: 'LYMPH#', analyte: 'LYMPH#', unit: '10*3/uL', decimals: 2, normal: [1.2, 3.4], abnormal: [0.5, 0.8] },
      { code: 'MONO#', analyte: 'MONO#', unit: '10*3/uL', decimals: 2, normal: [0.25, 0.85], abnormal: [1.2, 1.8] },
      { code: 'EO#', analyte: 'EOS#', unit: '10*3/uL', decimals: 2, normal: [0.05, 0.4], abnormal: [0.7, 1.4] },
      { code: 'BASO#', analyte: 'BASO#', unit: '10*3/uL', decimals: 2, normal: [0.01, 0.08], abnormal: [0.25, 0.4] },
    ],
  },
  mindray_bs430: {
    model: 'mindray_bs430',
    name: 'Mindray BS-430',
    manufacturer: 'Mindray',
    protocol: 'hl7',
    transport: 'tcp_server',
    defaultPort: 9102,
    bidirectional: true,
    department: 'CHEM',
    confidence: 'L',
    note: 'Chemistry analyzer. Mindray chemistry interface: HL7 v2.3.1 over MLLP (ORU^R01 results; QRY^Q02 / DSR^Q03 queries), analyzer connects to the host. BS-430-specific manual still needed.',
    tests: [
      { code: 'GLU', analyte: 'GLU', unit: 'mg/dL', decimals: 0, normal: [74, 99], abnormal: [128, 240], critical: [33, 560] },
      { code: 'UREA', analyte: 'UREA', unit: 'mg/dL', decimals: 0, normal: [18, 40], abnormal: [62, 120] },
      { code: 'CREA', analyte: 'CREA', unit: 'mg/dL', decimals: 2, normal: [0.65, 1.1], abnormal: [1.6, 3.4], critical: [0.2, 10.8] },
      { code: 'UA', analyte: 'UA', unit: 'mg/dL', decimals: 1, normal: [3.4, 6.2], abnormal: [7.8, 10.5] },
      { code: 'TC', analyte: 'CHOL', unit: 'mg/dL', decimals: 0, normal: [140, 195], abnormal: [228, 290] },
      { code: 'TG', analyte: 'TG', unit: 'mg/dL', decimals: 0, normal: [70, 145], abnormal: [190, 420] },
      { code: 'HDL-C', analyte: 'HDL', unit: 'mg/dL', decimals: 0, normal: [45, 68], abnormal: [26, 36] },
      { code: 'ALT', analyte: 'ALT', unit: 'U/L', decimals: 0, normal: [10, 35], abnormal: [68, 190] },
      { code: 'AST', analyte: 'AST', unit: 'U/L', decimals: 0, normal: [12, 34], abnormal: [58, 160] },
      { code: 'ALP', analyte: 'ALP', unit: 'U/L', decimals: 0, normal: [50, 115], abnormal: [180, 420] },
      { code: 'GGT', analyte: 'GGT', unit: 'U/L', decimals: 0, normal: [10, 40], abnormal: [85, 260] },
      { code: 'T-BIL', analyte: 'TBIL', unit: 'mg/dL', decimals: 2, normal: [0.3, 1.0], abnormal: [1.8, 4.5], critical: [0.1, 18] },
      { code: 'D-BIL', analyte: 'DBIL', unit: 'mg/dL', decimals: 2, normal: [0.05, 0.25], abnormal: [0.6, 2.2] },
      { code: 'TP', analyte: 'TP', unit: 'g/dL', decimals: 1, normal: [6.6, 8.0], abnormal: [5.2, 5.9] },
      { code: 'ALB', analyte: 'ALB', unit: 'g/dL', decimals: 1, normal: [3.7, 5.0], abnormal: [2.6, 3.2] },
      { code: 'CA', analyte: 'CA', unit: 'mg/dL', decimals: 1, normal: [8.8, 10.0], abnormal: [7.4, 8.1], critical: [5.6, 13.6] },
      { code: 'MG', analyte: 'MG', unit: 'mg/dL', decimals: 1, normal: [1.8, 2.4], abnormal: [1.2, 1.4] },
      { code: 'P', analyte: 'PHOS', unit: 'mg/dL', decimals: 1, normal: [2.7, 4.3], abnormal: [5.2, 6.8] },
      { code: 'CRP', analyte: 'CRP', unit: 'mg/L', decimals: 1, normal: [0.4, 4.2], abnormal: [18, 140] },
      { code: 'FE', analyte: 'IRON', unit: 'ug/dL', decimals: 0, normal: [70, 150], abnormal: [25, 45] },
      { code: 'AMY', analyte: 'AMY', unit: 'U/L', decimals: 0, normal: [35, 95], abnormal: [180, 520] },
      { code: 'CK', analyte: 'CK', unit: 'U/L', decimals: 0, normal: [50, 190], abnormal: [420, 1600] },
      { code: 'LDH', analyte: 'LDH', unit: 'U/L', decimals: 0, normal: [140, 220], abnormal: [320, 620] },
    ],
  },
  cobas_pure: {
    model: 'cobas_pure',
    name: 'Roche cobas pure',
    manufacturer: 'Roche',
    protocol: 'hl7',
    transport: 'tcp_client',
    defaultPort: 54000,
    bidirectional: true,
    department: 'CHEM',
    confidence: 'V',
    note: 'c 303 / e 402 / ISE. HL7 v2.5 over MLLP, UTF-8, IHE LAW message set (OUL^R22 results, QBP^Q11/RSP^K11 queries, OML^O33 orders); client or server, default port 54000. Codes here are example host codes.',
    tests: [
      { code: 'GLUC3', analyte: 'GLU', unit: 'mg/dL', decimals: 0, normal: [74, 99], abnormal: [130, 260], critical: [35, 540] },
      { code: 'CREJ2', analyte: 'CREA', unit: 'mg/dL', decimals: 2, normal: [0.65, 1.1], abnormal: [1.7, 3.6] },
      { code: 'UREAL', analyte: 'UREA', unit: 'mg/dL', decimals: 0, normal: [18, 40], abnormal: [65, 130] },
      { code: 'CHOL2', analyte: 'CHOL', unit: 'mg/dL', decimals: 0, normal: [140, 195], abnormal: [230, 300] },
      { code: 'TRIGL', analyte: 'TG', unit: 'mg/dL', decimals: 0, normal: [70, 145], abnormal: [200, 450] },
      { code: 'HDLC4', analyte: 'HDL', unit: 'mg/dL', decimals: 0, normal: [45, 68], abnormal: [25, 35] },
      { code: 'ALTL', analyte: 'ALT', unit: 'U/L', decimals: 0, normal: [10, 35], abnormal: [70, 210] },
      { code: 'ASTL', analyte: 'AST', unit: 'U/L', decimals: 0, normal: [12, 34], abnormal: [60, 170] },
      { code: 'HBA1C', analyte: 'HBA1C', unit: '%', decimals: 1, normal: [4.6, 5.6], abnormal: [7.2, 10.4] },
      { code: 'NA', analyte: 'NA', unit: 'mmol/L', decimals: 0, normal: [137, 144], abnormal: [128, 132], critical: [116, 163] },
      { code: 'K', analyte: 'K', unit: 'mmol/L', decimals: 1, normal: [3.7, 5.0], abnormal: [5.4, 5.9], critical: [2.3, 6.9] },
      { code: 'CL', analyte: 'CL', unit: 'mmol/L', decimals: 0, normal: [99, 106], abnormal: [92, 96] },
      { code: 'TSH', analyte: 'TSH', unit: 'uIU/mL', decimals: 3, normal: [0.6, 3.8], abnormal: [7.5, 18] },
      { code: 'FT4', analyte: 'FT4', unit: 'ng/dL', decimals: 2, normal: [1.0, 1.6], abnormal: [0.5, 0.8] },
      { code: 'VITD', analyte: 'VITD', unit: 'ng/mL', decimals: 1, normal: [31, 70], abnormal: [8, 18] },
    ],
  },
  cobas_e411: {
    model: 'cobas_e411',
    name: 'Roche cobas e 411',
    manufacturer: 'Roche',
    protocol: 'astm',
    transport: 'serial',
    defaultPort: 9104,
    serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
    bidirectional: true,
    department: 'IMM',
    confidence: 'V',
    specimenIdMax: 22,
    note: 'ASTM E1381/E1394 over RS-232 (9600 8N1 recommended), real-time host query and batch download. Test IDs are Roche application codes (ACN) the lab maps; the numbers here are placeholders. Simulated over TCP as if through a serial device server.',
    tests: [
      { code: '1010', analyte: 'TSH', unit: 'uIU/mL', decimals: 3, normal: [0.6, 3.8], abnormal: [6.8, 22] },
      { code: '1020', analyte: 'FT4', unit: 'ng/dL', decimals: 2, normal: [1.0, 1.6], abnormal: [0.45, 0.8] },
      { code: '1030', analyte: 'FT3', unit: 'pg/mL', decimals: 2, normal: [2.4, 4.0], abnormal: [4.9, 7.2] },
      { code: '1040', analyte: 'VITD', unit: 'ng/mL', decimals: 1, normal: [31, 70], abnormal: [7, 17] },
      { code: '1050', analyte: 'B12', unit: 'pg/mL', decimals: 0, normal: [260, 690], abnormal: [110, 180] },
      { code: '1060', analyte: 'FERR', unit: 'ng/mL', decimals: 1, normal: [40, 220], abnormal: [4, 11] },
      { code: '1070', analyte: 'PSA', unit: 'ng/mL', decimals: 2, normal: [0.3, 2.6], abnormal: [5.2, 14] },
      { code: '1080', analyte: 'BHCG', unit: 'mIU/mL', decimals: 1, normal: [0.1, 2.5], abnormal: [1200, 48000] },
      { code: '1090', analyte: 'PRL', unit: 'ng/mL', decimals: 1, normal: [6, 18], abnormal: [42, 95] },
      { code: '1100', analyte: 'INS', unit: 'uIU/mL', decimals: 1, normal: [4, 18], abnormal: [32, 60] },
    ],
  },
  ichroma3: {
    model: 'ichroma3',
    name: 'Boditech ichroma III',
    manufacturer: 'Boditech Med',
    protocol: 'ichroma_invented',
    transport: 'tcp_server',
    defaultPort: 9105,
    bidirectional: false,
    department: 'IMM',
    confidence: 'U',
    note: 'No public host-interface specification. This simulator uses an INVENTED line format only so the demo covers all six instruments. Do not treat it as Boditech\'s protocol.',
    tests: [
      { code: 'PCT', analyte: 'PCT', unit: 'ng/mL', decimals: 2, normal: [0.02, 0.09], abnormal: [0.8, 6.5], critical: [0.01, 25] },
      { code: 'TNI', analyte: 'TNI', unit: 'ng/mL', decimals: 3, normal: [0.001, 0.02], abnormal: [0.12, 2.4], critical: [0.001, 12] },
      { code: 'DDIMER', analyte: 'DDIMER', unit: 'ng/mL', decimals: 0, normal: [120, 420], abnormal: [900, 4200] },
      { code: 'HBA1C', analyte: 'HBA1C', unit: '%', decimals: 1, normal: [4.6, 5.6], abnormal: [7.0, 11.2] },
      { code: 'CRP', analyte: 'CRP', unit: 'mg/L', decimals: 1, normal: [0.5, 4.5], abnormal: [22, 160] },
    ],
  },
  medica_easystat: {
    model: 'medica_easystat',
    name: 'Medica EasyStat',
    manufacturer: 'Medica',
    protocol: 'medica_text',
    transport: 'serial',
    defaultPort: 9106,
    serial: { baudRate: 2400, dataBits: 8, parity: 'none', stopBits: 1 },
    bidirectional: false,
    department: 'BG',
    confidence: 'V',
    note: 'Blood gas / electrolytes. Sends its printout as plain ASCII over RS-232 at 2400 8N1 through Medica\'s cable, results only ("not ASTM or LIS enabled"). Staff key the sample ID on the analyzer. Simulated over TCP as if through a serial device server.',
    tests: [
      { code: 'pH', analyte: 'PH', unit: '', decimals: 3, normal: [7.36, 7.44], abnormal: [7.26, 7.31], critical: [7.08, 7.66] },
      { code: 'pCO2', analyte: 'PCO2', unit: 'mmHg', decimals: 1, normal: [36, 44], abnormal: [50, 62], critical: [17, 78] },
      { code: 'pO2', analyte: 'PO2', unit: 'mmHg', decimals: 1, normal: [82, 98], abnormal: [58, 72], critical: [34, 34] },
      { code: 'HCO3', analyte: 'HCO3', unit: 'mmol/L', decimals: 1, normal: [22.5, 25.5], abnormal: [16, 19.5] },
    ],
  },
};

export const MODELS = Object.keys(PROFILES) as InstrumentModel[];
