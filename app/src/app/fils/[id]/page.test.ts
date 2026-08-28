// Renders the review screen of one thread the way a request does: the Server
// Component is awaited and turned into markup, with the session and the query
// stubbed so no database is needed. What each button then does is covered by
// `actions.test.ts`.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import {
  THREADS_PATH,
  attachmentDownloadPath,
  attachmentPath,
} from "../../../lib/routes";
import { CATEGORY_LABELS } from "../../../lib/category-labels";
import { TEST_TENANT_ID } from "../../../lib/auth/test-fixtures";
import type { ThreadDetail } from "../../../lib/threads/thread-detail";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const loadThreadDetail = vi.fn<() => Promise<ThreadDetail | null>>();

vi.mock("../../../auth", () => ({ auth }));
vi.mock("../../../lib/db", () => ({ db: {} }));
vi.mock("../../../lib/threads/thread-detail", () => ({ loadThreadDetail }));
vi.mock("./actions", () => ({
  approveDraft: vi.fn(),
  rejectDraft: vi.fn(),
  regenerateDraftWithFeedback: vi.fn(),
}));

const { default: ThreadPage } = await import("./page");

const THREAD_ID = "55555555-5555-5555-5555-555555555555";
const DRAFT_ID = "77777777-7777-7777-7777-777777777777";

const render = async (threadId = THREAD_ID): Promise<string> =>
  renderToStaticMarkup(await ThreadPage({ params: Promise.resolve({ id: threadId }) }));

