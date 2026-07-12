import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaView, Text, TouchableOpacity, View } from "react-native";
import { get, getToken } from "./src/api";
import { HomeScreen } from "./src/screens/HomeScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { PlayerScreen } from "./src/screens/PlayerScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { TitleScreen } from "./src/screens/TitleScreen";
import { AdminScreen } from "./src/screens/AdminScreen";
import { colors, styles } from "./src/theme";
import { Screen, User } from "./src/types";

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "login" });
  const [user, setUser] = useState<User | null>(null);

  // Restore an existing session on launch.
  useEffect(() => {
    (async () => {
      if (!(await getToken())) return;
      try {
        const res = await get<{ user: User }>("/api/account/profile");
        setUser(res.user);
        setScreen({ name: "home" });
      } catch {
        /* stay on login */
      }
    })();
  }, []);

  const navigate = (next: Screen) => setScreen(next);

  const body = () => {
    switch (screen.name) {
      case "login":
        return (
          <LoginScreen
            onLoggedIn={(u) => {
              setUser(u);
              navigate({ name: "home" });
            }}
            onSettings={() => navigate({ name: "settings" })}
          />
        );
      case "home":
        return <HomeScreen onOpenTitle={(id) => navigate({ name: "title", id })} />;
      case "title":
        return (
          <TitleScreen
            id={screen.id}
            onPlay={() => navigate({ name: "player", id: screen.id })}
            onBack={() => navigate({ name: "home" })}
          />
        );
      case "player":
        return <PlayerScreen id={screen.id} onBack={() => navigate({ name: "title", id: screen.id })} />;
      case "settings":
        return <SettingsScreen user={user} onBack={() => navigate({ name: user ? "home" : "login" })} onLogout={() => { setUser(null); navigate({ name: "login" }); }} />;
      case "admin":
        return <AdminScreen onBack={() => navigate({ name: "home" })} />;
    }
  };

  const tab = (label: string, target: Screen) => (
    <TouchableOpacity onPress={() => navigate(target)} style={{ padding: 12 }}>
      <Text style={{ color: screen.name === target.name ? colors.text : colors.dim, fontWeight: "700" }}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ flex: 1 }}>{body()}</View>
      {user && screen.name !== "player" && (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-around",
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.raised,
          }}
        >
          {tab("Home", { name: "home" })}
          {tab("Settings", { name: "settings" })}
          {user.role === "admin" && tab("Admin", { name: "admin" })}
        </View>
      )}
    </SafeAreaView>
  );
}
