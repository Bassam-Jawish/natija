/**
 * Request context, clock and errors for mock mode: the in-browser stand-in for the API server.
 * Requests run one at a time (see ../index.ts), so a module-level "current context" plays the
 * role the server's AsyncLocalStorage plays.
 */

export type MockAuth = {
  sessionId: string;
  userId: string;
  labId: string;
  permissions: Set<string>;
  roleKeys: string[];
  user: {
    id: string;
    username: string;
    fullNameAr: string;
    fullNameEn: string;
    title: string | null;
    language: 'ar' | 'en' | null;
    departmentIds: string[];
    branchIds: string[];
  };
};

export type MockContext = {
  labId: string;
  userId: string | null;
  actorName: string | null;
  auth: MockAuth | null;
};

let current: MockContext | null = null;

/** The signed-in lab and user of the request being handled (like the server's ctx()). */
export function ctx(): MockContext {
  if (!current) throw new Error('Mock: no lab context (call inside a request or withContext)');
  return current;
}

export function hasContext(): boolean {
  return current !== null;
}

/** Run `fn` as a given lab and user; restores the previous context afterwards (also for async fn). */
export function withContext<T>(c: MockContext, fn: () => T): T {
  const prev = current;
  current = c;
  let out: T;
  try {
    out = fn();
  } catch (err) {
    current = prev;
    throw err;
  }
  if (out instanceof Promise) {
    return out.finally(() => {
      current = prev;
    }) as T;
  }
  current = prev;
  return out;
}

/* ------------------------------------------------------------------ clock */

let simulated: number | null = null;

/** "Now" for every timestamp the mock writes. The demo history moves it through the past month. */
export function now(): Date {
  return new Date(simulated ?? Date.now());
}

export function setClock(ms: number | null): void {
  simulated = ms;
}

/* ------------------------------------------------------------------ errors (same names as the server) */

/** An error with an HTTP status and a stable code the web app translates. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public errors?: Record<string, string[]>,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code = 'bad_request', message?: string, errors?: Record<string, string[]>) => new AppError(400, code, message, errors);
export const unauthorized = (code = 'unauthorized', message?: string) => new AppError(401, code, message);
export const forbidden = (code = 'forbidden', message?: string) => new AppError(403, code, message);
export const notFound = (code = 'not_found', message?: string) => new AppError(404, code, message);
export const conflict = (code = 'conflict', message?: string) => new AppError(409, code, message);

export function assertFound<T>(value: T | undefined | null, code = 'not_found'): T {
  if (value === undefined || value === null) throw notFound(code);
  return value;
}
