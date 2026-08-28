import { describe, expect, it } from "vitest";
import { parseAddressList, parseRecipientField } from "./addresses";

describe("parseAddressList", () => {
  it("keeps a comma inside a quoted display name out of the split", () => {
    expect(
      parseAddressList('"Ibars, Aleix" <a@example.com>, b@example.com'),
    ).toEqual(["a@example.com", "b@example.com"]);
  });

  it("reads nothing out of a header that is not there", () => {
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe("parseRecipientField", () => {
  it("reads the addresses a reviewer separated with commas", () => {
    expect(parseRecipientField("a@example.com, Bea <b@example.com>", "Cc")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("reads an empty field as nobody", () => {
    expect(parseRecipientField("   ", "Cco")).toEqual([]);
  });

  // The same address twice is one recipient, not two copies of the mail.
  it("drops a duplicate however it was written", () => {
    expect(
      parseRecipientField("a@example.com, Aleix <A@Example.com>", "Per a"),
    ).toEqual(["a@example.com"]);
  });

  it("refuses text that is not an address, naming it", () => {
    expect(() => parseRecipientField("a@example.com, qui sigui", "Cc")).toThrow(
      /"qui sigui" is not an email address \(Cc\)/,
    );
  });
});
