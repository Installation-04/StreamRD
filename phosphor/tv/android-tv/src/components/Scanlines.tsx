import React, { useMemo } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import { colors } from '../theme';

const LINE_HEIGHT = 3;

/**
 * A subtle CRT scanline overlay: alternating faint horizontal bands drawn
 * once and left static (no per-frame cost). Purely decorative — pointer
 * events pass through so it never steals focus from the D-pad.
 */
export function Scanlines() {
  const { height } = Dimensions.get('window');
  const lineCount = useMemo(() => Math.ceil(height / LINE_HEIGHT), [height]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: lineCount }).map((_, i) => (
        <View
          key={i}
          style={{
            height: LINE_HEIGHT,
            backgroundColor: i % 2 === 0 ? colors.scanline : 'transparent',
          }}
        />
      ))}
    </View>
  );
}
