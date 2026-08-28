// Renders the dashboard home the way a request does: the Server Component is
// awaited and turned into markup, with the session and the underlying queries
// stubbed so no database is needed. The home page now leads with the content
// a reviewer needs — actionable threads and the daily digest — instead of a
// page of links (context.md §2, §5): nobody should have to click through to
// find out what is waiting for them.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { DailyDigestContent } from "@correu-agent/shared/digest";
import { CATEGORY_LABELS } from "../lib/category-labels";
import { THREADS_PATH, threadPath } from "../lib/routes";
import { TEST_TENANT_ID } from "../lib/auth/test-fixtures";
import type { ThreadListItem } from "../lib/threads/list-threads";
import type { LatestDailyDigest } from "../lib/digest/latest-digest";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const listThreads = vi.fn<() => Promise<ThreadListItem[]>>(async () => []);
const latestDailyDigest = vi.fn<() => Promise<LatestDailyDigest | null>>(
  async () => null,
);
const collectDailyDigest = vi.fn<() => Promise<DailyDigestContent>>();

vi.mock("../auth", () => ({ auth }));
vi.mock("../lib/db", () => ({ db: {} }));
vi.mock("../lib/threads/list-threads", () => ({ listThreads }));
vi.mock("../lib/digest/latest-digest", () => ({ latestDailyDigest }));
vi.mock("@correu-agent/shared/digest", () => ({ collectDailyDigest }));
// Just the button that submits it, not what it does — that's `actions.test.ts`
// and what pulls in the mailbox/token stack the dashboard render doesn't need.
vi.mock("./fils/[id]/actions", () => ({ rejectDraft: vi.fn() }));

const { default: HomePage } = await import("./page");

const render = async (
  query: Record<string, string> = {},
): Promise<string> =>
  renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve(query) }),
  );

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

const DAY = "2026-08-19";

const thread = (overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id: "thread-1",
  subject: "Assumpte",
  category: "comercial",
  lastMessageAt: new Date("2026-08-19T08:30:00Z"),
  status: "triaged",
  draftId: null,
  ...overrides,
});

const emptyDigestContent = (): DailyDigestContent => ({
  day: DAY,
  threadCount: 0,
  sections: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  listThreads.mockResolvedValue([]);
  latestDailyDigest.mockResolvedValue(null);
  collectDailyDigest.mockResolvedValue(emptyDigestContent());
});

