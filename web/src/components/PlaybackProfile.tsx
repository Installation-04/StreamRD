"use client";
import { Profile } from "@/lib/types";

export function PlaybackProfile({ profileId, profiles, ready, onChange }: { profileId: string | null; profiles: Profile[]; ready: boolean; onChange: (id: string | null) => void }) {
  return <label style={{ display: "inline-flex", alignItems: "center", gap: 8, margin: "12px 0" }}>
    Watching as
    <select aria-label="Viewing profile" value={profileId ?? ""} disabled={!ready} onChange={event => onChange(event.target.value || null)}>
      <option value="">Account</option>
      {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select>
  </label>;
}
