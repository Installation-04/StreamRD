"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { get, post } from "@/lib/api";

type Registration = { mode: "open" | "invite" | "closed"; bootstrapAvailable: boolean };
type Invitation = { email: string; expiresAt: string; libraries?: string[]; limited?: boolean };

export default function SignupPage() {
  const { signup } = useAuth();
  const router = useRouter();
  const fragment = useRef<{ token: string | null } | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Opening an invitation while /signup is already open is a same-document
    // fragment navigation. React does not remount this page for that change.
    const acceptFragment = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      if (!params.has("invite")) return;
      fragment.current = { token: params.get("invite") || "invalid" };
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      setInvitation(null);
      setError(null);
      setRetry(value => value + 1);
    };
    window.addEventListener("hashchange", acceptFragment);
    return () => window.removeEventListener("hashchange", acceptFragment);
  }, []);

  useEffect(() => {
    // Invitation secrets never enter query strings, browser storage or referrers.
    // Retain the parsed fragment in memory so React's development effect replay
    // can re-check the same invitation after removing it from the address bar.
    if (!fragment.current) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      fragment.current = { token: params.has("invite") ? params.get("invite") || "invalid" : null };
      if (params.has("invite")) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    const token = fragment.current.token;
    setInviteToken(token);
    setChecking(true);
    setCheckError(null);
    let active = true;
    void (async () => {
      try {
        const policy = await get<Registration>("/api/auth/registration");
        if (!active) return;
        setRegistration(policy);
        if (token) {
          const details = await post<Invitation>("/api/auth/invitation", { inviteToken: token });
          if (!active) return;
          setInvitation(details);
          setEmail(details.email);
        }
      } catch (err) {
        if (active) setCheckError((err as Error).message);
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, [retry]);

  const allowed = registration && !checking && !checkError && (
    registration.bootstrapAvailable || registration.mode === "open" || (registration.mode === "invite" && invitation)
  );
  const ownerSetup = registration?.bootstrapAvailable && !invitation;
  const title = invitation ? "Accept your invitation" : ownerSetup ? "Set up your server" : "Create an account";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allowed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signup(email, password, displayName, inviteToken ?? undefined);
      router.push(invitation ? "/shared-libraries" : "/setup");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container">
      <form className="card auth-card" onSubmit={submit}>
        <h1 style={{ marginBottom: 8 }}>{title}</h1>
        <p className="dim" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
          {invitation ? "Choose your name and password to join this server." : ownerSetup
            ? "Create the first account to manage access and configure this server. If an owner email is configured, use that address."
            : "A personal account keeps your viewing activity and account settings separate."}
        </p>
        {checking && <p className="dim" role="status">Checking server access…</p>}
        {checkError && <div role="alert" style={{ marginBottom: 20 }}>
          <p className="error-text">{checkError}</p>
          <p className="dim" style={{ fontSize: 13, lineHeight: 1.7, margin: "10px 0" }}>
            {inviteToken ? "The invitation may have expired, been used or been revoked. Ask the server administrator for a new link." : "We could not check whether this server accepts new accounts."}
          </p>
          <button className="btn btn-secondary" type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </div>}
        {!checking && !checkError && !allowed && <div style={{ marginBottom: 20 }} role="status">
          <strong>{registration?.mode === "closed" ? "New accounts are paused" : "An invitation is required"}</strong>
          <p className="dim" style={{ fontSize: 13, lineHeight: 1.7, marginTop: 8 }}>
            {registration?.mode === "closed" ? "The server administrator has closed registration. Existing members can still sign in."
              : "Ask the server administrator to invite your email address, then open the link they send you."}
          </p>
        </div>}
        {allowed && <>
          {invitation && <p className="dim" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 20 }}>
            Invited as <strong>{invitation.email}</strong>. This link expires {new Date(invitation.expiresAt).toLocaleDateString()} and can be used once.
            {invitation.libraries && invitation.libraries.length > 0 && <> You will be able to watch: <strong>{invitation.libraries.join(", ")}</strong>.</>}{invitation.limited && <> This account will have a viewing limit set by the server administrator.</>}
          </p>}
          <div className="field">
            <label htmlFor="signup-displayName">Display name</label>
            <input id="signup-displayName" autoComplete="name" required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="signup-email">Email</label>
            <input id="signup-email" autoComplete="email" type="email" required readOnly={Boolean(invitation)} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="signup-password">Password (min. 8 characters)</label>
            <input id="signup-password" autoComplete="new-password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="btn" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Creating account…" : invitation ? "Accept invitation" : ownerSetup ? "Create server account" : "Sign up"}
          </button>
        </>}
        <p className="dim" style={{ marginTop: 20, fontSize: 14 }}>
          Already registered? <Link href="/login" style={{ textDecoration: "underline" }}>Sign in</Link>
        </p>
      </form>
    </main>
  );
}
