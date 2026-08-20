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

  it("lists a thread awaiting triage among the actionable threads", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({ id: "t-1", subject: "Falta triatge", status: "awaiting-triage" }),
    ]);

    const markup = await render();

    expect(markup).toContain("Falta triatge");
    expect(markup).toContain(`href="${threadPath("t-1")}"`);
  });

  it("leaves out a triaged thread that is not urgent", async () => {
    signedIn();
    listThreads.mockResolvedValue([
      thread({ id: "t-1", subject: "Ja triat", status: "triaged" }),
    ]);

    const markup = await render();

    expect(markup).not.toContain("Ja triat");
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

  it("still offers to connect a mailbox", async () => {
    signedIn();

    const markup = await render();

    expect(markup).toContain("Connecta una bústia de Gmail");
  });
});
