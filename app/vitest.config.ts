import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    server: {
      // `next-auth` imports `next/server`, which Next ships without an exports
      // map or file extension — Node's ESM resolver cannot find it, so the
      // package has to go through Vite's resolver instead of being externalised.
      deps: { inline: ["next-auth"] },
    },
  },
});
