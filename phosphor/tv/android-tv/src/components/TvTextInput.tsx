import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { colors, mono } from '../theme';

/**
 * Terminal-style text field: a ">" prompt glyph, monospace input, and a
 * focus ring that lights up the whole row. TVs route D-pad "select" into
 * the on-screen keyboard for TextInput automatically.
 */
export function TvTextInput({
  label,
  ...props
}: TextInputProps & { label?: string }) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={s.wrap}>
      {label ? <Text style={s.label}>{label.toUpperCase()}</Text> : null}
      <View style={[s.row, focused && s.rowFocused]}>
        <Text style={s.prompt}>{'>'}</Text>
        <TextInput
          {...props}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
          style={[s.input, props.style]}
          placeholderTextColor={colors.phosphorFaint}
          selectionColor={colors.phosphor}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: 14 },
  label: { fontFamily: mono, color: colors.phosphorDim, fontSize: 12, letterSpacing: 1.5, marginBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.phosphorFaint,
    backgroundColor: '#010a04',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  rowFocused: { borderColor: colors.phosphor, backgroundColor: colors.focusBg },
  prompt: { fontFamily: mono, color: colors.phosphor, fontSize: 16, marginRight: 8 },
  input: { flex: 1, fontFamily: mono, color: colors.phosphorBright, fontSize: 16, padding: 0 },
});
