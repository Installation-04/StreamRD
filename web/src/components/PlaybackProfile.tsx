"use client";
import { Profile } from "@/lib/types";
import { Icon } from "./Icon";
export function PlaybackProfile({ profileId, profiles, ready, onChange }: { profileId: string | null; profiles: Profile[]; ready: boolean; onChange: (id: string | null) => void }) {
  return <label className="playback-profile"><Icon name="user" size={16} /><span>Watching as</span><select aria-label="Viewing profile" value={profileId ?? ""} disabled={!ready} onChange={event => onChange(event.target.value || null)}><option value="">Account</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>;
}
