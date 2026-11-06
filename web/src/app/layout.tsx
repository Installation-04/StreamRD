import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "StreamRD",
  description: "Self-hosted multiservice debrid streaming",
};

// Runs before paint so a "system" preference (or a saved light/dark choice)
// applies immediately — otherwise the page flashes the hardcoded default
// theme for a frame before React hydrates.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var pref = localStorage.getItem("sr_theme") || "dark";
    if (["dark", "light", "system"].indexOf(pref) === -1) pref = "dark";
    var resolved = pref === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : pref;
    document.documentElement.dataset.theme = resolved;
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AuthProvider>
          <Nav />
          <div id="main-content" tabIndex={-1}>{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
