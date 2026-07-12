import { StyleSheet } from "react-native";

export const colors = {
  bg: "#0b0b0f",
  raised: "#16161d",
  border: "#2a2a36",
  text: "#f2f2f5",
  dim: "#9a9aa8",
  accent: "#e50914",
  ok: "#2ecc71",
  err: "#e74c3c",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 16 },
  h1: { color: colors.text, fontSize: 24, fontWeight: "800", marginBottom: 12 },
  h2: { color: colors.text, fontSize: 17, fontWeight: "700", marginVertical: 10 },
  text: { color: colors.text, fontSize: 15 },
  dim: { color: colors.dim, fontSize: 13 },
  error: { color: colors.err, fontSize: 14, marginVertical: 6 },
  ok: { color: colors.ok, fontSize: 14, marginVertical: 6 },
  input: {
    backgroundColor: colors.raised,
    color: colors.text,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 6,
    padding: 14,
    alignItems: "center",
    marginVertical: 6,
  },
  buttonSecondary: {
    backgroundColor: colors.raised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  buttonText: { color: "#fff", fontWeight: "700" },
  card: {
    backgroundColor: colors.raised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  poster: { width: 120, height: 180, borderRadius: 6, backgroundColor: colors.raised },
});
