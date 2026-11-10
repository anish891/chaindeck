// The only network code in the app: every call goes to /api/paper on this origin with the session cookie.
// A 401 SIGNED_OUT answer tells the page to show the sign-in form again.

import type { ApiError, ApiResult } from './types';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

let onSignedOut: (() => void) | null = null;
export function setSignedOutHandler(fn: (() => void) | null): void {
  onSignedOut = fn;
}

export async function api<T = Record<string, never>>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<ApiResult<T>> {
  const method = opts.method || 'GET';
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body || {});
  }
  let res: Response;
  let json: Record<string, unknown>;
  try {
    res = await fetch(`/api/paper${path}`, init);
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server.' };
  }
  if (res.status === 401 && json.code === 'SIGNED_OUT' && onSignedOut) onSignedOut();
  if (json.ok === true) return { ...(json as T), ok: true, status: res.status };
  // Most errors are { error: 'text', code }, but the order preview answers { error: { code, message } }.
  const e = json.error;
  const obj = e && typeof e === 'object' ? (e as { message?: unknown; code?: unknown }) : null;
  const error = typeof e === 'string' ? e : obj && typeof obj.message === 'string' ? obj.message : 'Request failed.';
  const code = typeof json.code === 'string' ? json.code : obj && typeof obj.code === 'string' ? obj.code : undefined;
  return { ok: false, status: res.status, error, code };
}

export const isOk = <T>(r: ApiResult<T>): r is T & { ok: true; status: number } => r.ok === true;
export const errorText = (r: ApiError, fallback: string): string => r.error || fallback;
