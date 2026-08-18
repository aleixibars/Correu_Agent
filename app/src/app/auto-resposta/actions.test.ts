// Drives the auto-reply settings form the way a submission does: the server
// action is called with a FormData, with the session, the database write and
// the cache invalidation stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { AUTO_REPLY_PATH } from "../../lib/auth/config";
import { TEST_TENANT_ID } from "../../lib/auth/test-fixtures";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const setAutoReplyRule = vi.fn(async () => ({
  category: "comercial" as const,
  enabled: true,
  instructions: null,
}));
const revalidatePath = vi.fn();

vi.mock("../../auth", () => ({ auth }));
vi.mock("../../lib/db", () => ({ db: {} }));
vi.mock("@correu-agent/shared/auto-reply", () => ({ setAutoReplyRule }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { saveAutoReplyRule } = await import("./actions");

const USER_ID = "user-1";

const signedIn = (): void => {
  auth.mockResolvedValue({
    user: { id: USER_ID, tenantId: TEST_TENANT_ID, email: "aleix@example.com" },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
};

const submit = (fields: Record<string, string>): Promise<void> => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return saveAutoReplyRule(form);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
});

describe("saveAutoReplyRule", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(submit({ category: "comercial", enabled: "on" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(setAutoReplyRule).not.toHaveBeenCalled();
  });

  it("stores the switch against the signed-in tenant and user", async () => {
    signedIn();

    await submit({
      category: "suport",
      enabled: "on",
      instructions: "Respon en to proper.",
    });

    expect(setAutoReplyRule).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
      category: "suport",
      enabled: true,
      instructions: "Respon en to proper.",
      actor: { type: "user", userId: USER_ID },
    });
  });

  // An unchecked checkbox is not submitted at all, so the absent field is what
  // "off" looks like — reading it as "unchanged" would make the switch one-way.
  it("turns the switch off when the checkbox is not submitted", async () => {
    signedIn();

    await submit({ category: "facturacio" });

    expect(setAutoReplyRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false, instructions: null }),
    );
  });

  // The form only ever offers the three eligible categories, so a category the
  // taxonomy refuses can only come from a hand-crafted POST (context.md §4).
  it.each(["urgent", "personal", "newsletter"])(
    "refuses to write a rule for %s",
    async (category) => {
      signedIn();

      await expect(submit({ category, enabled: "on" })).rejects.toThrow(category);
      expect(setAutoReplyRule).not.toHaveBeenCalled();
    },
  );

  it("refuses a category that is not in the taxonomy at all", async () => {
    signedIn();

    await expect(submit({ category: "inventada", enabled: "on" })).rejects.toThrow();
    expect(setAutoReplyRule).not.toHaveBeenCalled();
  });

  it("refuses a submission that names no category", async () => {
    signedIn();

    await expect(submit({ enabled: "on" })).rejects.toThrow();
    expect(setAutoReplyRule).not.toHaveBeenCalled();
  });

  // A submitted tenant is another tenant's mailbox waiting to be switched on:
  // the rule is written against the session's tenant whatever the form says.
  it("ignores a tenant smuggled into the form", async () => {
    signedIn();

    await submit({
      category: "comercial",
      enabled: "on",
      tenantId: "99999999-9999-9999-9999-999999999999",
    });

    expect(setAutoReplyRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TEST_TENANT_ID }),
    );
  });

  it("refreshes the settings page so the stored state is what is shown", async () => {
    signedIn();

    await submit({ category: "comercial", enabled: "on" });

    expect(revalidatePath).toHaveBeenCalledWith(AUTO_REPLY_PATH);
  });
});