describe("HomePage", () => {
  it("offers to sign in when there is no session", async () => {
    const markup = await render();

    expect(markup).toContain("Inicia la sessió");
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("reads the signed-in tenant's threads and digest", async () => {
    signedIn();

    await render();

    expect(listThreads).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
    });
    expect(latestDailyDigest).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
    });
  });

  it("leaves out a thread still awaiting triage", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({ id: "t-1", subject: "Falta triatge", status: "awaiting-triage" }),
    ]);

    const markup = await render();

    expect(markup).not.toContain("Falta triatge");
  });

  it("leaves out a triaged thread that is not urgent", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({ id: "t-1", subject: "Ja triat", status: "triaged" }),
    ]);

    const markup = await render();

    expect(markup).not.toContain("Ja triat");
  });

  it("offers an explicit Respondre button for a thread with a draft pending review", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({ id: "t-1", subject: "Cal revisar", status: "draft-pending" }),
    ]);

    const markup = await render();

    expect(markup).toContain("Cal revisar");
    expect(markup).toContain(
      `<a class="btn" href="${threadPath("t-1")}">Respondre</a>`,
    );
  });

  // A draft to reject is what makes Descarta meaningful; the row's other
  // action, Respondre, always links to the thread regardless.
  it("also offers to discard the draft straight from the dashboard row", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({
        id: "t-1",
        subject: "Cal revisar",
        status: "draft-pending",
        draftId: "draft-1",
      }),
    ]);

    const markup = await render();

    expect(markup).toContain('name="draftId" value="draft-1"');
    expect(markup).toContain(">Descarta<");
  });

  // An urgent thread with no draft yet has nothing for Descarta to act on.
  it("leaves out Descarta when the thread has no live draft to discard", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({
        id: "t-1",
        subject: "Urgent sense esborrany",
        status: "triaged",
        category: "urgent",
        draftId: null,
      }),
    ]);

    const markup = await render();

    expect(markup).not.toContain(">Descarta<");
  });

  it("says so when nothing is waiting on the reviewer", async () => {
    signedIn();

    const markup = await render();

    expect(markup).toContain("Tot al dia");
  });

  it("leads to the full thread list", async () => {
    signedIn();

    const markup = await render();

    expect(markup).toContain(`href="${THREADS_PATH}"`);
  });

  it("shows the day's digest summary inline", async () => {
    signedIn();
    latestDailyDigest.mockResolvedValue({
      day: DAY,
      summary: "Dia tranquil.",
      updatedAt: new Date("2026-08-19T06:00:00Z"),
    });
    collectDailyDigest.mockResolvedValue({
      day: DAY,
      threadCount: 1,
      sections: [
        {
          category: "comercial",
          threads: [
            {
              id: "t-2",
              subject: "Pressupost",
              category: "comercial",
              lastMessageAt: null,
            },
          ],
        },
      ],
    });

    const markup = await render();

    expect(markup).toContain("<p>Dia tranquil.</p>");
    expect(markup).toContain(CATEGORY_LABELS.comercial);
    expect(markup).toContain("Pressupost");
  });

  // A digest with the threads of a busy day, all in one category.
  const digestWith = (threads: DailyDigestContent["sections"][number]["threads"]): void => {
    latestDailyDigest.mockResolvedValue({
      day: DAY,
      summary: "Dia tranquil.",
      updatedAt: new Date("2026-08-19T06:00:00Z"),
    });
    collectDailyDigest.mockResolvedValue({
      day: DAY,
      threadCount: threads.length,
      sections: [{ category: "comercial", threads }],
    });
  };

  const digestThread = (id: string, subject: string) => ({
    id,
    subject,
    category: "comercial" as const,
    lastMessageAt: new Date("2026-08-19T15:47:00Z"),
  });

  // The digest is a day's recap, not the screen where anything gets decided:
  // the hour of each thread's last message only belongs in the table above.
  it("leaves the last message's time out of a digest thread", async () => {
    signedIn();
    digestWith([digestThread("t-2", "Pressupost")]);

    const markup = await render();

    expect(markup).toContain("Pressupost");
    expect(markup).not.toContain("2026-08-19T15:47:00.000Z");
    expect(markup).not.toContain("17:47");
  });

  // A day with many threads would otherwise stretch the home page without end,
  // and a scroller a keyboard cannot focus hides the rows below the fold.
  it("wraps the digest threads in a scrollable region a keyboard can reach", async () => {
    signedIn();
    digestWith([digestThread("t-2", "Pressupost")]);

    const wrapper = /<div ([^>]*\bclass="digest-scroll")([^>]*)>/.exec(
      await render(),
    );

    expect(wrapper).not.toBeNull();
    expect(wrapper![1] + wrapper![2]).toContain('tabindex="0"');
  });

  // Reading a thread is the only thing the digest offers: the buttons that act
  // on it (Respondre, Descarta) stay in the "Pendents i urgents" table.
  it("links each digest thread to the thread itself, with no action buttons", async () => {
    signedIn();
    digestWith([digestThread("t-2", "Pressupost")]);

    const markup = await render();

    expect(markup).toContain(
      `<a href="${threadPath("t-2")}">Pressupost</a>`,
    );
    expect(markup).not.toContain(">Descarta<");
    expect(markup).not.toContain(">Respondre<");
  });

  it("says so when no digest has been written yet", async () => {
    signedIn();

    const markup = await render();

    expect(markup).toContain("Encara no hi ha cap digest");
    expect(collectDailyDigest).not.toHaveBeenCalled();
  });

  it("puts the actionable threads ahead of the digest", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({ id: "t-1", subject: "Falta triatge", status: "awaiting-triage" }),
    ]);
    latestDailyDigest.mockResolvedValue({
      day: DAY,
      summary: "Dia tranquil.",
      updatedAt: new Date("2026-08-19T06:00:00Z"),
    });

    const markup = await render();

    expect(markup.indexOf("Falta triatge")).toBeLessThan(
      markup.indexOf("Dia tranquil."),
    );
  });

  // Connecting a mailbox is production-only setup, not something the
  // dashboard should keep offering once a tenant is up and running.
  it("does not clutter the dashboard with mailbox connect buttons", async () => {
    signedIn();

    const markup = await render();

    expect(markup).not.toContain("Bústies connectades");
    expect(markup).not.toContain("Connecta una bústia de Gmail");
  });

  // Notification settings are configuration, not something to review daily —
  // they moved to /auto-resposta alongside the rest of the tenant's settings.
  it("does not clutter the dashboard with the notification toggle", async () => {
    signedIn();

    const markup = await render();

    expect(markup).not.toContain("Notificacions de correu urgent");
  });
});
