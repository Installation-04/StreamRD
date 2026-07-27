import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Fetch wrapper for the Phosphor server API. Server URL and JWT are
 * persisted in AsyncStorage so they survive app restarts; every request
 * reads both before firing so switching servers/accounts takes effect
 * immediately without an app relaunch.
 */
const SERVER_KEY = 'ph_server_url';
const TOKEN_KEY = 'ph_token';

export const DEFAULT_SERVER = 'http://192.168.1.50:61337';

export const getServerUrl = async (): Promise<string> =>
  (await AsyncStorage.getItem(SERVER_KEY)) ?? DEFAULT_SERVER;

export const setServerUrl = (url: string): Promise<void> =>
  AsyncStorage.setItem(SERVER_KEY, url.trim().replace(/\/+$/, ''));

export const getToken = (): Promise<string | null> => AsyncStorage.getItem(TOKEN_KEY);

export const setToken = async (token: string | null): Promise<void> => {
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
};

export class ApiError extends Error {}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const [base, token] = await Promise.all([getServerUrl(), getToken()]);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new ApiError(`Cannot reach ${base}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);

export const post = <T>(path: string, data?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined });

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });

/** GET /api/health against an arbitrary (not-yet-saved) server URL — used by the settings "test connection" action. */
export async function testConnection(url: string): Promise<{ status: string; db: string; version: string }> {
  const clean = url.trim().replace(/\/+$/, '');
  const res = await fetch(`${clean}/api/health`);
  const body = (await res.json().catch(() => ({}))) as { status?: string; db?: string; version?: string };
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
  return {
    status: body.status ?? 'unknown',
    db: body.db ?? 'unknown',
    version: body.version ?? '?',
  };
}

/* ------------------------------ domain types ----------------------------- */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  active: boolean;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface SearchResult {
  indexerId: string;
  indexerName: string;
  title: string;
  link: string;
  hasMagnet: boolean;
  sizeBytes: number;
  seeders: number;
  peers: number;
  publishedAt: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  errors: string[];
}

export type JobStatus = 'queued' | 'downloading' | 'finished' | 'error';

export interface DownloadJob {
  id: string;
  title: string;
  sourceUrl: string;
  sizeBytes: number;
  seeders: number;
  indexerName: string | null;
  provider: string;
  status: JobStatus;
  progress: number;
  streamUrl: string | null;
  filename: string | null;
  error: string | null;
  createdAt: string;
}
