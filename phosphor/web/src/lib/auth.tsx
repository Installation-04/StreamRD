"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ApiError, clearSession, get, getToken, post, storeSession } from "./api";
import { User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const res = await get<{ user: User }>("/api/account/profile");
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await post<{ token: string; user: User }>("/api/auth/login", { email, password });
    storeSession(res.token, res.user.role);
    setUser(res.user);
  }, []);

  const signup = useCallback(async (email: string, password: string, displayName: string) => {
    const res = await post<{ token: string; user: User }>("/api/auth/signup", { email, password, displayName });
    storeSession(res.token, res.user.role);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await post("/api/auth/logout");
    } catch {
      /* session is cleared locally regardless */
    }
    clearSession();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
