import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Panel } from '../components/Panel';
import { TvButton } from '../components/TvButton';
import { TvTextInput } from '../components/TvTextInput';
import { BlinkingCursor } from '../components/Cursor';
import { colors, type } from '../theme';
import { AuthResponse, post, setToken } from '../api';

export function AuthScreen({
  onAuthenticated,
  onOpenSettings,
}: {
  onAuthenticated: () => void;
  onOpenSettings: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const body =
        mode === 'login' ? { email, password } : { email, password, displayName };
      const res = await post<AuthResponse>(path, body);
      await setToken(res.token);
      onAuthenticated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.center}>
      <View style={s.titleRow}>
        <Text style={type.title}>PHOSPHOR</Text>
        <BlinkingCursor style={{ marginLeft: 6 }} />
      </View>
      <Text style={[type.dim, { marginBottom: 24 }]}>
        {mode === 'login' ? 'IDENTIFY YOURSELF' : 'REGISTER NEW OPERATOR'}
      </Text>

      <Panel title={mode === 'login' ? 'Sign in' : 'Create account'} style={s.panel}>
        <TvTextInput
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        {mode === 'signup' ? (
          <TvTextInput label="Display name" value={displayName} onChangeText={setDisplayName} autoCorrect={false} />
        ) : null}
        <TvTextInput label="Password" value={password} onChangeText={setPassword} secureTextEntry />

        {error ? <Text style={[type.body, { color: colors.red, marginBottom: 12 }]}>{error.toUpperCase()}</Text> : null}

        <View style={s.row}>
          <TvButton
            label={busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account'}
            autoFocus
            disabled={busy}
            onPress={submit}
          />
          <TvButton
            label={mode === 'login' ? 'Need an account?' : 'Have an account?'}
            secondary
            onPress={() => {
              setError(null);
              setMode(mode === 'login' ? 'signup' : 'login');
            }}
          />
          <TvButton label="Server settings" secondary onPress={onOpenSettings} />
        </View>
      </Panel>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 48 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  panel: { width: 560 },
  row: { flexDirection: 'row', gap: 12, marginTop: 8, flexWrap: 'wrap' },
});
