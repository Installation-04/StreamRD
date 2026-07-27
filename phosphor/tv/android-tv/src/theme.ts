import { Platform } from 'react-native';

/**
 * Phosphor's visual identity: a green-on-black CRT terminal. System
 * monospace only — no bundled/fetched fonts, nothing that needs network
 * access to render.
 */
export const mono = Platform.select({ android: 'monospace', ios: 'Courier', default: 'monospace' });

export const colors = {
  bg: '#020402',
  panel: '#04140a',
  phosphor: '#33ff66',
  phosphorDim: '#1c8f3f',
  phosphorFaint: '#0f5c28',
  phosphorBright: '#aaffc2',
  amberWarn: '#ffb000',
  red: '#ff4d4d',
  focusBg: 'rgba(51, 255, 102, 0.16)',
  scanline: 'rgba(0, 0, 0, 0.28)',
};

export const type = {
  title: { fontFamily: mono, color: colors.phosphor, fontSize: 34, fontWeight: '700' as const, letterSpacing: 4 },
  h1: { fontFamily: mono, color: colors.phosphor, fontSize: 22, fontWeight: '700' as const, letterSpacing: 2 },
  h2: { fontFamily: mono, color: colors.phosphor, fontSize: 16, fontWeight: '700' as const, letterSpacing: 1.5 },
  body: { fontFamily: mono, color: colors.phosphorBright, fontSize: 16 },
  dim: { fontFamily: mono, color: colors.phosphorDim, fontSize: 14 },
  mono: { fontFamily: mono },
};

/** Repeats a box-drawing rule to a fixed character width, e.g. "── SEARCH ──────". */
export function ruleLine(label: string, width = 40): string {
  const tag = label ? ` ${label.toUpperCase()} ` : '';
  const fill = Math.max(width - tag.length - 2, 4);
  const left = Math.floor(fill / 2);
  const right = fill - left;
  return `┌${'─'.repeat(left)}${tag}${'─'.repeat(right)}┐`;
}

export function baseLine(width = 40): string {
  return `└${'─'.repeat(Math.max(width - 2, 4))}┘`;
}
