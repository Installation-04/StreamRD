"use client";

import type { FileSelection } from "./types";

/**
 * Minimal fetch wrapper for the StreamRD API. The base URL comes from
 * NEXT_PUBLIC_API_BASE_URL so the same build works over LAN, a reverse
 * proxy, or a VPN tunnel.
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:47821";

const TOKEN_COOKIE = "sr_token";
const ROLE_COOKIE = "sr_role";

/**
 * Cookie sessions: when the API shares the page's origin (the single container), the server keeps the
 * session in an HttpOnly cookie that scripts cannot read, and this client never holds the token.
 * Split installs on another origin keep the previous behaviour (token in a script-readable cookie, Bearer header).
 */
export function cookieSessions(): boolean {
  if (typeof window === "undefined") return false;
  try { return new URL(API_BASE || "/", window.location.href).origin === window.location.origin; } catch { return false; }
}
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

export function getToken(): string | null {
  return cookieSessions() ? null : readCookie(TOKEN_COOKIE);
}

/** Whether this browser believes it is signed in (the server still decides on every request). */
export function hasSession(): boolean {
  return cookieSessions() ? readCookie(ROLE_COOKIE) !== null : getToken() !== null;
}

/** token is absent for cookie sessions: the server set the HttpOnly cookie itself. */
export function storeSession(token: string | undefined, role: string): void {
  const maxAge = 60 * 60 * 24 * 7;
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  if (token && !cookieSessions()) document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
  // Role cookie is only a UX hint for middleware redirects; the API
  // enforces the real RBAC on every request.
  document.cookie = `${ROLE_COOKIE}=${role}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}

export function clearSession(): void {
  document.cookie = `${TOKEN_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${ROLE_COOKIE}=; path=/; max-age=0`;
}

/** Headers that authenticate a request: a Bearer token for split installs, the cookie-session marker otherwise. */
function authHeaders(): Record<string, string> {
  if (cookieSessions()) return { "X-Session": "cookie" };
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** fetch with the session attached, for downloads and other non-JSON calls. */
export function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public pending = false, public retryAfterMs = 5000, public fileSelection?: FileSelection) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = body as { error?: string; pending?: boolean; retryAfterMs?: number; selectionRequired?: boolean } & FileSelection;
    throw new ApiError(res.status, error.error ?? `HTTP ${res.status}`, error.pending === true, error.retryAfterMs, error.selectionRequired ? { provider: error.provider, sourceIndex: error.sourceIndex, files: error.files } : undefined);
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, data?: unknown) =>
  api<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined });
export const put = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
