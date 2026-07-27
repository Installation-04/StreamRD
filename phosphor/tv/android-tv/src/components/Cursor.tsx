import React, { useEffect, useState } from 'react';
import { Text, TextStyle } from 'react-native';
import { colors, mono } from '../theme';

/** A blinking block cursor, terminal-style. */
export function BlinkingCursor({ style }: { style?: TextStyle }) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 530);
    return () => clearInterval(id);
  }, []);

  return (
    <Text style={[{ fontFamily: mono, color: colors.phosphor, fontSize: 20 }, style, { opacity: on ? 1 : 0 }]}>
      █
    </Text>
  );
}
