import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, mono } from '../theme';
import { JobStatus } from '../api';

const STATUS_COLOR: Record<JobStatus, string> = {
  queued: colors.amberWarn,
  downloading: colors.phosphor,
  finished: colors.phosphorBright,
  error: colors.red,
};

/** `[ STATUS ]` pill, color-coded per job status. */
export function StatusPill({ status }: { status: JobStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <View style={[s.pill, { borderColor: c }]}>
      <Text style={[s.text, { color: c }]}>[ {status.toUpperCase()} ]</Text>
    </View>
  );
}

/** ASCII-flavored progress bar: a bordered track filled with block glyphs. */
export function ProgressBar({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const totalCols = 24;
  const filledCols = Math.round((pct / 100) * totalCols);
  const bar = '█'.repeat(filledCols) + '░'.repeat(totalCols - filledCols);
  return (
    <View style={s.barRow}>
      <Text style={s.barText}>
        [{bar}] {pct}%
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
  text: { fontFamily: mono, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  barRow: { marginTop: 4 },
  barText: { fontFamily: mono, color: colors.phosphorDim, fontSize: 13, letterSpacing: 0 },
});
