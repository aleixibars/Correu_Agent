import { describe, expect, it } from "vitest";
import { applicationServerKey } from "./application-server-key";

// The same throwaway key the shared Web Push tests use.
const PUBLIC_KEY =
  "BA_rL-8vsyX92TBCCZtsf_fN7N4EH0qwHsuyYj83i5E1g4RYBeKBYDEwUPPiabWgnwvIt46du0fbLM0BI_w9lMA";

describe("applicationServerKey", () => {
  it("decodes a VAPID key into an uncompressed P-256 point", () => {
    const key = applicationServerKey(PUBLIC_KEY);

    expect(key).toHaveLength(65);
    // 0x04 is what marks the point as uncompressed; a wrong alphabet or missing
    // padding shifts every byte and the browser rejects the subscription.
    expect(key[0]).toBe(0x04);
  });

  it("decodes the base64url alphabet, not plain base64", () => {
    expect(applicationServerKey(PUBLIC_KEY)).toEqual(
      Uint8Array.from(
        atob(PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/") + "="),
        (character) => character.charCodeAt(0),
      ),
    );
  });

  it("ignores surrounding whitespace, as a copied environment value carries", () => {
    expect(applicationServerKey(` ${PUBLIC_KEY}\n`)).toEqual(
      applicationServerKey(PUBLIC_KEY),
    );
  });
});
