// Renders the auto-reply and auto-discard settings screen the way a request
// does: the Server Component is awaited and turned into markup, with the
// session and the rule queries stubbed so no database is needed.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import {
  AUTO_DISCARD_ELIGIBLE_CATEGORIES,
  AUTO_REPLY_ELIGIBLE_CATEGORIES,
  TRIAGE_CATEGORIES,
} from "@correu-agent/shared";
import type { AutoReplyRuleState } from "@correu-agent/shared/auto-reply";
import type { AutoDiscardRuleState } from "@correu-agent/shared/auto-discard";
import { DASHBOARD_PATH } from "../../lib/routes";
import { CATEGORY_LABELS } from "../../lib/category-labels";
import { TEST_TENANT_ID } from "../../lib/auth/test-fixtures";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const listAutoReplyRules = vi.fn<() => Promise<AutoReplyRuleState[]>>();
const listAutoDiscardRules = vi.fn<() => Promise<AutoDiscardRuleState[]>>();

vi.mock("../../auth", () => ({ auth }));
vi.mock("../../lib/db", () => ({ db: {} }));
vi.mock("@correu-agent/shared/auto-reply", () => ({ listAutoReplyRules }));
vi.mock("@correu-agent/shared/auto-discard", () => ({ listAutoDiscardRules }));
vi.mock("./actions", () => ({
  saveAutoReplyRule: vi.fn(),
  saveAutoDiscardRule: vi.fn(),
}));

const { default: AutoReplyPage } = await import("./page");

const render = async (): Promise<string> =>
  renderToStaticMarkup(await AutoReplyPage());

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

const allOff = (): AutoReplyRuleState[] =>
  AUTO_REPLY_ELIGIBLE_CATEGORIES.map((category) => ({
    category,
    enabled: false,
    instructions: null,
  }));

/** newsletter defaults on, exactly like `listAutoDiscardRules` reports it with no row stored. */
const discardDefaults = (): AutoDiscardRuleState[] =>
  AUTO_DISCARD_ELIGIBLE_CATEGORIES.map((category) => ({
    category,
    enabled: category === "newsletter",
  }));

const withRules = (rules: AutoReplyRuleState[] = allOff()): void => {
  signedIn();
  listAutoReplyRules.mockResolvedValue(rules);
};

const withDiscardRules = (
  rules: AutoDiscardRuleState[] = discardDefaults(),
): void => {
  signedIn();
  listAutoDiscardRules.mockResolvedValue(rules);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  listAutoReplyRules.mockResolvedValue(allOff());
  listAutoDiscardRules.mockResolvedValue(discardDefaults());
});

const INELIGIBLE = TRIAGE_CATEGORIES.filter(
  (category) => !AUTO_REPLY_ELIGIBLE_CATEGORIES.includes(category),
);

const DISCARD_INELIGIBLE = TRIAGE_CATEGORIES.filter(
  (category) => !AUTO_DISCARD_ELIGIBLE_CATEGORIES.includes(category),
);

