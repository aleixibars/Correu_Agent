// Drives the three buttons of the review screen the way a submission does: the
// server actions are called with a FormData, with the session, the sending, the
// model call and the cache invalidation stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { DASHBOARD_PATH, THREADS_PATH, threadPath } from "../../../lib/routes";
import { TEST_TENANT_ID } from "../../../lib/auth/test-fixtures";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const createDraftSender = vi.fn(async () => ({ sendReply: vi.fn() }));
const approveAndSendDraft = vi.fn(async () => ({
  draftId: DRAFT_ID,
  threadId: THREAD_ID,
  sentMessageId: "message-1",
  providerMessageId: "gmail-1",
}));
const discardDraft = vi.fn(async () => ({
  draftId: DRAFT_ID,
  threadId: THREAD_ID,
}));
const regenerateDraft = vi.fn(async () => ({
  threadId: THREAD_ID,
  draftId: "88888888-8888-8888-8888-888888888888",
  supersededDraftId: DRAFT_ID,
  language: "ca",
  model: "claude-sonnet-5",
}));
const createAnthropicClient = vi.fn(() => ({ messages: { create: vi.fn() } }));
const revalidatePath = vi.fn();

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";
const THREAD_ID = "55555555-5555-5555-5555-555555555555";
const USER_ID = "user-1";

vi.mock("../../../auth", () => ({ auth }));
vi.mock("../../../lib/db", () => ({ db: {} }));
vi.mock("../../../lib/mailbox/draft-sender", () => ({ createDraftSender }));
vi.mock("@correu-agent/shared/drafts", () => ({
  approveAndSendDraft,
  discardDraft,
  regenerateDraft,
}));
vi.mock("@correu-agent/shared/triage", () => ({ createAnthropicClient }));
vi.mock("next/cache", () => ({ revalidatePath }));
// Stubbed rather than left to Next so a test can read *where* an action sends
// the reviewer, which the real `redirect` only carries inside an error digest.
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const { approveDraft, rejectDraft, regenerateDraftWithFeedback } = await import(
  "./actions"
);

const signedIn = (): void => {
  auth.mockResolvedValue({
    user: { id: USER_ID, tenantId: TEST_TENANT_ID, email: "aleix@example.com" },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
};

const formData = (fields: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
});

describe("approveDraft", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(
      approveDraft(formData({ draftId: DRAFT_ID, body: "Text" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(approveAndSendDraft).not.toHaveBeenCalled();
  });

  it("sends the approved text through the mailbox of the draft", async () => {
    signedIn();

    await approveDraft(formData({ draftId: DRAFT_ID, body: "Text aprovat" }));

    expect(createDraftSender).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
      draftId: DRAFT_ID,
    });
    expect(approveAndSendDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        tenantId: TEST_TENANT_ID,
        draftId: DRAFT_ID,
        actorUserId: USER_ID,
        body: "Text aprovat",
      },
    );
  });

  // A submitted tenant is another tenant's mailbox waiting to be sent from: the
  // send is scoped to the session's tenant whatever the form says.
  it("ignores a tenant smuggled into the form", async () => {
    signedIn();

    await approveDraft(
      formData({
        draftId: DRAFT_ID,
        body: "Text",
        tenantId: "99999999-9999-9999-9999-999999999999",
      }),
    );

    expect(approveAndSendDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tenantId: TEST_TENANT_ID }),
    );
  });

  it("refuses a submission that names no draft", async () => {
    signedIn();

    await expect(approveDraft(formData({ body: "Text" }))).rejects.toThrow();
    expect(approveAndSendDraft).not.toHaveBeenCalled();
  });

  // Postgres refuses a malformed uuid, so a hand-crafted submission would come
  // back as a database error rather than as a refusal.
  it("refuses a submission whose draft is not an id", async () => {
    signedIn();

    await expect(
      approveDraft(formData({ draftId: "no-un-esborrany", body: "Text" })),
    ).rejects.toThrow();
    expect(createDraftSender).not.toHaveBeenCalled();
    expect(approveAndSendDraft).not.toHaveBeenCalled();
  });

  it("shows the thread as it stands once the reply has left", async () => {
    signedIn();

    await approveDraft(formData({ draftId: DRAFT_ID, body: "Text" }));

    expect(revalidatePath).toHaveBeenCalledWith(threadPath(THREAD_ID));
    expect(revalidatePath).toHaveBeenCalledWith(THREADS_PATH);
  });

  // Two open tabs: whoever clicked first sent it, and the second click answers
  // with nothing rather than sending a second copy (context.md §2).
  it("refreshes the list when the draft was already dealt with", async () => {
    signedIn();
    approveAndSendDraft.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof approveAndSendDraft>>,
    );

    await approveDraft(formData({ draftId: DRAFT_ID, body: "Text" }));

    expect(revalidatePath).toHaveBeenCalledWith(THREADS_PATH);
  });
});

