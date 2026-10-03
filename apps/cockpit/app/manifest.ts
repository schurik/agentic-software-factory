import type { MetadataRoute } from "next";

// The icons are drawn by scripts/icons.py; the colours are globals.css's.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cockpit",
    short_name: "Cockpit",
    description: "Observe and steer the factories your stations report.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbfbfa",
    theme_color: "#2f5bd3",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
