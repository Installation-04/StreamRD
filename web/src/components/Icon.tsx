import type { CSSProperties } from "react";

export type IconName = "play" | "search" | "home" | "heart" | "grid" | "arrow" | "clock" | "user" | "settings" | "sun" | "moon" | "screen" | "logout" | "film" | "plus" | "chevron";
const paths: Record<IconName, string> = {
  play: "m9 5 11 7-11 7V5Z",
  search: "m21 21-4.35-4.35M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z",
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z",
  heart: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  user: "M20 21v-2a7 7 0 0 0-14 0v2m10-14a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5m-3 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z",
  screen: "M3 3h18v14H3zM8 21h8m-4-4v4",
  logout: "M9 4H4v16h5m5-13 5 5-5 5m-5-5h10",
  film: "M3 3h18v18H3zM7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4",
  plus: "M12 5v14M5 12h14",
  chevron: "m9 5 7 7-7 7",
};
export function Icon({ name, size = 20, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}><path d={paths[name]} /></svg>;
}
