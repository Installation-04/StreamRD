import React from 'react';
import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import { colors, mono } from '../theme';

/** Focusable button with a glowing phosphor focus ring — the sole navigation primitive on every screen. */
export function TvButton({
  label,
  onPress,
  autoFocus,
  secondary,
  danger,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  autoFocus?: boolean;
  secondary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hasTVPreferredFocus={autoFocus}
      focusable={!disabled}
      style={({ focused }) => [
        s.button,
        secondary && s.secondary,
        danger && s.danger,
        disabled && s.disabled,
        focused && !disabled && s.focused,
        style,
      ]}
    >
      <Text
        style={[
          s.text,
          secondary && s.textSecondary,
          danger && s.textDanger,
          disabled && s.textDisabled,
        ]}
      >
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderColor: colors.phosphorDim,
    backgroundColor: 'transparent',
    paddingVertical: 10,
    paddingHorizontal: 22,
    marginVertical: 4,
  },
  secondary: { borderColor: colors.phosphorFaint },
  danger: { borderColor: colors.red },
  disabled: { borderColor: '#204028', opacity: 0.5 },
  focused: {
    borderColor: colors.phosphor,
    backgroundColor: colors.focusBg,
  },
  text: { fontFamily: mono, color: colors.phosphor, fontSize: 15, fontWeight: '700', letterSpacing: 1.5 },
  textSecondary: { color: colors.phosphorDim },
  textDanger: { color: colors.red },
  textDisabled: { color: colors.phosphorDim },
});
