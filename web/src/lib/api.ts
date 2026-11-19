/** Thin client for the Updraft API. Keeps the session in localStorage and refreshes the access token once on 401. */

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phoneNumber: string; role: 'PLAYER' | 'FINANCE' | 'ADMIN' };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const KEY = 'updraft.session';
let session: Session | null = read();
const listeners = new Set<(s: Session | null) => void>();

function read(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function getSession() {
  return session;
}

export function setSession(s: Session | null) {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the session lasts for this tab only.
  }
  listeners.forEach((l) => l(s));
}

export function onSession(l: (s: Session | null) => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const current = session;
  if (!current) return false;
  refreshing ??= (async () => {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
    if (!res.ok) {
      setSession(null);
      return false;
    }
    setSession(await res.json());
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Sent as Idempotency-Key: the same key on a retry never moves money twice. */
  idempotencyKey?: string;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'No connection. Check your internet and try again.');
  }
  if (res.status === 401 && session && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, opts, true);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? 'Something went wrong', data.details ?? {});
  }
  return data as T;
}

export const newKey = () => crypto.randomUUID();
