import { describe, expect, it } from "vitest";
import {
  MAILBOX_CONNECTED_STATUS,
  MAILBOX_FAILED_STATUS,
  MAILBOX_REASON_PARAM,
  MAILBOX_STATUS_PARAM,
  mailboxConnectionNotice,
  mailboxOutcomeQuery,
} from "./connect-messages";

describe("mailboxConnectionNotice", () => {
  it("confirms a connected mailbox", () => {
    expect(mailboxConnectionNotice(MAILBOX_CONNECTED_STATUS, undefined)).toEqual({
      ok: true,
      text: "Bústia connectada.",
    });
  });

  it("explains a refused grant, which retrying the same way never fixes", () => {
    const notice = mailboxConnectionNotice(
      MAILBOX_FAILED_STATUS,
      "scopes_refused",
    );

    expect(notice?.ok).toBe(false);
    expect(notice?.text).toContain("enviament");
  });

  it("falls back to the generic failure for an unknown reason", () => {
    expect(mailboxConnectionNotice(MAILBOX_FAILED_STATUS, "vés-a-saber")).toEqual(
      mailboxConnectionNotice(MAILBOX_FAILED_STATUS, "oauth_failed"),
    );
  });

  it("shows nothing when the visitor simply opened the dashboard", () => {
    expect(mailboxConnectionNotice(undefined, undefined)).toBeNull();
  });
});

describe("mailboxOutcomeQuery", () => {
  const noticeFor = (query: string) => {
    const params = new URLSearchParams(query);
    return mailboxConnectionNotice(
      params.get(MAILBOX_STATUS_PARAM) ?? undefined,
      params.get(MAILBOX_REASON_PARAM) ?? undefined,
    );
  };

  // The routes write the query and the dashboard reads it, so the two halves
  // are only ever right together.
  it("round-trips a success through the notice the dashboard renders", () => {
    expect(noticeFor(mailboxOutcomeQuery())).toEqual({
      ok: true,
      text: "Bústia connectada.",
    });
  });

  it("round-trips every failure reason", () => {
    for (const reason of [
      "access_denied",
      "state_mismatch",
      "scopes_refused",
      "oauth_failed",
    ] as const) {
      expect(noticeFor(mailboxOutcomeQuery(reason))).toEqual(
        mailboxConnectionNotice(MAILBOX_FAILED_STATUS, reason),
      );
      expect(noticeFor(mailboxOutcomeQuery(reason))?.ok).toBe(false);
    }
  });
});
