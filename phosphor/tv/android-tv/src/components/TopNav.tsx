import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TvButton } from './TvButton';
import { BlinkingCursor } from './Cursor';
import { colors, type } from '../theme';

export function TopNav({
  active,
  onNavigate,
  onSignOut,
}: {
  active: 'search' | 'downloads';
  onNavigate: (screen: 'search' | 'downloads') => void;
  onSignOut: () => void;
}) {
  return (
    <View style={s.wrap}>
      <View style={s.brandRow}>
        <Text style={type.h1}>PHOSPHOR</Text>
        <BlinkingCursor style={{ marginLeft: 4, fontSize: 14 }} />
      </View>
      <View style={s.navRow}>
        <TvButton label="Search" secondary={active !== 'search'} onPress={() => onNavigate('search')} />
        <TvButton label="Queue" secondary={active !== 'downloads'} onPress={() => onNavigate('downloads')} />
        <TvButton label="Sign out" danger onPress={onSignOut} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.phosphorFaint,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  navRow: { flexDirection: 'row', gap: 10 },
});
