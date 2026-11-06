"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";

export default function SignupPage() {
  const { signup } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup(email, password, displayName);
      router.push("/setup");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container">
      <form className="panel auth-panel" onSubmit={submit}>
        <div className="panel-title">New account</div>
        <p className="dim" style={{ fontSize: 12, marginBottom: 16 }}>
          Connect your services and make this space your own.
        </p>
        <div className="field">
          <label htmlFor="signup-displayName">Display name</label>
          <input id="signup-displayName" autoComplete="name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="signup-email">Email</label>
          <input id="signup-email" autoComplete="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="signup-password">Password (min. 8 characters)</label>
          <input id="signup-password" autoComplete="new-password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn" disabled={busy} style={{ width: "100%" }}>
          {busy ? "..." : "> create account"}
        </button>
        <p className="dim" style={{ marginTop: 16, fontSize: 13 }}>
          Already registered? <Link href="/login">sign in</Link>
        </p>
      </form>
    </main>
  );
}