describe("rejectDraft", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(rejectDraft(formData({ draftId: DRAFT_ID }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(discardDraft).not.toHaveBeenCalled();
  });

  it("discards the draft for the signed-in tenant and user", async () => {
    signedIn();

    await expect(rejectDraft(formData({ draftId: DRAFT_ID }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(discardDraft).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
      draftId: DRAFT_ID,
      userId: USER_ID,
    });
    expect(revalidatePath).toHaveBeenCalledWith(threadPath(THREAD_ID));
  });

  // Discarding ends the review: the thread it leaves behind asks nothing more,
  // so the reviewer is taken back to the screen that lists what is still open.
  it("takes the reviewer back to the dashboard once discarded", async () => {
    signedIn();

    await expect(rejectDraft(formData({ draftId: DRAFT_ID }))).rejects.toThrow(
      `NEXT_REDIRECT ${DASHBOARD_PATH}`,
    );
    expect(discardDraft).toHaveBeenCalled();
  });

  it("never sends anything when a draft is discarded", async () => {
    signedIn();

    await expect(rejectDraft(formData({ draftId: DRAFT_ID }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(approveAndSendDraft).not.toHaveBeenCalled();
    expect(createDraftSender).not.toHaveBeenCalled();
  });

  it("refuses a submission that names no draft", async () => {
    signedIn();

    await expect(rejectDraft(formData({}))).rejects.toThrow();
    await expect(
      rejectDraft(formData({ draftId: "no-un-esborrany" })),
    ).rejects.toThrow();
    expect(discardDraft).not.toHaveBeenCalled();
  });
});

describe("regenerateDraftWithFeedback", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(
      regenerateDraftWithFeedback(
        formData({ draftId: DRAFT_ID, feedback: "Més curt" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(regenerateDraft).not.toHaveBeenCalled();
  });

  it("asks the model for another draft with the instruction written", async () => {
    signedIn();

    await regenerateDraftWithFeedback(
      formData({ draftId: DRAFT_ID, feedback: "Més curt i menys formal." }),
    );

    expect(regenerateDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        tenantId: TEST_TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        feedback: "Més curt i menys formal.",
      },
    );
    expect(revalidatePath).toHaveBeenCalledWith(threadPath(THREAD_ID));
  });

  // Regenerating from nothing is the call that wrote the draft just rejected:
  // it would be paid for to produce the same mail again.
  it("refuses a rejection with no instruction", async () => {
    signedIn();

    await expect(
      regenerateDraftWithFeedback(formData({ draftId: DRAFT_ID, feedback: "  " })),
    ).rejects.toThrow();
    expect(regenerateDraft).not.toHaveBeenCalled();
  });

  it("never sends anything when a draft is regenerated", async () => {
    signedIn();

    await regenerateDraftWithFeedback(
      formData({ draftId: DRAFT_ID, feedback: "Més curt" }),
    );

    expect(approveAndSendDraft).not.toHaveBeenCalled();
  });
});
