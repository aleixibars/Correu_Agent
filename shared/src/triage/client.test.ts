import { describe, expect, it } from "vitest";
import { createAnthropicClient, loadAnthropicApiKey } from "./client";

describe("loadAnthropicApiKey", () => {
  it("reads the key from the environment", () => {
    expect(loadAnthropicApiKey({ ANTHROPIC_API_KEY: "sk-test" })).toBe("sk-test");
  });

  it("refuses to build a client without a key", () => {
    // Failing at boot beats failing one thread at a time every 2 minutes.
    expect(() => createAnthropicClient({})).toThrow("ANTHROPIC_API_KEY");
  });
});
