// Renders the daily digest the way a request does: the Server Component is
// awaited and turned into markup, with the session and both queries stubbed so
// no database is needed.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { TRIAGE_CATEGORIES } from "@correu-agent/shared";
import type { DailyDigestContent } from "@correu-agent/shared/digest";
import { CATEGORY_LABELS } from "../../lib/category-labels";
import { DASHBOARD_PATH } from "../../lib/routes";
import { TEST_TENANT_ID } from "../../lib/auth/test-fixtures";
import type { LatestDailyDigest } from "../../lib/digest/latest-digest";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const latestDailyDigest = vi.fn<() => Promise<LatestDailyDigest | null>>(
  async () => null,
);
const collectDailyDigest = vi.fn<() => Promise<DailyDigestContent>>();

vi.mock("../../auth", () => ({ auth }));
vi.mock("../../lib/db", () => ({ db: {} }));
vi.mock("../../lib/digest/latest-digest", () => ({ latestDailyDigest }));
vi.mock("@correu-agent/shared/digest", () => ({ collectDailyDigest }));

const { default: DigestPage } = await import("./page");

const render = async (): Promise<string> =>
  renderToStaticMarkup(await DigestPage());

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

const DAY = "2026-08-17";

const digest = (
  overrides: Partial<LatestDailyDigest> = {},
): LatestDailyDigest => ({
  day: DAY,
  summary: "Dia tranquil.\n\nRes urgent avui.",
  updatedAt: new Date("2026-08-18T06:00:00Z"),
  ...overrides,
});

/** One thread per category, so every label the taxonomy has is exercised. */
const contentPerCategory = (): DailyDigestContent => ({
  day: DAY,
  threadCount: TRIAGE_CATEGORIES.length,
  sections: TRIAGE_CATEGORIES.map((category, index) => ({
    category,
    threads: [
      {
        id: `thread-${index}`,
        subject: `Assumpte ${category}`,
        category,
        lastMessageAt: new Date("2026-08-17T08:30:00Z"),
      },
    ],
  })),
});

const withDigest = (content = contentPerCategory()): void => {
  signedIn();
  latestDailyDigest.mockResolvedValue(digest());
  collectDailyDigest.mockResolvedValue(content);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  latestDailyDigest.mockResolvedValue(null);
  collectDailyDigest.mockResolvedValue({
    day: DAY,
    threadCount: 0,
    sections: [],
  });
});

describe("DigestPage", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(latestDailyDigest).not.toHaveBeenCalled();
    expect(collectDailyDigest).not.toHaveBeenCalled();
  });

  it("reads only the digest of the signed-in tenant", async () => {
    withDigest();

    await render();

    expect(latestDailyDigest).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
    });
    expect(collectDailyDigest).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TEST_TENANT_ID,
      day: DAY,
    });
  });

  it("shows the summary the model wrote, paragraph by paragraph", async () => {
    withDigest();

    const markup = await render();

    expect(markup).toContain("<p>Dia tranquil.</p>");
    expect(markup).toContain("<p>Res urgent avui.</p>");
  });

  // The model is asked for a short section per category and often answers with
  // one line each; joined into a single paragraph they would read as a run-on.
  it("keeps a summary line per category on its own line", async () => {
    signedIn();
    latestDailyDigest.mockResolvedValue(
      digest({ summary: "- Urgent: cap.\n- Comercial: dos pressupostos." }),
    );

    const markup = await render();

    expect(markup).toContain("<p>- Urgent: cap.</p>");
    expect(markup).toContain("<p>- Comercial: dos pressupostos.</p>");
  });

  it("groups the day's threads under their Catalan category", async () => {
    withDigest();

    const markup = await render();

    for (const category of TRIAGE_CATEGORIES) {
      expect(markup).toContain(CATEGORY_LABELS[category]);
      expect(markup).toContain(`Assumpte ${category}`);
    }
  });

  // Taxonomy order (context.md §4): what needs a person today reads first.
  it("leads with the urgent category", async () => {
    withDigest();

    const markup = await render();

    expect(markup.indexOf(CATEGORY_LABELS.urgent)).toBeLessThan(
      markup.indexOf(CATEGORY_LABELS.personal),
    );
  });

  it("counts the threads of each category and of the whole day", async () => {
    signedIn();
    latestDailyDigest.mockResolvedValue(digest());
    collectDailyDigest.mockResolvedValue({
      day: DAY,
      threadCount: 3,
      sections: [
        {
          category: "comercial",
          threads: [1, 2, 3].map((n) => ({
            id: `thread-${n}`,
            subject: `Pressupost ${n}`,
            category: "comercial" as const,
            lastMessageAt: null,
          })),
        },
      ],
    });

    const markup = await render();

    expect(markup).toContain("3 fils");
    expect(markup).toContain(`${CATEGORY_LABELS.comercial} (3)`);
  });

  it("counts a single thread without pluralising it", async () => {
    signedIn();
    latestDailyDigest.mockResolvedValue(digest());
    collectDailyDigest.mockResolvedValue({
      day: DAY,
      threadCount: 1,
      sections: [
        {
          category: "urgent",
          threads: [
            {
              id: "thread-1",
              subject: "Servidor caigut",
              category: "urgent" as const,
              lastMessageAt: null,
            },
          ],
        },
      ],
    });

    const markup = await render();

    expect(markup).toContain("1 fil processat");
    expect(markup).not.toContain("1 fils");
  });

  it("dates the day in Catalan and machine-readably", async () => {
    withDigest();

    const markup = await render();

    // Case-insensitively: this renderer echoes the JSX prop name, while Next
    // emits the HTML attribute.
    expect(markup.toLowerCase()).toContain(`datetime="${DAY}"`);
    expect(markup).toContain("17/8/2026");
  });

  it("says when the digest was written, in office time", async () => {
    withDigest();

    const markup = await render();

    expect(markup).toContain("2026-08-18T06:00:00.000Z");
    expect(markup).toContain("18/8/26 8:00");
  });

  const withOnlySubject = (subject: string | null): void => {
    const content = contentPerCategory();
    withDigest({
      ...content,
      sections: [
        {
          ...content.sections[0]!,
          threads: [{ ...content.sections[0]!.threads[0]!, subject }],
        },
      ],
    });
  };

  it("names a thread that arrived without a subject", async () => {
    withOnlySubject(null);

    expect(await render()).toContain("(Sense assumpte)");
  });

  // Both providers report a missing subject as an empty header, not as a null.
  it("names a thread whose subject is blank", async () => {
    withOnlySubject("   ");

    expect(await render()).toContain("(Sense assumpte)");
  });

  it("says so when no digest has been written yet", async () => {
    signedIn();

    const markup = await render();

    expect(markup).toContain("Encara no hi ha cap digest");
    expect(collectDailyDigest).not.toHaveBeenCalled();
  });

  it("leads back to the dashboard", async () => {
    withDigest();

    expect(await render()).toContain(`href="${DASHBOARD_PATH}"`);
  });
});
