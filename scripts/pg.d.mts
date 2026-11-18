// Types for scripts/pg.mjs (local PostgreSQL 18 managed from Node).
export declare const PG_PORT: number;
export declare const DATA_DIR: string;

export interface EmbeddedServer {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export declare function createServer(): EmbeddedServer;
export declare function isRunning(): Promise<boolean>;
/** Start (initialising on first run) unless already running; returns null when it was already running. */
export declare function startServer(opts?: { databases?: string[] }): Promise<EmbeddedServer | null>;
export declare function ensureDatabases(databases: string[]): Promise<void>;
