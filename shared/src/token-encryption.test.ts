import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptToken,
  encryptToken,
  loadTokenEncryptionKey,
} from "./token-encryption";

const testKey = () => randomBytes(32);
const testKeyBase64 = () => randomBytes(32).toString("base64");

describe("token encryption", () => {
  it("round-trips a token back to the original value", () => {
    const key = testKey();
    const token = "ya29.a0AfB_refresh-token-value";

    expect(decryptToken(encryptToken(token, key), key)).toBe(token);
  });

  it("round-trips non-ASCII and empty values", () => {
    const key = testKey();

    expect(decryptToken(encryptToken("", key), key)).toBe("");
    expect(decryptToken(encryptToken("clau-àèíöü-🔐", key), key)).toBe(
      "clau-àèíöü-🔐",
    );
  });

  it("never leaks the plaintext into the encrypted value", () => {
    const key = testKey();
    const token = "ya29.a0AfB_refresh-token-value";

    const encrypted = encryptToken(token, key);

    expect(encrypted).not.toContain(token);
    expect(Buffer.from(encrypted).includes(token)).toBe(false);
  });

  it("produces a different ciphertext each time for the same plaintext", () => {
    const key = testKey();

    expect(encryptToken("same-token", key)).not.toBe(
      encryptToken("same-token", key),
    );
  });

  it("tags the envelope with a version prefix", () => {
    expect(encryptToken("token", testKey()).startsWith("v1:")).toBe(true);
  });

  it("rejects decryption with the wrong key", () => {
    const encrypted = encryptToken("token", testKey());

    expect(() => decryptToken(encrypted, testKey())).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const key = testKey();
    const [version, iv, tag, ciphertext] = encryptToken(
      "token-value",
      key,
    ).split(":");
    const tampered = Buffer.from(ciphertext!, "base64");
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() =>
      decryptToken(
        [version, iv, tag, tampered.toString("base64")].join(":"),
        key,
      ),
    ).toThrow();
  });

  it("rejects an envelope with an unknown version", () => {
    const key = testKey();
    const encrypted = encryptToken("token", key);

    expect(() => decryptToken(`v2${encrypted.slice(2)}`, key)).toThrow(
      /version/i,
    );
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptToken("not-an-envelope", testKey())).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptToken("token", randomBytes(16))).toThrow(/32/);
  });

  it("loads a 32-byte base64 key from TOKEN_ENCRYPTION_KEY", () => {
    const base64 = testKeyBase64();

    const key = loadTokenEncryptionKey({ TOKEN_ENCRYPTION_KEY: base64 });

    expect(key.toString("base64")).toBe(base64);
  });

  it("rejects a missing TOKEN_ENCRYPTION_KEY", () => {
    expect(() => loadTokenEncryptionKey({})).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects a TOKEN_ENCRYPTION_KEY that does not decode to 32 bytes", () => {
    expect(() =>
      loadTokenEncryptionKey({
        TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64"),
      }),
    ).toThrow(/32/);
  });
});
