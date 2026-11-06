"use client";

import type { DownloadJob } from "./types";

/**
 * Minimal fetch wrapper for the Phosphor API. The base URL comes from
 * NEXT_PUBLIC_API_BASE_URL so the same build works over LAN, a reverse
 * proxy, or a VPN tunnel.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:61337";

const TOKEN_COOKIE = "ph_token";
const ROLE_COOKIE = "ph_role";

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
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
  document.cookie = `${ROLE_COOKIE}=${role}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}

export function clearSession(): void {
  document.cookie = `${TOKEN_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${ROLE_COOKIE}=; path=/; max-age=0`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryable = false, public retryAfterMs = 0, public job?: DownloadJob) {
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
    const error = body as { error?: string; retryable?: boolean; retryAfterMs?: number; job?: DownloadJob };
    throw new ApiError(res.status, error.error ?? `HTTP ${res.status}`, error.retryable === true, error.retryAfterMs ?? 0, error.job);
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, data?: unknown) =>
  api<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined });
export const put = <T>(path: string, data: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
