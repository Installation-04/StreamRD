/**
 * Phosphor for Android TV / Fire TV.
 *
 * A retro terminal "debrid cockpit": search torrent indexers, one-click add
 * a result to your debrid provider, and stream the resolved file once it's
 * ready. Navigation is remote-first — every actionable element is a
 * focusable Pressable with a visible focus ring, and the platform's D-pad
 * focus engine handles movement (no custom focus-index tracking here).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Scanlines } from './src/components/Scanlines';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { DownloadsScreen } from './src/screens/DownloadsScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { colors, mono } from './src/theme';
import { DownloadJob, getServerUrl, getToken, setToken } from './src/api';

type Screen =
  | { name: 'boot' }
  | { name: 'settings' }
  | { name: 'auth' }
  | { name: 'search' }
  | { name: 'downloads' }
  | { name: 'player'; job: DownloadJob };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'boot' });
  const [server, setServer] = useState('');
  const [cameFromAuth, setCameFromAuth] = useState(false);

  useEffect(() => {
    (async () => {
      const [url, token] = await Promise.all([getServerUrl(), getToken()]);
      setServer(url);
      if (token) setScreen({ name: 'search' });
      else setScreen({ name: 'settings' });
    })();
  }, []);

  const goSearch = () => setScreen({ name: 'search' });
  const goDownloads = () => setScreen({ name: 'downloads' });

  const signOut = async () => {
    await setToken(null);
    setScreen({ name: 'auth' });
  };

  return (
    <View style={s.root}>
      {screen.name === 'boot' ? (
        <View style={s.boot}>
          <Text style={s.bootText}>PHOSPHOR BOOTING...</Text>
        </View>
      ) : screen.name === 'settings' ? (
        <SettingsScreen
          initialServer={server}
          canGoBack={cameFromAuth}
          onBack={() => setScreen({ name: 'auth' })}
          onSaved={() => setScreen({ name: 'auth' })}
        />
      ) : screen.name === 'auth' ? (
        <AuthScreen
          onAuthenticated={goSearch}
          onOpenSettings={() => {
            setCameFromAuth(true);
            setScreen({ name: 'settings' });
          }}
        />
      ) : screen.name === 'search' ? (
        <SearchScreen
          onNavigate={(target) => (target === 'search' ? goSearch() : goDownloads())}
          onSignOut={signOut}
          onOpenQueue={goDownloads}
        />
      ) : screen.name === 'downloads' ? (
        <DownloadsScreen
          onNavigate={(target) => (target === 'search' ? goSearch() : goDownloads())}
          onSignOut={signOut}
          onPlay={(job) => setScreen({ name: 'player', job })}
        />
      ) : (
        <PlayerScreen job={screen.job} onBack={goDownloads} />
      )}
      {screen.name !== 'player' ? <Scanlines /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  bootText: { fontFamily: mono, color: colors.phosphor, fontSize: 20, letterSpacing: 2 },
});
