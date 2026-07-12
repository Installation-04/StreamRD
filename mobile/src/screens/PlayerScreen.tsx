import { ResizeMode, Video } from "expo-av";
import { useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { post } from "../api";
import { styles } from "../theme";
import { StreamInfo } from "../types";

export function PlayerScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    post<{ stream: StreamInfo }>("/api/play", { titleId: id })
      .then((res) => setStream(res.stream))
      .catch((err: Error) => setError(err.message));
  }, [id]);

  return (
    <View style={[styles.screen, { backgroundColor: "#000" }]}>
      <TouchableOpacity onPress={onBack} style={{ padding: 14 }}>
        <Text style={styles.dim}>← Back</Text>
      </TouchableOpacity>
      {error ? (
        <View style={styles.container}>
          <Text style={styles.error}>{error}</Text>
          <Text style={styles.dim}>
            Check your debrid settings, or retry shortly if a torrent is still caching.
          </Text>
        </View>
      ) : stream ? (
        <>
          <Video
            source={{ uri: stream.url }}
            style={{ flex: 1 }}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
          />
          <Text style={[styles.dim, { textAlign: "center", padding: 8 }]}>
            via {stream.provider}
            {stream.quality ? ` · ${stream.quality}` : ""}
          </Text>
        </>
      ) : (
        <Text style={[styles.dim, styles.container]}>Resolving stream…</Text>
      )}
    </View>
  );
}
