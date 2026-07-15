/**
 * StreamRD for Android TV / Fire TV.
 *
 * Navigation is remote-first: every actionable element is a focusable
 * Pressable with a visible focus ring; D-pad movement is handled by the
 * platform's native focus engine.
 */
import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Video from "react-native-video";
import { get, getToken, post, setServerUrl, setToken, getServerUrl, testConnection } from "./src/api";

interface Title {
  id: string;
  name: string;
  description: string;
  year: number | null;
  genres: string[];
  posterUrl: string | null;
  backdropUrl: string | null;
}
interface CatalogRow {
  id: string;
  label: string;
  titles: Title[];
}
interface StreamInfo {
  url: string;
  provider: string;
  quality?: string;
}

type Screen =
  | { name: "settings" }
  | { name: "login" }
  | { name: "home" }
  | { name: "detail"; title: Title }
  | { name: "player"; title: Title };

const colors = {
  bg: "#0b0b0f",
  raised: "#16161d",
  text: "#f2f2f5",
  dim: "#9a9aa8",
  accent: "#e50914",
  focus: "#ffffff",
};

/** Focusable button with a TV focus ring. */
function TvButton({
  label,
  onPress,
  autoFocus,
  secondary,
}: {
  label: string;
  onPress: () => void;
  autoFocus?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hasTVPreferredFocus={autoFocus}
      style={({ focused }) => [
        s.button,
        secondary && s.buttonSecondary,
        focused && s.focused,
      ]}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

function PosterCard({ title, onPress }: { title: Title; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ focused }) => [s.poster, focused && s.focused, focused && { transform: [{ scale: 1.08 }] }]}
    >
      {title.posterUrl ? (
        <Image source={{ uri: title.posterUrl }} style={{ flex: 1, borderRadius: 6 }} />
      ) : (
        <View style={{ flex: 1, justifyContent: "center", padding: 8 }}>
          <Text style={{ color: colors.dim, textAlign: "center" }}>{title.name}</Text>
        </View>
      )}
    </Pressable>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "login" });
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Settings state
  const [server, setServer] = useState("");
  const [health, setHealth] = useState<string | null>(null);
  // Player state
  const [stream, setStream] = useState<StreamInfo | null>(null);

  const loadHome = useCallback(async () => {
    try {
      const res = await get<{ rows: CatalogRow[] }>("/api/catalog/rows");
      setRows(res.rows);
      setError(null);
      setScreen({ name: "home" });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    getServerUrl().then(setServer);
    getToken().then((token) => {
      if (token) void loadHome();
    });
  }, [loadHome]);

  const login = async () => {
    setError(null);
    try {
      const res = await post<{ token: string }>("/api/auth/login", { email, password });
      await setToken(res.token);
      await loadHome();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const play = async (title: Title) => {
    setStream(null);
    setError(null);
    setScreen({ name: "player", title });
    try {
      const res = await post<{ stream: StreamInfo }>("/api/play", { titleId: title.id });
      setStream(res.stream);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (screen.name === "settings") {
    return (
      <View style={s.screenCenter}>
        <Text style={s.logo}>STREAMRD</Text>
        <Text style={s.h2}>Server URL</Text>
        <TextInput
          style={s.input}
          value={server}
          onChangeText={setServer}
          placeholder="http://192.168.1.50:47821"
          placeholderTextColor={colors.dim}
          autoCapitalize="none"
        />
        {health && <Text style={{ color: colors.dim, marginBottom: 10 }}>{health}</Text>}
        <TvButton
          label="Save & test"
          autoFocus
          onPress={async () => {
            await setServerUrl(server);
            try {
              setHealth(await testConnection(server));
            } catch {
              setHealth("Cannot reach server");
            }
          }}
        />
        <TvButton label="Back" secondary onPress={() => setScreen({ name: "login" })} />
      </View>
    );
  }

  if (screen.name === "login") {
    return (
      <View style={s.screenCenter}>
        <Text style={s.logo}>STREAMRD</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={colors.dim}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={colors.dim}
          secureTextEntry
        />
        {error && <Text style={s.error}>{error}</Text>}
        <TvButton label="Sign in" autoFocus onPress={login} />
        <TvButton label="Server settings" secondary onPress={() => setScreen({ name: "settings" })} />
      </View>
    );
  }

  if (screen.name === "detail") {
    const title = screen.title;
    return (
      <ScrollView style={s.screen} contentContainerStyle={{ padding: 48 }}>
        <Text style={s.h1}>{title.name}</Text>
        <Text style={{ color: colors.dim, marginBottom: 16 }}>
          {[title.year, ...title.genres].filter(Boolean).join(" · ")}
        </Text>
        <Text style={{ color: colors.text, fontSize: 18, lineHeight: 28, maxWidth: 800, marginBottom: 28 }}>
          {title.description}
        </Text>
        <View style={{ flexDirection: "row", gap: 16 }}>
          <TvButton label="▶ Play" autoFocus onPress={() => play(title)} />
          <TvButton label="Back" secondary onPress={() => setScreen({ name: "home" })} />
        </View>
      </ScrollView>
    );
  }

  if (screen.name === "player") {
    return (
      <View style={[s.screen, { backgroundColor: "#000" }]}>
        {error ? (
          <View style={{ padding: 48 }}>
            <Text style={s.error}>{error}</Text>
            <TvButton label="Back" autoFocus onPress={() => setScreen({ name: "detail", title: screen.title })} />
          </View>
        ) : stream ? (
          <Video source={{ uri: stream.url }} style={{ flex: 1 }} controls resizeMode="contain" />
        ) : (
          <Text style={{ color: colors.dim, padding: 48 }}>Resolving stream…</Text>
        )}
      </View>
    );
  }

  // Home
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 40 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 20 }}>
        <Text style={[s.logo, { marginBottom: 0, flex: 1, textAlign: "left" }]}>STREAMRD</Text>
        <TvButton
          label="Sign out"
          secondary
          onPress={async () => {
            await setToken(null);
            setScreen({ name: "login" });
          }}
        />
      </View>
      {error && <Text style={s.error}>{error}</Text>}
      {rows.map((row) => (
        <View key={row.id} style={{ marginBottom: 26 }}>
          <Text style={s.h2}>{row.label}</Text>
          <FlatList
            horizontal
            data={row.titles}
            keyExtractor={(t) => t.id}
            renderItem={({ item }) => (
              <PosterCard
                title={item}
                onPress={() => setScreen({ name: "detail", title: item })}
              />
            )}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenCenter: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: 48,
  },
  logo: { color: colors.accent, fontSize: 42, fontWeight: "900", marginBottom: 28, letterSpacing: 2 },
  h1: { color: colors.text, fontSize: 40, fontWeight: "800", marginBottom: 8 },
  h2: { color: colors.text, fontSize: 22, fontWeight: "700", marginBottom: 12 },
  error: { color: "#e74c3c", fontSize: 16, marginVertical: 10 },
  input: {
    backgroundColor: colors.raised,
    color: colors.text,
    width: 480,
    borderRadius: 6,
    padding: 14,
    fontSize: 18,
    marginBottom: 14,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 28,
    marginVertical: 6,
    borderWidth: 3,
    borderColor: "transparent",
  },
  buttonSecondary: { backgroundColor: colors.raised },
  buttonText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  focused: { borderWidth: 3, borderColor: colors.focus },
  poster: {
    width: 150,
    height: 225,
    marginRight: 14,
    borderRadius: 6,
    backgroundColor: colors.raised,
    borderWidth: 3,
    borderColor: "transparent",
  },
});
