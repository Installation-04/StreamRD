import type { MetadataRoute } from "next";

// Lets Chrome/Edge (Windows, Android) and Safari install StreamRD as its own
// window. It is the same site, so it always matches the server it talks to.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "StreamRD",
    short_name: "StreamRD",
    description: "Stream and control your StreamRD server",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
