import AsyncStorage from "@react-native-async-storage/async-storage";

/** Same API contract as the mobile client; server URL is set on-device. */
const SERVER_KEY = "sr_server_url";
const TOKEN_KEY = "sr_token";

export const DEFAULT_SERVER = "http://192.168.1.50:4000";

export const getServerUrl = async (): Promise<string> =>
  (await AsyncStorage.getItem(SERVER_KEY)) ?? DEFAULT_SERVER;

export const setServerUrl = (url: string): Promise<void> =>
  AsyncStorage.setItem(SERVER_KEY, url.replace(/\/+$/, ""));

export const getToken = (): Promise<string | null> => AsyncStorage.getItem(TOKEN_KEY);

export const setToken = async (token: string | null): Promise<void> => {
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
};

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

export async function testConnection(url: string): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`);
  const body = (await res.json()) as { status: string };
  return `Server ${body.status}`;
}
