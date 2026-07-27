import React, { useState } from 'react';
import { BackHandler, StyleSheet, Text, View } from 'react-native';
import Video, { OnLoadData, OnVideoErrorData } from 'react-native-video';
import { TvButton } from '../components/TvButton';
import { colors, type } from '../theme';
import { DownloadJob } from '../api';

/** Full-screen playback of a resolved debrid stream. */
export function PlayerScreen({ job, onBack }: { job: DownloadJob; onBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  if (!job.streamUrl) {
    return (
      <View style={s.screen}>
        <Text style={[type.body, { color: colors.red, padding: 48 }]}>NO STREAM URL FOR THIS JOB YET</Text>
        <TvButton label="Back" autoFocus onPress={onBack} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      {error ? (
        <View style={s.overlay}>
          <Text style={[type.body, { color: colors.red, marginBottom: 16 }]}>{error.toUpperCase()}</Text>
          <TvButton label="Back" autoFocus onPress={onBack} />
        </View>
      ) : (
        <>
          <Video
            source={{ uri: job.streamUrl }}
            style={StyleSheet.absoluteFill}
            controls
            resizeMode="contain"
            onLoad={(_data: OnLoadData) => setReady(true)}
            onError={(e: OnVideoErrorData) => setError(e.error?.errorString ?? 'PLAYBACK ERROR')}
          />
          {!ready ? (
            <View style={s.overlay} pointerEvents="none">
              <Text style={type.dim}>RESOLVING STREAM...</Text>
            </View>
          ) : null}
          <View style={s.backRow}>
            <TvButton label="Back" secondary onPress={onBack} />
          </View>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  backRow: { position: 'absolute', top: 24, left: 24 },
});
