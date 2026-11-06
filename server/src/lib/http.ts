import type { z } from 'zod';

export class HttpError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(status: number, message: string, opts: { code?: string; details?: unknown } = {}) {
    super(message);
    this.status = status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, { details });
export const unauthorized = (message = 'Please sign in') => new HttpError(401, message);
export const forbidden = (message = 'You do not have access to this') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/** Validates input against a zod schema, throwing a 400 with field details on failure. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = details[0];
    throw new HttpError(400, first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid request', {
      details,
    });
  }
  return result.data;
}

/** Simple in-memory fixed-window rate limiter (per process). */
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 50_000) {
      for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
    }
    return;
  }
  bucket.count++;
  if (bucket.count > limit) throw new HttpError(429, 'Too many requests, please slow down');
}
