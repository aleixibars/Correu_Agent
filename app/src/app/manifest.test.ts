// The manifest and the favicon carry the same paper/ink identity as the rest
// of the dashboard, so the colors it declares are read back out of
// `globals.css` rather than restated here — a token edited in one place and
// not the other is exactly the drift this catches.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "@correu-agent/shared";
import manifest from "./manifest";

const CSS = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

const token = (name: string): string => {
  const match = CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`globals.css has no --${name} token`);
  return match[1].trim();
};

const iconFile = (src: string): string =>
  readFileSync(new URL(`.${src}`, import.meta.url), "utf8");

describe("manifest", () => {
  it("names the app the way every other surface does", () => {
    expect(manifest().name).toBe(APP_NAME);
    expect(manifest().short_name).toBe(APP_NAME);
  });

  it("paints the browser chrome in the paper and ink tokens", () => {
    expect(manifest().background_color).toBe(token("paper"));
    expect(manifest().theme_color).toBe(token("ink"));
  });

  it("opens the dashboard at the root", () => {
    expect(manifest().start_url).toBe("/");
  });

  // Installing the dashboard as a PWA is out of scope for the PoC
  // (context.md §3) — the manifest is identity only, not an install prompt.
  it("does not offer itself as an installable app", () => {
    expect(manifest().display).toBe("browser");
  });

  it("declares icons that exist and scale to any size", () => {
    const icons = manifest().icons ?? [];
    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      expect(iconFile(icon.src)).toContain("<svg");
      expect(icon.type).toBe("image/svg+xml");
      // Vectors cover every size; a fixed size list here would be a claim
      // about raster assets that do not exist.
      expect(icon.sizes).toBe("any");
    }
  });

  it("draws the icons from the dashboard palette", () => {
    // The icon restates more tokens than the manifest does — ink, paper and
    // both airmail stripe colors — so it is the likelier place for the
    // identity to drift.
    const palette = ["paper", "ink", "airmail-red", "airmail-blue"].map(token);

    for (const icon of manifest().icons ?? []) {
      const colors = iconFile(icon.src).match(/#[0-9a-f]{3,8}/gi) ?? [];
      expect(colors.length).toBeGreaterThan(0);
      for (const color of colors) {
        expect(palette).toContain(color.toLowerCase());
      }
    }
  });
});
