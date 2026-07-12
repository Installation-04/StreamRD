"use client";

/**
 * Minimal fetch wrapper for the StreamRD API. The base URL comes from
 * NEXT_PUBLIC_API_BASE_URL so the same build works over LAN, a reverse
 * proxy, or a VPN tunnel.
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const TOKEN_COOKIE = "sr_token";
const ROLE_COOKIE = "sr_role";

export function getToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

export function storeSession(token: string, role: string): void {
  const maxAge = 60 * 60 * 24 * 7;
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; samesite=lax`;
  // Role cookie is only a UX hint for middleware redirects; the API
  // enforces the real RBAC on every request.
  document.cookie = `${ROLE_COOKIE}=${role}; path=/; max-age=${maxAge}; samesite=lax`;
}

export function clearSession(): void {
  document.cookie = `${TOKEN_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${ROLE_COOKIE}=; path=/; max-age=0`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
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
