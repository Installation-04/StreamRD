"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.push("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container">
      <form className="card auth-card" onSubmit={submit}>
        <h1 style={{ marginBottom: 20 }}>{t("auth.login")}</h1>
        <div className="field">
          <label htmlFor="login-email">{t("auth.email")}</label>
          <input id="login-email" autoComplete="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">{t("auth.password")}</label>
          <input id="login-password" autoComplete="current-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : t("auth.login")}
        </button>
        <p className="dim" style={{ marginTop: 16, fontSize: 14 }}>
          No account yet? <Link href="/signup" style={{ textDecoration: "underline" }}>{t("auth.signup")}</Link>
        </p>
      </form>
    </main>
  );
}
