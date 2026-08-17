// Application-layer encryption for OAuth tokens (context.md §7). Only the
// tokens are encrypted here — the mail body is covered by Neon's disk
// encryption. A raw access/refresh token must never reach the database.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Env var holding the base64-encoded 32-byte key (see `.env.example`). */
export const TOKEN_ENCRYPTION_KEY_ENV = "TOKEN_ENCRYPTION_KEY";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const assertKey = (key: Buffer): void => {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Token encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }
};

/**
 * Reads and validates the encryption key from the environment. Throws at call
 * time rather than at import time so a missing key surfaces in the code path
 * that actually persists tokens.
 */
export const loadTokenEncryptionKey = (
  env: Record<string, string | undefined> = process.env,
): Buffer => {
  const raw = env[TOKEN_ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${TOKEN_ENCRYPTION_KEY_ENV} is not set — cannot encrypt OAuth tokens.`,
    );
  }

  // Buffer's base64 decoder silently drops invalid characters, so a garbled
  // paste can still yield 32 bytes — i.e. a silently wrong key. Reject it.
  if (!BASE64.test(raw)) {
    throw new Error(`${TOKEN_ENCRYPTION_KEY_ENV} is not valid base64.`);
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${TOKEN_ENCRYPTION_KEY_ENV} must be ${KEY_BYTES} bytes base64-encoded, got ${key.length}.`,
    );
  }
  return key;
};

/**
 * Encrypts a token into the persisted envelope `v1:<iv>:<authTag>:<ciphertext>`,
 * all parts base64. A fresh random IV per call keeps identical tokens from
 * producing identical ciphertext.
 */
export const encryptToken = (token: string, key: Buffer): string => {
  assertKey(key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  // Bind the version into the auth tag so a future v2 envelope can never be
  // replayed as v1 (and vice versa) by rewriting the prefix.
  cipher.setAAD(Buffer.from(ENVELOPE_VERSION, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
};

/**
 * Decrypts an envelope produced by `encryptToken`. Throws if the version is
 * unknown, the envelope is malformed, or the GCM auth tag doesn't verify
 * (wrong key or tampered ciphertext).
 */
export const decryptToken = (envelope: string, key: Buffer): string => {
  assertKey(key);

  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted token envelope.");
  }

  const [
    version = "",
    ivBase64 = "",
    authTagBase64 = "",
    ciphertextBase64 = "",
  ] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted token version: ${version}.`);
  }

  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Malformed encrypted token envelope.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(version, "utf8"));
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
};
