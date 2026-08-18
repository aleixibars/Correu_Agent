import type { MetadataRoute } from "next";
import { APP_DESCRIPTION, APP_NAME } from "@correu-agent/shared";

// The manifest is plain JSON at build time and cannot read a CSS custom
// property, so the paper/ink tokens of `globals.css` are restated here; the
// test reads both and fails if they drift apart.
const PAPER = "#f7f4ee";
const INK = "#1f2a2e";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    lang: "ca",
    start_url: "/",
    // Installing the dashboard as a PWA is out of scope for the PoC
    // (context.md §3): this manifest gives the tab an identity, it does not
    // ask to be installed.
    display: "browser",
    background_color: PAPER,
    theme_color: INK,
    icons: [
      {
        src: "/icon.svg",
        type: "image/svg+xml",
        sizes: "48x48 72x72 96x96 128x128 192x192 256x256 512x512 any",
      },
    ],
  };
}
