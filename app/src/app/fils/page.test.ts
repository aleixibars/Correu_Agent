// Renders the thread list the way a request does: the Server Component is
// awaited and turned into markup, with the session and the query stubbed so no
// database is needed.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { TRIAGE_CATEGORIES } from "@correu-agent/shared";
import { CATEGORY_LABELS } from "../../lib/category-labels";
import { DASHBOARD_PATH, threadPath } from "../../lib/auth/config";
import { TEST_TENANT_ID } from "../../lib/auth/test-fixtures";
import type { ThreadListItem } from "../../lib/threads/list-threads";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const listThreads = vi.fn<() => Promise<ThreadListItem[]>>(async () => []);

vi.mock("../../auth", () => ({ auth }));
vi.mock("../../lib/db", () => ({ db: {} }));
vi.mock("../../lib/threads/list-threads", () => ({ listThreads }));

const { default: ThreadsPage } = await import("./page");

const render = async (): Promise<string> =>
  renderToStaticMarkup(await ThreadsPage());

const signedIn = (): void => {
  auth.mockResolvedValue({
    user: {
      id: "user-1",
      tenantId: TEST_TENANT_ID,
      email: "aleix@example.com",
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
};

/** One thread per category, so every label the taxonomy has is exercised. */
const threadPerCategory = (): ThreadListItem[] =>
  TRIAGE_CATEGORIES.map((category, index) => ({
    id: `thread-${index}`,
    subject: `Assumpte ${category}`,
    category,
    lastMessageAt: new Date("2026-08-18T08:30:00Z"),
    status: "triaged" as const,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  listThreads.mockResolvedValue([]);
});

describe("ThreadsPage", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("reads only the threads of the signed-in tenant", async () => {
    signedIn();

    await render();

    expect(listThreads).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
    });
  });

  it("shows every category with its Catalan label", async () => {
    signedIn();
    listThreads.mockResolvedValue(threadPerCategory());

    const markup = await render();

    for (const category of TRIAGE_CATEGORIES) {
      expect(markup).toContain(`Assumpte ${category}`);
      expect(markup).toContain(CATEGORY_LABELS[category]);
    }
  });

  it("shows the status of each thread in Catalan", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      { ...threadPerCategory()[0]!, status: "draft-pending" },
      { ...threadPerCategory()[1]!, status: "replied" },
    ]);

    const markup = await render();

    expect(markup).toContain("Esborrany pendent de revisió");
    expect(markup).toContain("Resposta enviada");
  });

  it("marks an untriaged thread instead of leaving the category blank", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      {
        id: "thread-untriaged",
        subject: "Sense classificar encara",
        category: null,
        lastMessageAt: null,
        status: "awaiting-triage",
      },
    ]);

    const markup = await render();

    expect(markup).toContain("Pendent de triatge");
    expect(markup).toContain("Sense classificar encara");
  });

  it("dates each thread in Catalan and machine-readably", async () => {
    signedIn();
    listThreads.mockResolvedValue([threadPerCategory()[0]!]);

    const markup = await render();

    expect(markup).toContain("2026-08-18T08:30:00.000Z");
    expect(markup).toContain("18/8/26 10:30");
  });

  it("says so when no mail has been processed yet", async () => {
    signedIn();

    expect(await render()).toContain("Encara no hi ha cap fil processat");
  });

  it("names a thread that arrived without a subject", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      { ...threadPerCategory()[0]!, subject: null },
    ]);

    expect(await render()).toContain("(Sense assumpte)");
  });

  // Both providers report a missing subject as an empty header, not as a null.
  it("names a thread whose subject is blank", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      { ...threadPerCategory()[0]!, subject: "   " },
    ]);

    expect(await render()).toContain("(Sense assumpte)");
  });

  // The list is where the reviewer picks the thread to work on, and the review
  // screen is the only place a draft can be approved (context.md §2).
  it("leads to the review screen of each thread", async () => {
    signedIn();
    listThreads.mockResolvedValue(threadPerCategory());

    const markup = await render();

    expect(markup).toContain(`href="${threadPath("thread-0")}"`);
  });

  it("leads back to the dashboard", async () => {
    signedIn();

    expect(await render()).toContain(`href="${DASHBOARD_PATH}"`);
  });
});
