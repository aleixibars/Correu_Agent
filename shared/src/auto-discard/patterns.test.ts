import { describe, expect, it } from "vitest";
import { parsePatternList } from "./patterns";

describe("parsePatternList", () => {
  it("splits one pattern per line", () => {
    expect(parsePatternList("acme.com\nexample.org")).toEqual([
      "acme.com",
      "example.org",
    ]);
  });

  it("splits patterns separated by commas", () => {
    expect(parsePatternList("acme.com, example.org")).toEqual([
      "acme.com",
      "example.org",
    ]);
  });

  it("trims whitespace around each pattern", () => {
    expect(parsePatternList("  acme.com  \n  example.org  ")).toEqual([
      "acme.com",
      "example.org",
    ]);
  });

  it("drops blank entries left by trailing separators or empty lines", () => {
    expect(parsePatternList("acme.com,,\n\n example.org \n")).toEqual([
      "acme.com",
      "example.org",
    ]);
  });

  it("answers an empty list for blank or missing input", () => {
    expect(parsePatternList("")).toEqual([]);
    expect(parsePatternList("   \n  ")).toEqual([]);
    expect(parsePatternList(null)).toEqual([]);
  });
});
