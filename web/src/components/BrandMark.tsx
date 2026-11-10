/** The StreamRD mark: a play triangle sending out a stream, in black and orange. Same drawing as docs/assets/logo.svg. */
export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false">
    <rect width="64" height="64" rx="16" fill="#0a0a0a" />
    <rect x="1.5" y="1.5" width="61" height="61" rx="14.5" fill="none" stroke="#ff8a1f" strokeOpacity=".35" strokeWidth="3" />
    <path d="M16 18.5c0-2 2.2-3.2 3.9-2.1l19.6 13.5c1.5 1 1.5 3.2 0 4.2L19.9 47.6c-1.7 1.1-3.9-.1-3.9-2.1v-27Z" fill="#ff8a1f" />
    <g fill="none" stroke="#ff8a1f" strokeWidth="4.2" strokeLinecap="round"><path d="M45 25.5a9.5 9.5 0 0 1 0 13" /><path d="M51.5 19a18.5 18.5 0 0 1 0 26" strokeOpacity=".6" /></g>
  </svg></span>;
}
