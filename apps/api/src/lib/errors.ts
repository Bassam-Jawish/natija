import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** An error with an HTTP status and a stable code the web app can translate. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public errors?: Record<string, string[]>,
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

type PgError = { code?: string; constraint?: string; detail?: string };

export function errorHandler(error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    return reply
      .status(error.status)
      .type('application/problem+json')
      .send({ title: error.message, status: error.status, code: error.code, errors: error.errors });
  }
  if (error instanceof ZodError) {
    const errors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join('.') || '_';
      (errors[key] ??= []).push(issue.message);
    }
    return reply.status(400).type('application/problem+json').send({ title: 'Invalid input', status: 400, code: 'validation', errors });
  }
  const pg = error as PgError;
  if (pg.code === '23505') {
    return reply.status(409).type('application/problem+json').send({ title: 'Already exists', status: 409, code: 'duplicate', detail: pg.constraint });
  }
  if (pg.code === '23503') {
    return reply.status(409).type('application/problem+json').send({ title: 'Referenced record missing or in use', status: 409, code: 'reference', detail: pg.constraint });
  }
  if (pg.code === '42501') {
    req.log.error({ err: error }, 'Row-level security refused a query');
    return reply.status(403).type('application/problem+json').send({ title: 'Forbidden', status: 403, code: 'forbidden' });
  }
  const fe = error as FastifyError;
  if (fe.statusCode === 429) {
    return reply.status(429).type('application/problem+json').send({ title: fe.message, status: 429, code: 'rate_limited' });
  }
  if (fe.statusCode && fe.statusCode < 500) {
    return reply.status(fe.statusCode).type('application/problem+json').send({ title: fe.message, status: fe.statusCode, code: fe.code ?? 'bad_request' });
  }
  req.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).type('application/problem+json').send({ title: 'Internal error', status: 500, code: 'internal' });
}
