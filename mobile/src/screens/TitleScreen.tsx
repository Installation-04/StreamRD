import { useEffect, useState } from "react";
import { Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { get } from "../api";
import { styles } from "../theme";
import { Title } from "../types";

export function TitleScreen({
  id,
  onPlay,
  onBack,
}: {
  id: string;
  onPlay: () => void;
  onBack: () => void;
}) {
  const [title, setTitle] = useState<Title | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ title: Title }>(`/api/catalog/title/${id}`)
      .then((res) => setTitle(res.title))
      .catch((err: Error) => setError(err.message));
  }, [id]);

  if (error) return <Text style={[styles.error, styles.container]}>{error}</Text>;
  if (!title) return <Text style={[styles.dim, styles.container]}>Loading…</Text>;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.dim}>← Back</Text>
      </TouchableOpacity>
      {title.backdropUrl && (
        <Image
          source={{ uri: title.backdropUrl }}
          style={{ width: "100%", height: 180, borderRadius: 8, marginTop: 12 }}
        />
      )}
      <Text style={[styles.h1, { marginTop: 14 }]}>{title.name}</Text>
      <Text style={styles.dim}>
        {[title.year, title.type, ...title.genres].filter(Boolean).join(" · ")} ·{" "}
        {title.sourceCount} sources
      </Text>
      <Text style={[styles.text, { marginVertical: 14, lineHeight: 22 }]}>{title.description}</Text>
      <TouchableOpacity style={styles.button} onPress={onPlay}>
        <Text style={styles.buttonText}>▶ Play</Text>
      </TouchableOpacity>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}
