// The paths live in a module of their own so a Client Component can ask for
// one without the Auth.js providers travelling to the browser with it:
// `lib/auth/config` value-imports them, and `app/error.tsx` sits in the router
// tree of every route. Nothing in the module graph enforces the split and the
// regression is silent — it only shows up as a 20 kB chunk in `next build` —
// so the sources are checked here.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../", import.meta.url);

const read = (name: string): string =>
  readFileSync(new URL(name, SRC), "utf8");

const CLIENT_COMPONENTS = readdirSync(SRC, {
  recursive: true,
  encoding: "utf8",
})
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .filter((name) => read(name).startsWith('"use client"'));

describe("route constants", () => {
  it("are declared without importing anything", () => {
    expect(read("lib/routes.ts")).not.toMatch(/^import /m);
  });

  it("are the only paths a client component reads", () => {
    // Guards against the test passing because nothing was scanned.
    expect(CLIENT_COMPONENTS).toContain("app/error.tsx");

    const withAuthConfig = CLIENT_COMPONENTS.filter((name) =>
      /from "[^"]*auth\/config"/.test(read(name)),
    );

    expect(withAuthConfig).toEqual([]);
  });
});
