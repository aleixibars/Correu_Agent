// The VAPID public key as `PushManager.subscribe` wants it: raw bytes, not the
// base64url string the server holds (context.md §5).

/**
 * Decodes a base64url VAPID public key into the 65-byte uncompressed P-256
 * point the browser signs the subscription against.
 */
export const applicationServerKey = (
  publicKey: string,
): Uint8Array<ArrayBuffer> => {
  const trimmed = publicKey.trim();
  const base64 = trimmed
    // base64url is unpadded; `atob` needs the padding back.
    .padEnd(Math.ceil(trimmed.length / 4) * 4, "=")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const binary = atob(base64);
  // Built over its own ArrayBuffer rather than with `Uint8Array.from`, which is
  // typed over a possibly shared buffer and is not a `BufferSource`.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
