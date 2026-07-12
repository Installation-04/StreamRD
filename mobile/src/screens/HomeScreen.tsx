import { useEffect, useState } from "react";
import { FlatList, Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { get } from "../api";
import { colors, styles } from "../theme";
import { CatalogRow, Title } from "../types";

function Poster({ title, onPress }: { title: Title; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={{ marginRight: 10, width: 120 }}>
      {title.posterUrl ? (
        <Image source={{ uri: title.posterUrl }} style={styles.poster} />
      ) : (
        <View style={[styles.poster, { justifyContent: "center", padding: 8 }]}>
          <Text style={[styles.dim, { textAlign: "center" }]}>{title.name}</Text>
        </View>
      )}
      <Text numberOfLines={1} style={[styles.text, { fontSize: 12, marginTop: 4 }]}>
        {title.name}
      </Text>
    </TouchableOpacity>
  );
}

export function HomeScreen({ onOpenTitle }: { onOpenTitle: (id: string) => void }) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ rows: CatalogRow[] }>("/api/catalog/rows")
      .then((res) => setRows(res.rows))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={[styles.h1, { color: colors.accent }]}>STREAMRD</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {rows.length === 0 && !error && <Text style={styles.dim}>No titles yet.</Text>}
      {rows.map((row) => (
        <View key={row.id} style={{ marginBottom: 18 }}>
          <Text style={styles.h2}>{row.label}</Text>
          <FlatList
            horizontal
            data={row.titles}
            keyExtractor={(t) => t.id}
            renderItem={({ item }) => <Poster title={item} onPress={() => onOpenTitle(item.id)} />}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      ))}
    </ScrollView>
  );
}
