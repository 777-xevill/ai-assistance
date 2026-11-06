export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

export async function api<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? (hasBody || opts.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.form ?? (hasBody ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  });
  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  return data as T;
}

/** Helpers scoped to one workspace: ws(wid).get('/catalog') → GET /api/w/:wid/catalog */
export function ws(wid: string) {
  const base = `/api/w/${wid}`;
  return {
    get: <T = any>(path = '', signal?: AbortSignal) => api<T>(base + path, { signal }),
    post: <T = any>(path: string, body?: unknown) => api<T>(base + path, { method: 'POST', body: body ?? {} }),
    patch: <T = any>(path: string, body: unknown) => api<T>(base + path, { method: 'PATCH', body }),
    del: <T = any>(path: string, body?: unknown) => api<T>(base + path, { method: 'DELETE', body }),
    upload: <T = any>(path: string, form: FormData) => api<T>(base + path, { method: 'POST', form }),
    url: (path: string) => base + path,
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
