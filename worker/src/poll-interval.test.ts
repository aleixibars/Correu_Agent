import { describe, expect, it } from "vitest";
import { POLL_INTERVAL_MS } from "./poll-interval";

describe("poll interval", () => {
  it("is 2 minutes in milliseconds", () => {
    expect(POLL_INTERVAL_MS).toBe(120_000);
  });
});
