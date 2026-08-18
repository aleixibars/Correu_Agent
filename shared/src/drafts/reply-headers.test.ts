import { describe, expect, it } from "vitest";
import { buildReplyHeaders } from "./reply-headers";

const MESSAGE_ID = "<abc@mail.example.com>";

describe("buildReplyHeaders", () => {
  it("replies to the message it answers", () => {
    expect(
      buildReplyHeaders({
        messageIdHeader: MESSAGE_ID,
        inReplyTo: null,
        references: null,
      }),
    ).toEqual({ inReplyTo: MESSAGE_ID, references: MESSAGE_ID });
  });

  it("keeps the thread's chain and appends the message it answers", () => {
    // RFC 5322 §3.6.4: References of a reply is the parent's References plus
    // the parent's Message-ID.
    expect(
      buildReplyHeaders({
        messageIdHeader: MESSAGE_ID,
        inReplyTo: "<first@mail.example.com>",
        references: "<first@mail.example.com> <second@mail.example.com>",
      }),
    ).toEqual({
      inReplyTo: MESSAGE_ID,
      references: `<first@mail.example.com> <second@mail.example.com> ${MESSAGE_ID}`,
    });
  });

  it("falls back to the parent's In-Reply-To when it carries no References", () => {
    expect(
      buildReplyHeaders({
        messageIdHeader: MESSAGE_ID,
        inReplyTo: "<first@mail.example.com>",
        references: null,
      }),
    ).toEqual({
      inReplyTo: MESSAGE_ID,
      references: `<first@mail.example.com> ${MESSAGE_ID}`,
    });
  });

  it("never repeats an id the chain already holds", () => {
    expect(
      buildReplyHeaders({
        messageIdHeader: MESSAGE_ID,
        inReplyTo: null,
        references: `<first@mail.example.com> ${MESSAGE_ID}`,
      }),
    ).toEqual({
      inReplyTo: MESSAGE_ID,
      references: `<first@mail.example.com> ${MESSAGE_ID}`,
    });
  });

  it("answers with no headers when the parent has no Message-ID to point at", () => {
    // A reply that names no parent is a new mail, not a broken one: sending
    // `In-Reply-To: null` would be worse than sending nothing.
    expect(
      buildReplyHeaders({
        messageIdHeader: null,
        inReplyTo: null,
        references: "<first@mail.example.com>",
      }),
    ).toEqual({ inReplyTo: null, references: "<first@mail.example.com>" });
  });
});
