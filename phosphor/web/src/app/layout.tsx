import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phosphor",
  description: "Self-hosted retro terminal debrid search-and-stream cockpit",
};

// Runs before paint so a saved phosphor color applies immediately instead
// of flashing green for a frame before React hydrates.
const COLOR_INIT_SCRIPT = `
(function () {
  try {
    var saved = localStorage.getItem("ph_color");
    if (["green", "amber", "white"].indexOf(saved) !== -1 && saved !== "green") document.documentElement.dataset.phosphor = saved;
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: COLOR_INIT_SCRIPT }} />
      </head>
      <body>
        <AuthProvider>
          <Nav />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
