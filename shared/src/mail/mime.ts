// The RFC 5322 message Gmail is handed when a draft is approved (context.md
// §2). Graph builds its own MIME from a JSON message, so this is only the Gmail
// side — but the encoding rules are the mail format's, not Google's.

import type { OutgoingReply } from "./types";

/** Anything outside printable US-ASCII has to be encoded before it can be a header. */
const NON_ASCII = /[^\x20-\x7e]/;

/** RFC 5322 §2.1.1: 998 characters is the hard limit for a line, 78 the advised one. */
const MAX_LINE_LENGTH = 78;

/**
 * RFC 2047 §2: an encoded word is at most 75 characters, `=?UTF-8?B?` and `?=`
 * included. 45 source bytes base64-encode to 60, which leaves the 12 characters
 * of wrapping inside the limit.
 */
const MAX_ENCODED_BYTES = 45;

/**
 * A header value can never carry a line break: a subject arriving from a
 * provider with a `\r\n` in it would otherwise end the header block and let the
 * rest be read as headers of its own.
 */
const singleLine = (value: string): string => value.replace(/[\r\n]+/g, " ");

const encodedWord = (value: string): string =>
  `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/**
 * RFC 2047 encoded words, so accents in a Catalan subject survive a US-ASCII
 * header. Split at the length limit rather than emitted as one long word — a
 * decoder joins adjacent encoded words back together, dropping the whitespace
 * between them, so the subject arrives whole. Cut on character boundaries: a
 * multi-byte character halved across two words decodes to nothing.
 */
const encodeHeaderValue = (value: string): string => {
  const line = singleLine(value);
  if (!NON_ASCII.test(line)) return line;

  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > MAX_ENCODED_BYTES) {
      words.push(encodedWord(chunk));
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk !== "") words.push(encodedWord(chunk));
  return words.join(" ");
};

/**
 * RFC 5322 §2.2.3 folding. `References` grows by one message id per mail in the
 * thread, so a long conversation runs past the line limit on its own; folding is
 * what keeps that a valid header instead of an over-long line an MTA may refuse.
 *
 * Folded only at spaces the value already has, and the space is kept at the
 * start of the continuation — unfolding gives back exactly what went in.
 */
const foldHeader = (name: string, value: string): string => {
  const lines: string[] = [];
  let line = `${name}:`;

  for (const word of value.split(" ")) {
    if (line !== `${name}:` && `${line} ${word}`.length > MAX_LINE_LENGTH) {
      lines.push(line);
      line = "";
    }
    line = `${line} ${word}`;
  }

  lines.push(line);
  return lines.join("\r\n");
};

/** RFC 2045 §6.8: a base64 body is written in lines of at most 76 characters. */
const foldBase64 = (value: string): string =>
  (value.match(/.{1,76}/g) ?? []).join("\r\n");

/** RFC 2045 §6.8 again: the canonical form of a text body ends its lines with CRLF. */
const canonicalBody = (text: string): string => text.replace(/\r\n|\r|\n/g, "\r\n");

const addressList = (addresses: string[]): string =>
  addresses.map(singleLine).join(", ");

/**
 * The reply as a MIME message. The body goes out base64-encoded rather than as
 * plain 8-bit text: it is the model's prose, so it holds accents and can hold
 * lines longer than the 998 characters RFC 5322 allows.
 */
export const buildReplyMime = (reply: OutgoingReply): string => {
  const headers: [string, string][] = [
    ["From", singleLine(reply.fromAddress)],
    ["To", addressList(reply.toAddresses)],
  ];

  if (reply.ccAddresses.length > 0) {
    headers.push(["Cc", addressList(reply.ccAddresses)]);
  }
  headers.push(["Subject", encodeHeaderValue(reply.subject)]);
  // Absent when the mail being answered arrived without a `Message-ID`:
  // pointing at a fabricated id would break threading in every client.
  if (reply.inReplyTo) headers.push(["In-Reply-To", singleLine(reply.inReplyTo)]);
  if (reply.references) headers.push(["References", singleLine(reply.references)]);
  headers.push(
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="UTF-8"'],
    ["Content-Transfer-Encoding", "base64"],
  );

  const body = foldBase64(
    Buffer.from(canonicalBody(reply.bodyText), "utf8").toString("base64"),
  );

  return `${headers
    .map(([name, value]) => foldHeader(name, value))
    .join("\r\n")}\r\n\r\n${body}\r\n`;
};
