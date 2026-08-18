import { describe, expect, it } from "vitest";
import {
  MAILBOX_CONNECTED_STATUS,
  MAILBOX_FAILED_STATUS,
  mailboxConnectionNotice,
} from "./connect-messages";

describe("mailboxConnectionNotice", () => {
  it("confirms a connected mailbox", () => {
    expect(mailboxConnectionNotice(MAILBOX_CONNECTED_STATUS, undefined)).toEqual({
      ok: true,
      text: "Bústia de Gmail connectada.",
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
