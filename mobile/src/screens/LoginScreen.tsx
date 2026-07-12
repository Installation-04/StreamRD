import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { post, setToken } from "../api";
import { colors, styles } from "../theme";
import { User } from "../types";

export function LoginScreen({
  onLoggedIn,
  onSettings,
}: {
  onLoggedIn: (user: User) => void;
  onSettings: () => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "login"
          ? await post<{ token: string; user: User }>("/api/auth/login", { email, password })
          : await post<{ token: string; user: User }>("/api/auth/signup", {
              email,
              password,
              displayName,
            });
      await setToken(res.token);
      onLoggedIn(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.container, { justifyContent: "center", flex: 1 }]}>
      <Text style={[styles.h1, { color: colors.accent, textAlign: "center" }]}>STREAMRD</Text>
      {mode === "signup" && (
        <TextInput
          style={styles.input}
          placeholder="Display name"
          placeholderTextColor={colors.dim}
          value={displayName}
          onChangeText={setDisplayName}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.dim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <TouchableOpacity style={styles.button} onPress={submit} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setMode(mode === "login" ? "signup" : "login")}>
        <Text style={[styles.dim, { textAlign: "center", marginTop: 10 }]}>
          {mode === "login" ? "No account? Create one" : "Have an account? Sign in"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onSettings}>
        <Text style={[styles.dim, { textAlign: "center", marginTop: 18 }]}>Server settings</Text>
      </TouchableOpacity>
    </View>
  );
}
