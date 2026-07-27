import React, { PropsWithChildren } from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { colors, mono } from '../theme';

/**
 * A terminal "window": a real bordered box (for reliable layout) with a
 * decorative box-drawing title rule stitched into the top edge, e.g.
 * ┌── SEARCH ──────────────────────────┐
 */
export function Panel({
  title,
  style,
  children,
}: PropsWithChildren<{ title?: string; style?: ViewStyle }>) {
  return (
    <View style={[styles.wrap, style]}>
      {title ? (
        <View style={styles.titleRow}>
          <Text style={styles.corner}>┌─</Text>
          <Text style={styles.titleText}> {title.toUpperCase()} </Text>
          <View style={styles.ruleFill} />
          <Text style={styles.corner}>┐</Text>
        </View>
      ) : null}
      <View style={styles.body}>{children}</View>
      <View style={styles.footerRow}>
        <Text style={styles.corner}>└{'─'.repeat(3)}</Text>
        <View style={styles.ruleFill} />
        <Text style={styles.corner}>┘</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderColor: colors.phosphorFaint,
    backgroundColor: colors.panel,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingTop: 4 },
  footerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4 },
  corner: { fontFamily: mono, color: colors.phosphorFaint, fontSize: 14 },
  titleText: { fontFamily: mono, color: colors.phosphor, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  ruleFill: { flex: 1, height: 1, backgroundColor: colors.phosphorFaint, marginTop: 8 },
  body: { padding: 20 },
});
