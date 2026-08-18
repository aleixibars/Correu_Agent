import { describe, expect, it } from "vitest";
import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("accepts an id in the shape the columns store", () => {
    expect(isUuid("55555555-5555-5555-5555-555555555555")).toBe(true);
    expect(isUuid("A1B2C3D4-1111-4222-8333-abcdefabcdef")).toBe(true);
  });

  // Everything here would reach Postgres as an invalid uuid literal, which is
  // an error rather than the empty result the caller reads as "not found".
  it("refuses anything Postgres would not read as one", () => {
    for (const value of [
      "",
      "  ",
      "thread-0",
      "55555555-5555-5555-5555-55555555555",
      "55555555555555555555555555555555",
      " 55555555-5555-5555-5555-555555555555 ",
      "55555555-5555-5555-5555-55555555555g",
    ]) {
      expect(isUuid(value), value).toBe(false);
    }
  });
});