const signedIn = (): void => {
  auth.mockResolvedValue({
    user: { id: "user-1", tenantId: TEST_TENANT_ID, email: "aleix@example.com" },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
};

const detail = (overrides: Partial<ThreadDetail> = {}): ThreadDetail => ({
  id: THREAD_ID,
  subject: "Pressupost de febrer",
  category: "comercial",
  lastMessageAt: new Date("2026-08-18T08:30:00Z"),
  status: "draft-pending",
  messages: [
    {
      id: "message-1",
      direction: "inbound",
      fromAddress: "client@example.com",
      toAddresses: ["bustia@example.com"],
      subject: "Pressupost de febrer",
      bodyText: "Ens podeu passar el pressupost?",
      snippet: "Ens podeu passar",
      sentAt: new Date("2026-08-18T08:30:00Z"),
      attachments: [],
    },
  ],
  draft: {
    id: DRAFT_ID,
    body: "Bon dia, us el passem avui mateix.",
    status: "pending",
    model: "claude-sonnet-5",
    createdAt: new Date("2026-08-18T09:05:00Z"),
    options: [{ label: "Resposta", body: "Bon dia, us el passem avui mateix." }],
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  loadThreadDetail.mockResolvedValue(detail());
});

describe("ThreadPage", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(loadThreadDetail).not.toHaveBeenCalled();
  });

  it("reads the thread of the signed-in tenant alone", async () => {
    signedIn();

    await render();

    expect(loadThreadDetail).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
      threadId: THREAD_ID,
    });
  });

  // Another tenant's thread reads as missing (`loadThreadDetail` answers null),
  // and the page must not tell a visitor that the id exists somewhere.
  it("answers with a 404 for a thread the tenant does not have", async () => {
    signedIn();
    loadThreadDetail.mockResolvedValue(null);

    await expect(render()).rejects.toThrow(/NEXT_(NOT_FOUND|HTTP_ERROR_FALLBACK)/);
  });

  it("shows the thread with its subject, category and mail", async () => {
    signedIn();

    const markup = await render();

    expect(markup).toContain("Pressupost de febrer");
    expect(markup).toContain(CATEGORY_LABELS.comercial);
    expect(markup).toContain("client@example.com");
    expect(markup).toContain("Ens podeu passar el pressupost?");
    expect(markup).toContain("18/8/26 10:30");
  });

  // The body is nulled after the 90-day retention window (context.md §7); the
  // snippet is what survives it, and an empty article would read as broken.
  it("falls back to the snippet of a mail whose body was purged", async () => {
    signedIn();
    const base = detail();
    loadThreadDetail.mockResolvedValue({
      ...base,
      messages: [{ ...base.messages[0]!, bodyText: null }],
    });

    expect(await render()).toContain("Ens podeu passar");
  });

  describe("with attachments", () => {
    const ATTACHMENT_ID = "99999999-9999-9999-9999-999999999999";

    const withAttachments = (
      attachments: ThreadDetail["messages"][number]["attachments"],
    ): void => {
      const base = detail();
      loadThreadDetail.mockResolvedValue({
        ...base,
        messages: [{ ...base.messages[0]!, attachments }],
      });
    };

    it("lists each attachment with its name, its size and a download", async () => {
      signedIn();
      withAttachments([
        {
          id: ATTACHMENT_ID,
          filename: "pressupost.pdf",
          mimeType: "application/pdf",
          sizeBytes: 20480,
        },
      ]);

      const markup = await render();

      expect(markup).toContain("pressupost.pdf");
      expect(markup).toContain("20 kB");
      expect(markup).toContain(`href="${attachmentDownloadPath(ATTACHMENT_ID)}"`);
      // A PDF opens inside the dashboard, without leaving the thread behind.
      expect(markup).toContain(`href="${attachmentPath(ATTACHMENT_ID)}"`);
    });

    it("offers no preview of a type the browser would run", async () => {
      signedIn();
      withAttachments([
        {
          id: ATTACHMENT_ID,
          filename: "factura.html",
          mimeType: "text/html",
          sizeBytes: null,
        },
      ]);

      const markup = await render();

      expect(markup).toContain("factura.html");
      expect(markup).toContain(`href="${attachmentDownloadPath(ATTACHMENT_ID)}"`);
      expect(markup).not.toContain(`href="${attachmentPath(ATTACHMENT_ID)}"`);
    });

    it("says nothing about attachments on a message without any", async () => {
      signedIn();

      expect(await render()).not.toContain("Adjunts");
    });
  });

  // The thread opens in stages (issue #82): the mail and the choice between
  // answering and discarding first, with the editable reply and the refining
  // box revealed only once the reviewer has chosen — which happens in the
  // browser, so the markup a request produces is always the first stage.
  describe("with a draft waiting for review", () => {
    it("offers answering or discarding when the thread opens", async () => {
      signedIn();

      const markup = await render();

      expect(markup).toContain("Respondre");
      expect(markup).toContain("Descartar");
      expect(markup).toContain(`value="${DRAFT_ID}"`);
    });

    it("keeps the reply and the refining box out of the first stage", async () => {
      signedIn();

      const markup = await render();

      expect(markup).not.toContain('name="body"');
      expect(markup).not.toContain('name="feedback"');
      expect(markup).not.toContain("Bon dia, us el passem avui mateix.");
    });

    // Answering really sends the mail (context.md §2), which is not something
    // the reviewer should discover afterwards.
    it("says that answering ends in a mail being sent", async () => {
      signedIn();

      const markup = await render();

      expect(markup).toContain("enviï");
      expect(markup).toContain("remitent");
    });
  });

  it("shows a sent reply without offering to send it again", async () => {
    signedIn();
    const base = detail();
    loadThreadDetail.mockResolvedValue({
      ...base,
      status: "replied",
      draft: { ...base.draft!, status: "sent" },
    });

    const markup = await render();

    expect(markup).toContain("Resposta enviada");
    expect(markup).toContain("Bon dia, us el passem avui mateix.");
    expect(markup).not.toContain("Respondre");
    expect(markup).not.toContain('name="feedback"');
  });

  it("shows a discarded draft without offering to send it", async () => {
    signedIn();
    const base = detail();
    loadThreadDetail.mockResolvedValue({
      ...base,
      status: "draft-discarded",
      draft: { ...base.draft!, status: "discarded" },
    });

    const markup = await render();

    expect(markup).toContain("Esborrany descartat");
    expect(markup).not.toContain("Descartar");
  });

  it("says so when the thread has no draft to review", async () => {
    signedIn();
    loadThreadDetail.mockResolvedValue({
      ...detail(),
      status: "triaged",
      draft: null,
    });

    const markup = await render();

    expect(markup).toContain("Cap esborrany");
    expect(markup).not.toContain("Descartar");
  });

  it("leads back to the thread list", async () => {
    signedIn();

    expect(await render()).toContain(`href="${THREADS_PATH}"`);
  });
});
