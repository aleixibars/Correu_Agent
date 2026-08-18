// Renders the login page the way a request does: the Server Component is
// awaited and the returned element turned into markup, with `../../auth`
// stubbed so no database or OAuth app is needed.

import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { TEST_TENANT_ID } from "../../lib/auth/test-fixtures";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const signIn = vi.fn();

vi.mock("../../auth", () => ({ auth, signIn }));

const { default: LoginPage } = await import("./page");

const page = async (error?: string | string[]) =>
  LoginPage({ searchParams: Promise.resolve({ error }) });

const render = async (error?: string | string[]): Promise<string> =>
  renderToStaticMarkup(await page(error));

/** The one sign-in form per provider, in the order the page lists them. */
const signInForms = async (): Promise<ReactElement[]> =>
  Children.toArray((await page()).props.children).filter(
    (child): child is ReactElement =>
      isValidElement(child) && child.type === "form",
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

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
});

describe("LoginPage", () => {
  it("offers both providers in Catalan", async () => {
    const markup = await render();

    expect(markup).toContain("Continua amb Google");
    expect(markup).toContain("Continua amb Microsoft");
  });

  it("explains a refused login in Catalan", async () => {
    expect(await render("AccessDenied")).toContain(
      "Aquest compte no té accés al tauler.",
    );
  });

  it("shows no error to a visitor who simply opened the page", async () => {
    expect(await render()).not.toContain("role=\"alert\"");
  });

  it("starts the OAuth flow for the chosen provider and returns to the dashboard", async () => {
    const [google, microsoft] = await signInForms();

    await (google.props as { action: () => Promise<void> }).action();
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/" });

    await (microsoft.props as { action: () => Promise<void> }).action();
    expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", {
      redirectTo: "/",
    });
  });

  it("sends an already signed-in visitor to the dashboard", async () => {
    signedIn();

    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
  });

  // The redirect must not fire first: the message is the only explanation a
  // visitor gets for a refused login, and the stale session cookie of the
  // provider they signed in with earlier is still on the request.
  it("still explains a refused login to a visitor with a session", async () => {
    signedIn();

    expect(await render("OAuthAccountNotLinked")).toContain(
      "Aquesta adreça ja està vinculada a",
    );
  });
});
