import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Panel } from '../components/Panel';
import { TvButton } from '../components/TvButton';
import { TvTextInput } from '../components/TvTextInput';
import { BlinkingCursor } from '../components/Cursor';
import { colors, type } from '../theme';
import { setServerUrl, testConnection } from '../api';

export function SettingsScreen({
  initialServer,
  onSaved,
  onBack,
  canGoBack,
}: {
  initialServer: string;
  onSaved: () => void;
  onBack: () => void;
  canGoBack: boolean;
}) {
  const [server, setServer] = useState(initialServer);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [ok, setOk] = useState(false);

  const saveAndTest = async () => {
    setChecking(true);
    setStatus(null);
    setOk(false);
    try {
      const result = await testConnection(server);
      await setServerUrl(server);
      setStatus(`SERVER ${result.status.toUpperCase()} — DB ${result.db.toUpperCase()} — v${result.version}`);
      setOk(true);
    } catch (err) {
      setStatus(`CONNECTION FAILED: ${(err as Error).message}`);
      setOk(false);
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.center}>
      <View style={s.titleRow}>
        <Text style={type.title}>PHOSPHOR</Text>
        <BlinkingCursor style={{ marginLeft: 6 }} />
      </View>
      <Text style={[type.dim, { marginBottom: 24 }]}>SYSTEM CONFIGURATION</Text>

      <Panel title="Connection" style={s.panel}>
        <TvTextInput
          label="Server URL"
          value={server}
          onChangeText={setServer}
          placeholder="http://192.168.1.50:61337"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {status ? (
          <Text style={[type.body, { color: ok ? colors.phosphor : colors.red, marginBottom: 12 }]}>{status}</Text>
        ) : null}
        <View style={s.row}>
          <TvButton label={checking ? 'Testing...' : 'Save & test connection'} autoFocus onPress={saveAndTest} disabled={checking} />
          {ok ? <TvButton label="Continue" onPress={onSaved} /> : null}
          {canGoBack ? <TvButton label="Back" secondary onPress={onBack} /> : null}
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
