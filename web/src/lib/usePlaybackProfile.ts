"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Profile } from "./types";

/** Persist a choice per account, never reuse another account's profile ID. */
export function usePlaybackProfile() {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<{ user: { id: string }; profiles: Profile[] }>("/api/account/profile", { signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return;
      setAccountId(page.user.id); setProfiles(page.profiles);
      let saved: string | null = null;
      try { saved = localStorage.getItem(`sr_profile:${page.user.id}`); } catch { /* storage may be unavailable */ }
      setProfileId(page.profiles.some(profile => profile.id === saved) ? saved : null);
      setReady(true);
    }).catch(err => {
      if (controller.signal.aborted) return;
      if (!(err instanceof ApiError && err.status === 401)) setError("Could not load viewing profiles. Refresh to retry.");
      setReady(true);
    });
    return () => controller.abort();
  }, []);
  function chooseProfile(id: string | null) {
    if (id !== null && !profiles.some(profile => profile.id === id)) return;
    setProfileId(id);
    if (accountId) try {
      if (id) localStorage.setItem(`sr_profile:${accountId}`, id); else localStorage.removeItem(`sr_profile:${accountId}`);
    } catch { /* the choice still works for this page */ }
  }
  return { profileId, profiles, ready, error, chooseProfile };
}
