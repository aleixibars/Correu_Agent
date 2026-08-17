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

const assertKey = (key: Buffer): Buffer => {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Token encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }
  return key;
};

/**
 * Reads and validates the encryption key from the environment. Throws at call
 * time rather than at import time so a missing key surfaces in the code path
 * that actually persists tokens.
 */
export const loadTokenEncryptionKey = (
  env: Record<string, string | undefined> = process.env,
): Buffer => {
  const raw = env[TOKEN_ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new Error(
      `${TOKEN_ENCRYPTION_KEY_ENV} is not set — cannot encrypt OAuth tokens.`,
    );
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

  const [version, ivBase64, authTagBase64, ciphertextBase64] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted token version: ${version}.`);
  }

  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Malformed encrypted token envelope.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
};
