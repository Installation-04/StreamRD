import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, TouchableOpacity } from "react-native";
import {
  get,
  getServerUrl,
  post,
  put,
  setServerUrl,
  setToken,
  testConnection,
} from "../api";
import { colors, styles } from "../theme";
import { User } from "../types";

const PROVIDERS = [
  { id: "realdebrid", name: "Real-Debrid", field: "realDebridToken" },
  { id: "alldebrid", name: "AllDebrid", field: "allDebridApiKey" },
  { id: "premiumize", name: "Premiumize.me", field: "premiumizeApiKey" },
] as const;

export function SettingsScreen({
  user,
  onBack,
  onLogout,
}: {
  user: User | null;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [server, setServer] = useState("");
  const [health, setHealth] = useState<string | null>(null);
  const [primary, setPrimary] = useState("realdebrid");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [savedHints, setSavedHints] = useState<Record<string, string | null>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getServerUrl().then(setServer);
    if (user) {
      get<{ primaryProvider: string; keys: Record<string, string | null> }>(
        "/api/account/debrid"
      )
        .then((res) => {
          setPrimary(res.primaryProvider);
          setSavedHints(res.keys);
        })
        .catch(() => {});
    }
  }, [user]);

  const saveServer = async () => {
    await setServerUrl(server);
    setHealth(null);
    try {
      setHealth(await testConnection(server));
    } catch {
      setHealth(`Cannot reach ${server}`);
    }
  };

  const saveDebrid = async () => {
    setMsg(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = { primaryProvider: primary };
      for (const p of PROVIDERS) {
        if (keys[p.id]) payload[p.field] = keys[p.id];
      }
      await put("/api/account/debrid", payload);
      setKeys({});
      setMsg("Debrid settings saved.");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const logout = async () => {
    try {
      await post("/api/auth/logout");
    } catch {
      /* clear locally regardless */
    }
    await setToken(null);
    onLogout();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.dim}>← Back</Text>
      </TouchableOpacity>
      <Text style={[styles.h1, { marginTop: 12 }]}>Settings</Text>

      <Text style={styles.h2}>Server</Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        placeholder="http://192.168.1.50:47821"
        placeholderTextColor={colors.dim}
        value={server}
        onChangeText={setServer}
      />
      {health && <Text style={health.startsWith("Server") ? styles.ok : styles.error}>{health}</Text>}
      <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={saveServer}>
        <Text style={styles.buttonText}>Save & test connection</Text>
      </TouchableOpacity>

      {user && (
        <>
          <Text style={styles.h2}>Debrid services</Text>
          <Text style={[styles.dim, { marginBottom: 8 }]}>Primary provider</Text>
          {PROVIDERS.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.button, primary === p.id ? {} : styles.buttonSecondary]}
              onPress={() => setPrimary(p.id)}
            >
              <Text style={styles.buttonText}>
                {p.name}
                {savedHints[p.id] ? `  (key ${savedHints[p.id]})` : ""}
              </Text>
            </TouchableOpacity>
          ))}
          {PROVIDERS.map((p) => (
            <TextInput
              key={p.id}
              style={[styles.input, { marginTop: 8 }]}
              autoCapitalize="none"
              secureTextEntry
              placeholder={`${p.name} API key${savedHints[p.id] ? " (leave blank to keep)" : ""}`}
              placeholderTextColor={colors.dim}
              value={keys[p.id] ?? ""}
              onChangeText={(v) => setKeys((k) => ({ ...k, [p.id]: v }))}
            />
          ))}
          {msg && <Text style={styles.ok}>{msg}</Text>}
          {error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity style={styles.button} onPress={saveDebrid}>
            <Text style={styles.buttonText}>Save debrid settings</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.button, styles.buttonSecondary, { marginTop: 20 }]} onPress={logout}>
            <Text style={styles.buttonText}>Sign out ({user.email})</Text>
          </TouchableOpacity>
        </>
      )}
      <Text style={{ height: 30 }} />
    </ScrollView>
  );
}
