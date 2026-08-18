// Renders the 404 page the way a request does: the component is turned into
// markup, since it takes no props and touches neither session nor database.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHBOARD_PATH } from "../lib/auth/config";
import NotFound from "./not-found";

const render = (): string => renderToStaticMarkup(NotFound());

describe("NotFound", () => {
  it("explains in Catalan that the page does not exist", () => {
    expect(render()).toContain("Aquesta pàgina no existeix");
  });

  it("wears the dashboard's visual identity", () => {
    const markup = render();

    expect(markup).toContain("app-shell");
    expect(markup).toContain("airmail-stripe");
  });

  it("offers a way back to the dashboard", () => {
    expect(render()).toContain(`href="${DASHBOARD_PATH}"`);
  });
});
