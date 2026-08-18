// The RFC 5322 message Gmail is handed when a draft is approved (context.md
// §2). Graph builds its own MIME from a JSON message, so this is only the Gmail
// side — but the encoding rules are the mail format's, not Google's.

import type { OutgoingReply } from "./types";

/** Anything outside printable US-ASCII has to be encoded before it can be a header. */
const NON_ASCII = /[^\x20-\x7e]/;

/**
 * A header value can never carry a line break: a subject arriving from a
 * provider with a `\r\n` in it would otherwise end the header block and let the
 * rest be read as headers of its own.
 */
const singleLine = (value: string): string => value.replace(/[\r\n]+/g, " ");

/** RFC 2047 encoded word, so accents in a Catalan subject survive the header. */
const encodeHeaderValue = (value: string): string => {
  const line = singleLine(value);
  return NON_ASCII.test(line)
    ? `=?UTF-8?B?${Buffer.from(line, "utf8").toString("base64")}?=`
    : line;
};

/** RFC 2045 §6.8: a base64 body is written in lines of at most 76 characters. */
const foldBase64 = (value: string): string =>
  (value.match(/.{1,76}/g) ?? []).join("\r\n");

/**
 * The reply as a MIME message. The body goes out base64-encoded rather than as
 * plain 8-bit text: it is the model's prose, so it holds accents and can hold
 * lines longer than the 998 characters RFC 5322 allows.
 */
export const buildReplyMime = (reply: OutgoingReply): string => {
  const headers: [string, string][] = [
    ["From", singleLine(reply.fromAddress)],
    ["To", reply.toAddresses.map(singleLine).join(", ")],
    ...(reply.ccAddresses.length > 0
      ? ([["Cc", reply.ccAddresses.map(singleLine).join(", ")]] as [string, string][])
      : []),
    ["Subject", encodeHeaderValue(reply.subject)],
    // Absent when the mail being answered arrived without a `Message-ID`:
    // pointing at a fabricated id would break threading in every client.
    ...(reply.inReplyTo
      ? ([["In-Reply-To", singleLine(reply.inReplyTo)]] as [string, string][])
      : []),
    ...(reply.references
      ? ([["References", singleLine(reply.references)]] as [string, string][])
      : []),
    ["MIME-Version", "1.0"],
    ['Content-Type', 'text/plain; charset="UTF-8"'],
    ["Content-Transfer-Encoding", "base64"],
  ];

  const body = foldBase64(Buffer.from(reply.bodyText, "utf8").toString("base64"));

  return `${headers
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n")}\r\n\r\n${body}\r\n`;
};
