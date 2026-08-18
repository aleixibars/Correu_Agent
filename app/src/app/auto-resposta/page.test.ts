// Renders the auto-reply settings screen the way a request does: the Server
// Component is awaited and turned into markup, with the session and the rule
// query stubbed so no database is needed.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import {
  AUTO_REPLY_ELIGIBLE_CATEGORIES,
  TRIAGE_CATEGORIES,
} from "@correu-agent/shared";
import type { AutoReplyRuleState } from "@correu-agent/shared/auto-reply";
import { DASHBOARD_PATH } from "../../lib/auth/config";
import { CATEGORY_LABELS } from "../../lib/category-labels";
import { TEST_TENANT_ID } from "../../lib/auth/test-fixtures";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const listAutoReplyRules = vi.fn<() => Promise<AutoReplyRuleState[]>>();

vi.mock("../../auth", () => ({ auth }));
vi.mock("../../lib/db", () => ({ db: {} }));
vi.mock("@correu-agent/shared/auto-reply", () => ({ listAutoReplyRules }));
vi.mock("./actions", () => ({ saveAutoReplyRule: vi.fn() }));

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

const withRules = (rules: AutoReplyRuleState[] = allOff()): void => {
  signedIn();
  listAutoReplyRules.mockResolvedValue(rules);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  listAutoReplyRules.mockResolvedValue(allOff());
});

const INELIGIBLE = TRIAGE_CATEGORIES.filter(
  (category) => !AUTO_REPLY_ELIGIBLE_CATEGORIES.includes(category),
);

describe("AutoReplyPage", () => {
  it("sends a visitor without a session to the login page", async () => {
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(listAutoReplyRules).not.toHaveBeenCalled();
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
      expect(markup).toContain(`value="${category}"`);
    }
  });

  // The acceptance criterion of the issue: Urgent and Personal/Altres are too
  // risky to ever answer unattended (context.md §2), so the screen must not
  // carry a control that could switch them on — naming them is not enough.
  it.each(INELIGIBLE)("offers no way to switch %s on", async (category) => {
    withRules();

    const markup = await render();

    expect(markup).not.toContain(`value="${category}"`);
    // The rendered ids, so the assertion fails if a control ever appears rather
    // than passing on a shape the page never emits.
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
    withRules();

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
