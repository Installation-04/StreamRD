import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * API client for the mobile app. The server URL is user-configurable in
 * Settings so the same build works over LAN, reverse proxy or VPN.
 */
const SERVER_KEY = "sr_server_url";
const TOKEN_KEY = "sr_token";

export const DEFAULT_SERVER = "http://192.168.1.50:4000";

export async function getServerUrl(): Promise<string> {
  return (await AsyncStorage.getItem(SERVER_KEY)) ?? DEFAULT_SERVER;
}

export async function setServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_KEY, url.replace(/\/+$/, ""));
}

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function setToken(token: string | null): Promise<void> {
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const [base, token] = await Promise.all([getServerUrl(), getToken()]);
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, data?: unknown) =>
  api<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined });
export const put = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(data) });

/** Health probe used by the Settings screen's "Test connection" button. */
export async function testConnection(url: string): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`);
  const body = (await res.json()) as { status: string; db: string };
  return `Server ${body.status} (db ${body.db})`;
}
