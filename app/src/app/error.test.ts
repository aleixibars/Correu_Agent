// Renders the error boundary the way a failing page does: it is a Client
// Component taking the error and Next's retry callback, so the markup is
// checked and the retry control invoked directly.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_PATH } from "../lib/auth/config";
import ErrorPage from "./error";

const reset = vi.fn();

const page = (error: Error & { digest?: string } = new Error("boom")) =>
  ErrorPage({ error, reset });

const render = (error?: Error & { digest?: string }): string =>
  renderToStaticMarkup(page(error));

/** Depth-first walk for the one retry button the page renders. */
const findButton = (node: ReactNode): ReactElement | null => {
  if (!isValidElement(node)) return null;
  if (node.type === "button") return node;
  const { children } = node.props as { children?: ReactNode };
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found !== null) return found;
  }
  return null;
};

describe("ErrorPage", () => {
  it("apologises in Catalan and invites a retry", () => {
    expect(render()).toContain("Alguna cosa ha fallat");
  });

  it("wears the dashboard's visual identity", () => {
    const markup = render();

    expect(markup).toContain("app-shell");
    expect(markup).toContain("airmail-stripe");
  });

  it("offers a way back to the dashboard", () => {
    expect(render()).toContain(`href="${DASHBOARD_PATH}"`);
  });

  it("retries the failed render when the visitor asks for it", () => {
    const button = findButton(page());

    expect(button).not.toBeNull();
    (button?.props as { onClick: () => void }).onClick();
    expect(reset).toHaveBeenCalled();
  });

  // Next attaches a digest to errors thrown on the server and hides the
  // message itself, so the digest is the only handle support has on which
  // failure a visitor actually hit.
  it("shows the digest of a server-side failure", () => {
    const error = Object.assign(new Error("boom"), { digest: "a1b2c3" });

    expect(render(error)).toContain("a1b2c3");
  });

  it("shows no digest reference when the failure has none", () => {
    expect(render()).not.toContain("Referència");
  });
});