describe("AutoReplyPage", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(listAutoReplyRules).not.toHaveBeenCalled();
    expect(listAutoDiscardRules).not.toHaveBeenCalled();
  });

  it("reads only the rules of the signed-in tenant", async () => {
    withRules();

    await render();

    expect(listAutoReplyRules).toHaveBeenCalledWith(
      expect.anything(),
      TEST_TENANT_ID,
    );
  });

  it("offers a switch for every category auto-reply is eligible for", async () => {
    withRules();

    const markup = await render();

    for (const category of AUTO_REPLY_ELIGIBLE_CATEGORIES) {
      expect(markup).toContain(CATEGORY_LABELS[category]);
      expect(markup).toContain(`id="enabled-${category}"`);
    }
  });

  // The acceptance criterion of the issue: Urgent and Personal/Altres are too
  // risky to ever answer unattended (context.md §2), so the screen must not
  // carry a control that could switch them on — naming them is not enough.
  // Scoped to the auto-reply control's own ids: `value="<category>"` alone is
  // no longer proof of nothing, now that the auto-discard section legitimately
  // renders that same value for categories auto-reply refuses (newsletter,
  // personal).
  it.each(INELIGIBLE)("offers no way to switch %s on for auto-reply", async (category) => {
    withRules();

    const markup = await render();

    expect(markup).not.toContain(`id="enabled-${category}"`);
    expect(markup).not.toContain(`id="instructions-${category}"`);
  });

  it("says why the ineligible categories are not on offer", async () => {
    withRules();

    const markup = await render();

    for (const category of INELIGIBLE) {
      expect(markup).toContain(CATEGORY_LABELS[category]);
    }
    expect(markup).toContain("mai");
  });

  it("shows a switched-on rule as checked, with its guidance", async () => {
    withRules([
      {
        category: "comercial",
        enabled: true,
        instructions: "Respon en to proper.",
      },
      { category: "suport", enabled: false, instructions: null },
      { category: "facturacio", enabled: false, instructions: null },
    ]);

    const markup = await render();

    expect(markup).toContain("checked");
    expect(markup).toContain("Respon en to proper.");
  });

  it("shows a rule nobody has configured as switched off", async () => {
    withRules(allOff());
    listAutoDiscardRules.mockResolvedValue(
      AUTO_DISCARD_ELIGIBLE_CATEGORIES.map((category) => ({
        category,
        enabled: false,
      })),
    );

    expect(await render()).not.toContain("checked");
  });

  it("warns that an enabled rule sends mail without approval", async () => {
    withRules();

    expect(await render()).toContain("sense revisió");
  });

  it("leads back to the dashboard", async () => {
    withRules();

    expect(await render()).toContain(`href="${DASHBOARD_PATH}"`);
  });
});

describe("AutoReplyPage — auto-discard section", () => {
  it("reads only the discard rules of the signed-in tenant", async () => {
    withDiscardRules();

    await render();

    expect(listAutoDiscardRules).toHaveBeenCalledWith(
      expect.anything(),
      TEST_TENANT_ID,
    );
  });

  it("offers a switch for every auto-discard eligible category", async () => {
    withDiscardRules();

    const markup = await render();

    for (const category of AUTO_DISCARD_ELIGIBLE_CATEGORIES) {
      expect(markup).toContain(`id="discard-enabled-${category}"`);
    }
  });

  // Urgent must never be closed out without a human looking at it — the
  // invariant this screen must never offer a way around (context.md §4).
  it.each(DISCARD_INELIGIBLE)(
    "offers no way to auto-discard %s",
    async (category) => {
      withDiscardRules();

      const markup = await render();

      expect(markup).not.toContain(`id="discard-enabled-${category}"`);
    },
  );

  it("shows newsletter checked by default, with no row configured", async () => {
    withDiscardRules();

    const markup = await render();

    const newsletterSection = markup.slice(
      markup.indexOf('id="discard-enabled-newsletter"'),
      markup.indexOf('id="discard-enabled-newsletter"') + 120,
    );
    expect(newsletterSection).toContain("checked");
  });

  it("shows a rule someone switched on for a category other than newsletter", async () => {
    withDiscardRules([
      { category: "comercial", enabled: true },
      { category: "suport", enabled: false },
      { category: "facturacio", enabled: false },
      { category: "newsletter", enabled: true },
      { category: "personal", enabled: false },
    ]);

    const markup = await render();

    const comercialSection = markup.slice(
      markup.indexOf('id="discard-enabled-comercial"'),
      markup.indexOf('id="discard-enabled-comercial"') + 120,
    );
    expect(comercialSection).toContain("checked");
  });

  it("explains that a matching thread is discarded without ever being drafted", async () => {
    withDiscardRules();

    expect(await render()).toContain("Descart automàtic");
  });
});

describe("AutoReplyPage — configuration hub", () => {
  // The page grew beyond auto-reply (auto-discard, and now notifications), so
  // it reads as one settings screen rather than a page named after its first
  // feature.
  it("titles the page as the tenant's configuration screen", async () => {
    withRules();

    expect(await render()).toContain("<h1>Configuració</h1>");
  });

  // Notification settings moved here from the dashboard home — configuration
  // belongs with the rest of the tenant's settings, not the daily-review screen.
  it("carries the urgent-notification toggle", async () => {
    withRules();

    expect(await render()).toContain("Notificacions de correu urgent");
  });
});
