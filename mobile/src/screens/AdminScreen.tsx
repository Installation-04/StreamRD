import { useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity } from "react-native";
import { get } from "../api";
import { styles } from "../theme";

interface AdminHealth {
  db: string;
  users: number;
  titles: number;
  playback: { totalPlays: number; playsLastHour: number; recentFailures: number };
  providers: Array<{ id: string; enabled: boolean }>;
}

/**
 * Minimal admin status view. Full admin controls (users, catalog, settings)
 * live in the web dashboard at /admin.
 */
export function AdminScreen({ onBack }: { onBack: () => void }) {
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<AdminHealth>("/api/admin/health")
      .then(setHealth)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.dim}>← Back</Text>
      </TouchableOpacity>
      <Text style={[styles.h1, { marginTop: 12 }]}>Server health</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {health && (
        <>
          <Text style={styles.text}>Database: {health.db}</Text>
          <Text style={styles.text}>Users: {health.users}</Text>
          <Text style={styles.text}>Titles: {health.titles}</Text>
          <Text style={styles.text}>
            Plays: {health.playback.totalPlays} total, {health.playback.playsLastHour} last hour
          </Text>
          <Text style={styles.text}>Failures (24h): {health.playback.recentFailures}</Text>
          <Text style={styles.h2}>Providers</Text>
          {health.providers.map((p) => (
            <Text key={p.id} style={styles.text}>
              {p.id}: {p.enabled ? "enabled" : "disabled"}
            </Text>
          ))}
          <Text style={[styles.dim, { marginTop: 16 }]}>
            Manage users, catalog and settings from the web admin dashboard.
          </Text>
        </>
      )}
    </ScrollView>
  );
}
